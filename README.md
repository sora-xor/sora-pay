# Sora Pay

Native SORA XOR payments for static websites. Sora Pay contains an exact-arithmetic TypeScript core, a dependency-free browser widget, and a private merchant relay. It is Apache-2.0 licensed. The relay verifies finalized chain events and delivers private fulfillment messages; it never holds wallet spending keys.

## 0.1.1

The checkout widget now explains when the wallet lacks enough native XOR for the payment and network fee. Hosts can translate this message with the new `insufficientBalance` message key. Unknown wallet errors still use the generic message, and an uncertain submission still requires checking payment status before another attempt.

## Develop and package

Use Node 26 and the repository-pinned Yarn 4.10.3. Node 26 does not bundle Corepack. If `corepack` is unavailable, install it once following the [official Corepack instructions](https://github.com/nodejs/corepack#manual-installs):

```sh
npm install --global corepack
```

Then run these commands from a standalone checkout; `package.json` selects the exact Yarn version. The npm command above installs the tool only; project dependencies use the checked-in Yarn lockfile.

```sh
corepack yarn --version # Must print 4.10.3.
corepack yarn install --immutable
corepack yarn build
corepack yarn test
corepack yarn pack --out sora-pay-0.1.1.tgz
corepack yarn check:package sora-pay-0.1.1.tgz
```

The package check uses Python 3's standard library, validates the public file allowlist and required provider snapshots, and preserves the root Apache license. It rejects private files, internal reports, and nested staging README/license files. Run it before copying or publishing an archive.

`@sora/sora-pay/core` and `@sora/sora-pay/widget` are browser ESM exports. `@sora/sora-pay/relay` and `@sora/sora-pay/providers` are Node-only. The package contains compiled JavaScript/declarations, source, provider snapshots, deployment templates, documentation, examples and the license. Published consumers should pin `0.1.1`, or vendor the generated versioned archive with a recorded checksum. Never use a sibling-directory dependency in an IPFS production build. The core and widget have no runtime imports outside this package; a static server can serve their compiled ESM files directly.

Run a static server from the repository root and open `examples/basic/index.html` to try the explicitly labeled offline demonstration. Its mock adapter never connects a wallet or transfers funds. HTTPS or localhost is required for the widget's Web Locks submission guard.

For an existing-wallet integration, see the [Polkaswap adapter example](examples/polkaswap/README.md). It reproduces the actual host adapter and saved-order mounting flow, including wallet observers, exact fee/amount checks, `transaction.txId`, and relay signing-lease recovery.

## Browser integration

```ts
import { mountSoraPay } from '@sora/sora-pay/widget';
import type { WalletAdapter, PaymentRequest } from '@sora/sora-pay/core';

// Both are supplied by the integrating application, not derived from URL parameters.
declare const request: PaymentRequest; // Immutable quote already saved by the merchant relay.
declare const adapter: WalletAdapter;  // The application's existing connected-wallet integration.

const element = mountSoraPay(document.getElementById('checkout')!, {
  request,
  adapter,
  reconcile: async () => {
    // Authenticate this private order request with its recovery token in a header.
    const status = await loadOrderFromTrustedMerchant();
    return status.receipt?.evidence ?? null;
  },
});
element.addEventListener('sora-pay:submitted', event => {
  // Send the hash as a hint only. The relay independently watches finalized blocks.
  reportTransactionHint((event as CustomEvent).detail.transactionHash);
});
```

The example's `loadOrderFromTrustedMerchant` and `reportTransactionHint` are host integration functions. Their order token must never appear in the public reference, blockchain comment, query string, or analytics. Private delivery details belong only in the relay request. The complete storefront flow saves the order before mounting the payment widget.

`mountSoraPay` registers the `<sora-pay>` custom element and mounts it imperatively, requiring no Vue/React compiler customization. Alternatively call `defineSoraPayElement()` then configure an element using its `.configure(options)` method. All visible text is customizable using `messages: Partial<WidgetMessages>`; the host supplies translations. Event names are `sora-pay:state`, `sora-pay:submitted`, and `sora-pay:finalized`. Unmounting the element removes wallet observers.

## Payment and wallet contracts

`PaymentRequest` contains `version: 1`, `merchant: { id, name }`, exact `chainGenesisHash`, native XOR `assetId`, normalized `payer` and `recipient`, positive uint128 `amountCodec`, integer `decimals`, positive `denomination`, a random `sp_` plus 32 lowercase hex character `reference`, and a canonical UTC ISO `expiresAt` timestamp. The address syntax checks in the portable core **do not validate SS58 checksums**. The relay and every host adapter must checksum-validate AccountId32 addresses and normalize them to the same SS58 prefix before creating requests or comparing wallet state.

`WalletAdapter` exposes only:

- `connect()` and `getState()`, returning account, genesis hash, native asset, decimals, denomination and spendable `balanceCodec` (after locks/reserve).
- `subscribe(listener)`, observing account, chain, denomination and balance changes and returning an unsubscribe function.
- `estimateFee(request)`, returning exact XOR `amountCodec` for the same constrained transfer.
- `submit(request)`, returning a lowercase transaction hash after submission. It must recheck account, chain, recipient, native asset, amount, expiry and denomination immediately before signing.

For the current Polkaswap SDK the comment-bearing transfer is `api.assets.transfer(asset, recipient, naturalAmount, { feeType: 'xor', comment: request.reference })`, which constructs `liquidityProxy.xorlessTransfer`. The [actual adapter example](examples/polkaswap/README.md) converts with `fromCodec` and verifies `new FPNumber(amount, request.decimals).toCodecString()` equals the original amount before invoking the SDK. Do not use floating-point numbers, market price feeds, arbitrary call data, user-supplied asset IDs or a hypothetical `transferWithComment` function.

Only throw `WalletNotSubmittedError` when the adapter can prove no transaction was broadcast, such as a specifically identified pre-broadcast user cancellation. Generic transport failures, timeouts, disconnects and unknown errors are uncertain; never classify them as cancellation based only on an arbitrary error message.

The widget durably records public submission intent before asking the wallet to sign and uses Web Locks to serialize claims across tabs. Failure to access browser storage or Web Locks disables payment. It does not repeat payment after ambiguous submission, a lost hash, or reload. It first reconciles against the saved order. The browser journal stores only reference/status/transaction hash; the merchant is responsible for secure private recovery-token handling. Custom journals must implement atomic `claim`, durable `write`, `read` and safe `remove` operations.

`verifyFinalizedPayment(request, evidence)` checks the chain, native asset, payer, recipient, exact amount, reference, successful dispatch and finality fields and returns a `PaymentReceipt`. **This is a matching verifier, not a cryptographic chain client**: evidence must originate from the trusted finalized-chain reader. Never accept evidence uploaded by a browser as authoritative. The relay provides the chain reader and stores a unique `(chain, finalized block, event index)` identity to prevent consuming payment events twice. Expired requests remain verifiable so late incoming funds can be routed to review/refund without disappearing.

## Exact merchant pricing

```ts
import { toCodec } from '@sora/sora-pay/core';

// The Polkaswap merchant catalog keeps this exact unit price until explicitly repriced.
const unitXor = '1.759225';
const unitCodec = toCodec(unitXor, 18); // '1759225000000000000'
```

The Polkaswap store uses `pricing.kind: exact-xor`: **1.759225 XOR per bag**, with separate fixed XOR shipping bands. These amounts remain unchanged until the merchant explicitly publishes a new catalog version. The one-time calculation `ceil(1500 / 158.78 / 5.37 * 1e6) / 1e6` is internal launch audit information; the public catalog exposes only `{kind: 'exact-xor', version}` for pricing policy. Neither fiat values nor exchange rates appear in the storefront. Japan Post availability refreshes can remove unsupported destinations but cannot change saved XOR tariffs.

Other merchants may use the generic `convertJpyToXor` helper, a fixed USD/XOR credit, and `pricing.kind: jpy-fixed-usd` with `mode: launch-fixed` or the optional daily MUFG provider. Polkaswap does not use runtime MUFG repricing. Each saved order's amount remains immutable. No amount helper fetches market XOR prices. `toCodec` rejects precision loss and uint128 overflow; `fromCodec` produces an exact decimal string. A denomination snapshot change invalidates the old quote instead of silently rescaling the amount being signed. See [official FX and EMS provider documentation](docs/providers.md) for freshness, provenance and unavailable destinations.

## Private merchant relay

The Node 26 relay uses SQLite, encrypted private order records, authenticated order recovery and operator actions, finalized-chain scanning, and a durable delivery outbox. See the [relay operator runbook](docs/relay.md) and [disabled configuration template](deploy/merchant.disabled.json.example) for environment names and the startup command. SQLite files, encryption keys, authentication tokens, notification credentials and backups must stay outside any public/IPFS build.

Verify the merchant wallet, operator/support details, shipping destinations and fixed XOR tariffs, fulfillment capacity, and private Telegram/email notification destination before enabling checkout. The Polkaswap store is operated by **Community Volunteers**, with public support only through [@sora_xor](https://t.me/sora_xor); its samples omit public support email and have the public recipient and fixed catalog prefilled but remain disabled. Other merchants may provide an optional public email, Telegram handle, or both; at least one valid support contact is required before enabling checkout. Public support never selects the private notification destination. Until private operational configuration is complete and the watcher is healthy, the store stays in browsing mode. The toolkit ships no private notification destination, credentials, or spending key.

The [disabled Polkaswap configuration](deploy/merchant.polkaswap.json.example) keeps `wss://ws.mof.sora.org` as its primary RPC and explicitly selects the existing approved OVH archive at `wss://mof2.sora.org` for unavailable historical state. The primary remains authoritative for finality and canonical block hashes; archive responses must match its chain and block identity. A September 25, 2026 read-only probe verified historical event decoding 1,024 blocks behind the primary finalized head, beyond its 256-block state window. This does not enable payments or replace the paid-order/refund rehearsal. Generic merchant templates have no default archive endpoint; see the [archive recovery guidance](docs/relay.md).

The merchant's order state is authoritative for fulfillment and refunds. A successful wallet callback is only submission. A notification outage must not discard an accepted order. The relay notifies a private volunteer destination automatically; assigned volunteers acknowledge orders and send tracking to the supplied customer contact. Telegram support handles are not bot chat identifiers. Refunds are separately approved obligations paid manually from the group wallet, protected by durable signing-attempt leases, and marked complete only after verified outgoing finalized evidence. The full originally received XOR, including shipping, is owed when fulfillment is impossible; the store bears its refund network fee.

## Validation

Offline unit tests cover exact launch pricing, invalid/overflowing amounts, account/network/denomination changes, fee changes, insufficient balance, canceled signing, uncertain submission recovery, duplicate concurrent payment attempts and finalized evidence mismatch. Relay tests additionally cover persistence, inventory, matching, fulfillment and refund behavior. No tests require spending keys, live wallets or external services. Browser smoke verification should exercise the static example in both Chromium and WebKit, including a narrow mobile viewport.
