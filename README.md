# Sora Pay

Native SORA XOR payments for static websites. Sora Pay contains an exact-arithmetic TypeScript core, a dependency-free browser widget, and a private merchant relay. It is Apache-2.0 licensed. The relay verifies finalized chain events and delivers private fulfillment messages; it never holds wallet spending keys.

## 0.2.5

The toolkit contains reusable payment interfaces, a browser widget, the private relay, optional data providers and neutral deployment examples. Merchant catalogs, destination rules, fulfillment runbooks and host-specific deployment records belong in the integrating application's repository. Staging requires an explicit merchant configuration; pricing conversion requires an explicit merchant-selected USD/XOR rate.

Storage admission thresholds are merchant configuration. Optional `storageResumeFreeBytes` sets the startup/reset reserve and must be at least `storageMinimumFreeBytes`; omission uses the configured minimum. When migrating an installation that relied on the former implicit 10 GiB startup/reset floor, set `storageResumeFreeBytes` to `"10737418240"` explicitly (or the existing minimum if higher) before adopting 0.2.5. Saved pauses still require an authenticated reset.

## 0.2.4

The merchant relay now refreshes Japan Post availability by the configured service: EMS, air/surface parcels and air/surface small packets. Restricted routes require an explicit review bound to the carrier snapshot; a changed restriction closes the route until reviewed. Exact-XOR catalog amounts remain frozen. Domestic Japan can use separately priced Letter Pack Plus envelopes.

The browser/payment/receipt contract is unchanged, so existing 0.2.2 storefront bundles remain compatible. Merchants maintain their own route approvals and dispatch requirements outside the provider library.

## 0.2.2

An authenticated operator can reconcile a refund sent through a wallet's regular native XOR transfer. The relay independently reads the finalized transaction, checks it against the existing refund and signing attempt, and consumes its transfer event once. The receipt preserves the missing on-chain reference as `null` and records the separate operator binding; ordinary payments still require their exact reference. Reconciliation does not send another transfer or change the customer's saved refund terms.

Browser integrations should use `verifyFinalizedRefund(expectedRequest, receipt)` for refund receipts. It accepts both ordinary referenced receipts and the explicit manual-transfer receipt while checking the entire expected payment request.

## 0.2.1

An operator can record a customer's explicit fixed deduction for one pending, unsigned refund. The original order policy and prior obligation stay in the encrypted audit. The agreed deduction is separate from the actual network fee, applies only to that refund, and settles only after the exact return transfer finalizes. Customer receipts must show the agreed deduction without presenting it as a measured chain fee.

The relay also includes destination approval controls, frozen shipping-band restrictions, and the persistent storage admission guard introduced after the original 0.2.0 archive. Existing payment recovery and refund processing remain available when new checkout is paused.

## 0.2.0

New orders can deduct the verified outbound SORA network fee from a refund. Existing orders keep their saved terms; any overestimated deduction is returned without another customer fee.

Relay integrations must handle an unquoted refund draft without `amountCodec`. The gross amount and saved policy are available immediately; only an authoritative fee quote enables a net refund signing attempt.

The restore command loads only its local backup dependencies. RPC, HTTP, catalog and notification modules are loaded only when serving the relay, reducing restore startup work without changing encryption, key validation or overwrite protection.

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
corepack yarn pack --out sora-pay-0.2.5.tgz
corepack yarn check:package sora-pay-0.2.5.tgz
```

The package check uses Python 3's standard library, validates the public file allowlist and required provider snapshots, and preserves the root Apache license. It rejects private files, internal reports, and nested staging README/license files. Run it before copying or publishing an archive.

`@sora/sora-pay/core` and `@sora/sora-pay/widget` are browser ESM exports. `@sora/sora-pay/relay` and `@sora/sora-pay/providers` are Node-only. The package contains compiled JavaScript/declarations, source, provider snapshots, deployment templates, documentation, examples and the license. Published consumers should pin `0.2.5`, or vendor the generated versioned archive with a recorded checksum. Never use a sibling-directory dependency in an IPFS production build. The core and widget have no runtime imports outside this package; a static server can serve their compiled ESM files directly.

Run a static server from the repository root and open `examples/basic/index.html` to try the explicitly labeled offline demonstration. Its mock adapter never connects a wallet or transfers funds. HTTPS or localhost is required for the widget's Web Locks submission guard.

For an existing-wallet integration, see the [Polkaswap adapter example](examples/polkaswap/README.md). It illustrates the host adapter and saved-order mounting flow, including wallet observers, exact fee/amount checks, `transaction.txId`, and relay signing-lease recovery.

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

For the current Polkaswap SDK the comment-bearing transfer is `api.assets.transfer(asset, recipient, naturalAmount, { feeType: 'xor', comment: request.reference })`, which constructs `liquidityProxy.xorlessTransfer`. The [adapter example](examples/polkaswap/README.md) converts with `fromCodec` and verifies `new FPNumber(amount, request.decimals).toCodecString()` equals the original amount before invoking the SDK. Do not use floating-point numbers, market price feeds, arbitrary call data, user-supplied asset IDs or a hypothetical `transferWithComment` function.

Only throw `WalletNotSubmittedError` when the adapter can prove no transaction was broadcast, such as a specifically identified pre-broadcast user cancellation. Generic transport failures, timeouts, disconnects and unknown errors are uncertain; never classify them as cancellation based only on an arbitrary error message.

The widget durably records public submission intent before asking the wallet to sign and uses Web Locks to serialize claims across tabs. Failure to access browser storage or Web Locks disables payment. It does not repeat payment after ambiguous submission, a lost hash, or reload. It first reconciles against the saved order. The browser journal stores only reference/status/transaction hash; the merchant is responsible for secure private recovery-token handling. Custom journals must implement atomic `claim`, durable `write`, `read` and safe `remove` operations.

`verifyFinalizedPayment(request, evidence)` checks the chain, native asset, payer, recipient, exact amount, reference, successful dispatch and finality fields and returns a `PaymentReceipt`. **This is a matching verifier, not a cryptographic chain client**: evidence must originate from the trusted finalized-chain reader. Never accept evidence uploaded by a browser as authoritative. The relay provides the chain reader and stores a unique `(chain, finalized block, event index)` identity to prevent consuming payment events twice. Expired requests remain verifiable so late incoming funds can be routed to review/refund without disappearing.

## Exact merchant pricing

```ts
import { toCodec } from '@sora/sora-pay/core';

