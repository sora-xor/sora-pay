# Polkaswap wallet adapter integration reference

This example reproduces the actual host adapter and saved-order mounting flow implemented in [Polkaswap](https://github.com/sora-xor/polkaswap-exchange-web) alongside Sora Pay 0.1.0. The source paths are `src/features/store/walletAdapter.ts` and `src/features/store/useCommunityStore.ts` in that repository. The excerpts were checked against those files on September 25, 2026.

These TypeScript excerpts run inside Polkaswap, which provides Vue, the existing wallet SDK, `FPNumber`, chain configuration, and authenticated private-order transport. They are a host integration reference, not a second standalone wallet implementation or a script to paste into the plain HTML demo. `@/` refers to Polkaswap's `src/` directory. Sora Pay receives a narrow `WalletAdapter`; it never receives spending keys or an arbitrary signing callback.

## Host bindings and payment authority

`useInternalConnect()` provides `soraAddress`, `isLoggedIn`, and `connectSoraWallet`. `useTransaction().withNotifications` unlocks the existing wallet and reports its `TransactionNotificationResult`; `transaction.txId` is the submitted transaction hash. The merchant creates and privately saves an order first, then returns a validated `PaymentRequest` plus a separate recovery token. The host checks the recipient, merchant, mainnet genesis, native XOR asset, exact quoted amount, and denomination before mounting.

The host's `storeRequest` sends private tokens in the `Authorization` header, uses only the release-configured relay URL, and never places a token or customer address in a URL. The order's random public reference is the only checkout information included in the transfer comment. The product price, shipping policy, operator identity, and fixed 1.759225 XOR tea price remain merchant policy; none belongs in the generic widget or adapter interface.

## Actual wallet adapter

`getState()` checksum-validates and normalizes accounts, pins the SORA mainnet genesis, fetches current denomination/precision/spendable balance, and checks again after asynchronous reads. The account and network observer invalidates cached intent; every fee estimate and submission reads fresh state as well. Fees come from `paymentInfo` for the same constrained `liquidityProxy.xorlessTransfer` call. The signer path converts codec units to an exact decimal string and requires an exact `FPNumber` round trip. It does not multiply the amount by the denomination snapshot.

```ts
import {
  assertWalletMatches,
  fromCodec,
  type PaymentRequest,
  type WalletAdapter,
  type WalletState,
} from '@sora/sora-pay/core';
import { WalletNotSubmittedError } from '@sora/sora-pay/widget';
import { FPNumber } from '@/lib/substrate/math';
import { watch } from 'vue';

import { api } from '@/lib/soraneo-wallet/src/api';
import { getAssetBalance } from '@/lib/substrate/sdk/assets';
import { XOR } from '@/lib/substrate/sdk/assets/consts';
import type { TransactionNotificationResult } from '@/composables/useTransaction';

import { canonicalStoreAddress, STORE_MAINNET_GENESIS } from './client';

/** Host-controlled signing and durable relay lease hooks; no keys enter Sora Pay. */
export interface StoreWalletHooks {
  address(): string;
  connected(): boolean;
  connect(): Promise<void>;
  withNotifications(handler: () => Promise<void>): Promise<TransactionNotificationResult>;
  beginAttempt(): Promise<string>;
  cancelAttempt(token: string): Promise<void>;
  reportTransaction(hash: string, token: string): Promise<void>;
  onPending(): void;
}

/** Build only the native-XOR/comment transfer used by the existing wallet SDK. */
function paymentExtrinsic(request: PaymentRequest) {
  return api.connection.api.tx.liquidityProxy.xorlessTransfer(
    0,
    XOR.address,
    request.recipient,
    request.amountCodec,
    0,
    0,
    [],
    'Disabled',
    request.reference
  );
}

/** Adapter checks current native chain values again after unlock and before submission. */
export function createStoreWalletAdapter(hooks: StoreWalletHooks): WalletAdapter {
  /** Read fresh spendable funds and chain denomination, guarding asynchronous account switches. */
  async function getState(): Promise<WalletState> {
    const empty: WalletState = {
      account: null,
      chainGenesisHash: null,
      assetId: null,
      decimals: null,
      denomination: null,
    };
    const chain = api.connection?.api;
    const address = hooks.address();
    if (!hooks.connected() || !address || !chain?.isConnected) return empty;
    const account = canonicalStoreAddress(address);
    if (canonicalStoreAddress(api.account?.pair?.address ?? '') !== account)
      throw new WalletNotSubmittedError('wallet_account_changed');
    const genesis = chain.genesisHash.toString().toLowerCase();
    if (genesis !== STORE_MAINNET_GENESIS) throw new WalletNotSubmittedError('wallet_network_changed');
    const [denomination, assetInfo, balance] = await Promise.all([
      chain.query.denomination.denominator(),
      chain.query.assets.assetInfosV2({ code: XOR.address }),
      getAssetBalance(chain, address, XOR.address, XOR.decimals),
    ]);
    if (
      chain !== api.connection?.api ||
      !chain.isConnected ||
      !hooks.connected() ||
      canonicalStoreAddress(hooks.address()) !== account ||
      canonicalStoreAddress(api.account?.pair?.address ?? '') !== account
    )
      throw new WalletNotSubmittedError('wallet_account_changed');
    const decimals = Number((assetInfo as unknown as { precision: { toString(): string } }).precision.toString());
    const existential = BigInt(chain.consts.balances?.existentialDeposit?.toString() ?? '0');
    const balanceCodec = BigInt(balance.transferable);
    return {
      account,
      chainGenesisHash: genesis,
      assetId: XOR.address,
      decimals,
      denomination: denomination.toString(),
      balanceCodec: (balanceCodec > existential ? balanceCodec - existential : 0n).toString(),
    };
  }

  /** Estimate the actual constrained call; zero/unavailable fee is not considered safe. */
  async function estimateFee(request: PaymentRequest): Promise<{ amountCodec: string }> {
    assertWalletMatches(request, await getState());
    const fee = await paymentExtrinsic(request).paymentInfo(request.payer);
    const amountCodec = fee.partialFee.toString();
    if (!/^[1-9]\d*$/.test(amountCodec)) throw new WalletNotSubmittedError('fee_unavailable');
    assertWalletMatches(request, await getState(), Date.now(), amountCodec);
    return { amountCodec };
  }

  return {
    getState,
    async connect() {
      if (!hooks.connected()) await hooks.connect();
      return getState();
    },
    subscribe(listener) {
      let active = true;
      const stop = watch(
        () => [hooks.address(), hooks.connected(), api.connection?.api, api.connection?.api?.genesisHash?.toString()],
        () => {
          void getState()
            .then((state) => {
              if (active) listener(state);
            })
            .catch(() => {
              if (active)
                listener({ account: null, chainGenesisHash: null, assetId: null, decimals: null, denomination: null });
            });
        }
      );
      return () => {
        active = false;
        stop();
      };
    },
    estimateFee,
    async submit(request) {
      const intent = structuredClone(request);
      const fee = await estimateFee(intent);
      assertWalletMatches(intent, await getState(), Date.now(), fee.amountCodec);
      const attempt = await hooks.beginAttempt();
      let invoked = false;
      let result: TransactionNotificationResult;
      try {
        result = await hooks.withNotifications(async () => {
          const finalFee = await estimateFee(intent);
          assertWalletMatches(intent, await getState(), Date.now(), finalFee.amountCodec);
          if (finalFee.amountCodec !== fee.amountCodec) throw new WalletNotSubmittedError('fee_changed');
          const amount = fromCodec(intent.amountCodec, intent.decimals);
          // Ensure the vendored SDK's FPNumber path signs exactly the reviewed codec units.
          if (new FPNumber(amount, intent.decimals).toCodecString() !== intent.amountCodec)
            throw new WalletNotSubmittedError('amount_precision_loss');
          invoked = true;
          await api.assets.transfer(XOR, intent.recipient, amount, { feeType: 'xor', comment: intent.reference });
        });
      } catch (error) {
        result = { submitted: false, error };
      }
      if (!result.submitted && !invoked) {
        // A failed release remains safely locked at the relay and must not look ready to pay.
        await hooks.cancelAttempt(attempt);
        throw new WalletNotSubmittedError('payment_not_submitted');
      }
      hooks.onPending();
      const hash = result.transaction?.txId;
      if (typeof hash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(hash)) {
        const transactionHash = hash.toLowerCase();
        try {
          await hooks.reportTransaction(transactionHash, attempt);
        } catch {
          /* The durable chain watcher also discovers the reference. */
        }
        return { transactionHash };
      }
      // The relay watches the reference independently, including after a lost SDK response.
      throw new Error('payment_submission_uncertain');
    },
  };
}
```

## Actual saved-order mounting flow

This method lives inside `useCommunityStore()`. `order`, `walletAddress`, and `isConnected` are its reactive state; `endpoint` resolves only the configured merchant relay. `refreshOrder` authenticates with the saved recovery token and validates finalized receipt evidence. `schedulePoll` continues private status recovery after submission. `t` maps every widget message to Polkaswap's locale catalogs. The returned cleanup function is called when the payment container is removed.

The signing lease is scoped to the already saved order: the relay atomically grants one `attemptToken`. A second tab cannot acquire another lease. The token is owned by this host adapter and used to release only a proven unsubmitted attempt; customers do not authorize payment by submitting transaction hints. The server may discover finality even if the browser closes before reporting a hash.

```ts
/** Mount the independently packaged widget after durable order creation. */
async function createPayment(container: HTMLElement): Promise<() => void> {
  const saved = order.value;
  if (!saved || saved.status !== 'awaiting_payment' || disposed) throw new StoreClientError('payment_unavailable');
  const widget = await import('@sora/sora-pay/widget');
  if (disposed || order.value?.orderId !== saved.orderId) throw new StoreClientError('order_changed');
  const base = `orders/${encodeURIComponent(saved.orderId)}`;
  const adapter = createStoreWalletAdapter({
    address: () => walletAddress.value,
    connected: () => isConnected.value,
    connect: connectSoraWallet,
    withNotifications,
    async beginAttempt() {
      const response = (await storeRequest(endpoint(`${base}/payment-attempt`), {}, saved.recoveryToken)) as {
        attemptToken?: unknown;
      };
      if (typeof response.attemptToken !== 'string') throw new StoreClientError('invalid_attempt');
      return response.attemptToken;
    },
    async cancelAttempt(attemptToken) {
      await storeRequest(endpoint(`${base}/payment-attempt/cancel`), { attemptToken }, saved.recoveryToken);
    },
    async reportTransaction(transactionHash, attemptToken) {
      await storeRequest(endpoint(`${base}/transaction`), { transactionHash, attemptToken }, saved.recoveryToken);
    },
    onPending() {
      if (order.value?.orderId === saved.orderId) {
        order.value = { ...order.value, status: 'payment_pending' };
        schedulePoll();
      }
    },
  });
  const messages = Object.fromEntries(
    Object.keys(widget.DEFAULT_MESSAGES).map((key) => [key, t(`communityStore.widget.${key}`)])
  );
  const element = widget.mountSoraPay(container, {
    request: saved.paymentRequest,
    adapter,
    messages,
    async reconcile() {
      await refreshOrder(false);
      return order.value?.orderId === saved.orderId ? (order.value.receipt?.evidence ?? null) : null;
    },
  });
  return () => {
    element.controller?.dispose();
    element.remove();
  };
}
```

## Submission, errors, and recovery

| Outcome | Host and relay behavior |
| --- | --- |
| Wallet connection or account/network/denomination validation fails before transfer invocation | No transfer is submitted. If a lease was acquired, release it successfully before reporting `WalletNotSubmittedError`. |
| Fee changes after unlocking | Reject before invoking the SDK; obtain a new reviewed fee on the next explicit Pay action. |
| The SDK transfer function has been invoked, but the result is an error, disconnect, or lost hash | Retain the signing lease and show pending/uncertain status. Arbitrary cancellation text does not prove that no transaction was broadcast. Never automatically resubmit. |
| `transaction.txId` is available | Report the normalized hash as a hint and return submitted status. Failure to report it does not lose the order: the relay watches finalized transfer references independently. |
| Trusted relay returns matching finalized evidence | The generic verifier checks chain, asset, actual payer, recipient, amount, reference, successful dispatch and finalized block evidence before the widget reports finalized. |
| Relay or private status lookup is unavailable | Preserve the receipt/recovery capability. New signing requires a healthy relay lease endpoint; never infer settlement from browser state. |

The browser widget also persists its public signing journal before calling `submit` and serializes local claims with Web Locks. A failed relay lease release remains locked for reconciliation; a local UI reset must not override either guard. Order recovery tokens and relay attempt tokens are separate capabilities. The relay retains a submitted/uncertain lease until verified reconciliation; it does not ask the customer to pay again merely because a message failed.

The host validation suites are `tests/unit/features/store/walletAdapter.spec.ts`, `client.spec.ts`, and `useCommunityStore.spec.ts` in Polkaswap. They cover exact transfer amount/reference, wallet changes during unlock, fee reserves, ambiguous errors, observer cleanup, durable order creation, and authenticated recovery. The toolkit's independent controller tests cover cross-tab journal claims, expiry, lost callbacks, and receipt evidence mismatch. All of these tests use mocks. A real supported-mobile-wallet purchase/refund rehearsal remains an operator launch check.