// Illustrative merchant-selected amount, independent of the widget.
const unitXor = '2.5';
const unitCodec = toCodec(unitXor, 18); // '2500000000000000000'
```

Use `pricing.kind: exact-xor` to publish exact product and shipping amounts. They remain fixed until the merchant changes the catalog and advances `pricing.version`. Public pricing metadata is `{kind: 'exact-xor', version}`; internal conversion inputs are not exposed. Availability refreshes may remove unavailable destinations without changing published XOR tariffs or saved order amounts.

For fiat-referenced pricing, the optional `convertJpyToXor` helper and `pricing.kind: jpy-fixed-usd` require an explicit merchant-selected `usdPerXor`. Choose `mode: launch-fixed` or the optional daily MUFG provider. Neither the widget nor the helpers choose a merchant credit rate or fetch a market XOR price. Persist the source snapshot and price version separately from the customer's immutable payment request.

`toCodec` rejects precision loss and uint128 overflow; `fromCodec` produces an exact decimal string. A denomination snapshot change invalidates the old quote instead of silently rescaling the amount being signed. See [provider documentation](docs/providers.md) for conversion, freshness and shipping availability.

## Private merchant relay

The Node 26 relay uses SQLite, encrypted private order records, authenticated order recovery and operator actions, finalized-chain scanning, and a durable delivery outbox. See the [relay operator runbook](docs/relay.md) and [disabled configuration template](deploy/merchant.disabled.json.example) for environment names and the startup command. SQLite files, encryption keys, authentication tokens, notification credentials and backups must stay outside any public/IPFS build.

Configure the recipient, chain, operator identity, public support, catalog, shipping rules and private Telegram/email destination before enabling checkout. An enabled merchant must provide a valid public email, Telegram handle, or both. Public support never selects the private notification destination. The neutral template is disabled and contains no live merchant recipient, host or catalog. The toolkit ships no private notification credentials or wallet spending key.

Select primary and, where needed, archive RPC endpoints explicitly. The primary is authoritative for finality and canonical block hashes; archive responses must match its chain and block identity. Missing history pauses new checkout without advancing the saved scan cursor. See [archive recovery guidance](docs/relay.md#configuration-and-startup).

The merchant's saved order is authoritative for fulfillment and refunds. A wallet callback proves submission only. Payment acceptance and notification work are persisted atomically; delivery failures are retried without discarding the order. Operators assign fulfillment and send acknowledgment/tracking through the customer's chosen contact method.

Refunds are approved obligations signed with the merchant wallet, protected by durable signing-attempt leases, and settled only from finalized outgoing evidence. The relay supports full refunds and refunds net of the verified outbound network fee. Each order saves its policy version; historical orders without a snapshot keep full-refund terms. Overestimated network deductions remain owed as fee-exempt corrections. See the [refund accounting procedure](docs/relay.md#refund-accounting).

## Validation

Offline unit tests cover exact launch pricing, invalid/overflowing amounts, account/network/denomination changes, fee changes, insufficient balance, canceled signing, uncertain submission recovery, duplicate concurrent payment attempts and finalized evidence mismatch. Relay tests additionally cover persistence, inventory, matching, fulfillment and refund behavior. No tests require spending keys, live wallets or external services. Browser smoke verification should exercise the static example in both Chromium and WebKit, including a narrow mobile viewport.
