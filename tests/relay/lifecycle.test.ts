import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeAddress } from '@polkadot/util-crypto';
import { ArchiveRequiredError, awaitWithAbort, createRelayLifecycle, deliverNext, NATIVE_XOR, OrderStore, scanFinalized, validateConfig } from '../../dist/relay/index.js';
import type { ChainReader, FinalizedBlock, MerchantConfig } from '../../dist/relay/index.js';

const payer = encodeAddress(new Uint8Array(32).fill(1), 69);
const recipient = encodeAddress(new Uint8Array(32).fill(2), 69);
const epoch = Date.parse('2026-09-25T00:00:00.000Z');

/** Deterministic in-memory merchant; this test never contacts a chain or notification service. */
function config(): MerchantConfig {
  return validateConfig({
    enabled: true, fulfillmentMode: 'on-demand', version: 'retention-test',
    merchant: { id: 'test', name: 'Test', supportEmail: 'support@example.test', operatorName: 'Test', dispatchPolicy: 'Review before shipping', customsPolicy: 'Customer pays customs', privacyPolicy: '30 days', cancellationPolicy: 'Full XOR refund' },
    pricing: { kind: 'exact-xor', version: 'fixed', jpyPerUsd: '', usdPerXor: '', fxSource: '', fxDate: '' },
    product: { id: 'tea', name: 'Sencha', grams: 100, packedGrams: 120, priceXor: '1.759225' },
    shipping: [{ id: 'jp-500', countries: ['JP'], maxGrams: 500, priceXor: '1', label: 'Test', reviewedAt: '2026-09-25' }],
    chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, decimals: 18, denomination: '1', recipient, rpcUrl: 'wss://example.test', startBlock: 100 },
    allowedOrigins: ['https://example.test'], retentionDays: 30,
  });
}

test('archive outage still removes due customer PII and runs durable notification work', async () => {
  let now = epoch;
  const store = new OrderStore(':memory:', config(), Buffer.alloc(32, 7), () => now);
  try {
    const input = () => ({ productId: 'tea', quantity: 1, shippingRateId: 'jp-500', payer, idempotencyKey: randomUUID(), address: { name: 'Private Name', line1: 'Private Street', city: 'Tokyo', postalCode: '100-0000', country: 'JP' }, contact: { type: 'email' as const, value: 'private@example.test' } });
    const abandoned = store.create(input());
    const shipped = store.create(input());
    const request = shipped.paymentRequest;
    assert.equal(store.accept({ chainGenesisHash: request.chainGenesisHash, assetId: request.assetId, payer, recipient, amountCodec: request.amountCodec, reference: request.reference, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(epoch).toISOString() }), true);
    store.claim(shipped.orderId, 'volunteer');
    store.ship(shipped.orderId, 'volunteer', 'TEST-TRACKING', true);
    now += 31 * 86_400_000;
    const failures: string[] = [];
    let delivered = 0;
    const lifecycle = createRelayLifecycle({
      async reconcile() { throw new ArchiveRequiredError(); },
      purge: () => store.purgePersonalData(),
      notify: () => deliverNext(store, { async send(job) { delivered++; assert.equal(job.order.address.name, ''); assert.equal(job.order.contact.value, ''); } }),
    }, (stage) => { failures.push(stage); });
    await lifecycle.tick();
    await lifecycle.stop();
    assert.deepEqual(failures, ['reconcile']);
    assert.equal(delivered, 1);
    for (const id of [abandoned.orderId, shipped.orderId]) {
      assert.equal(store.operatorOrder(id).address.name, '');
      assert.equal(store.operatorOrder(id).contact.value, '');
    }
    assert.equal(store.get(abandoned.orderId, abandoned.recoveryToken).status, 'expired');
    assert.equal(store.get(shipped.orderId, shipped.recoveryToken).status, 'shipped');
  } finally { store.close(); }
});

test('retention errors cannot skip outbox work and each service failure is classified safely', async () => {
  const failures: string[] = [];
  let attempts = 0;
  const lifecycle = createRelayLifecycle({
    async reconcile() { throw new Error('RPC unavailable'); },
    purge() { throw new Error('Storage unavailable'); },
    async notify() { attempts++; throw new Error('Delivery unavailable'); },
  }, (stage) => { failures.push(stage); });
  await lifecycle.tick();
  await lifecycle.stop();
  assert.equal(attempts, 1);
  assert.deepEqual(failures.sort(), ['notification', 'reconcile', 'retention']);
});

/** Manually controlled promises avoid timer races and external RPC dependencies. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('pending connection cannot block repeated maintenance or create overlapping workers', async () => {
  const connection = deferred<void>();
  const notification = deferred<void>();
  const failures: string[] = [];
  let scans = 0; let purges = 0; let sends = 0; let reconciled = 0;
  const lifecycle = createRelayLifecycle({
    async reconcile(signal) { scans++; await awaitWithAbort(connection.promise, signal); reconciled++; },
    purge() { purges++; },
    async notify() { sends++; if (sends === 1) await notification.promise; },
  }, (stage) => { failures.push(stage); });
  const first = lifecycle.tick(); const concurrent = lifecycle.tick();
  await Promise.resolve();
  assert.equal(scans, 1); assert.equal(purges, 1); assert.equal(sends, 1);
  notification.resolve(); await Promise.all([first, concurrent]);
  await lifecycle.tick(); await lifecycle.tick();
  assert.equal(scans, 1); assert.equal(purges, 3); assert.equal(sends, 3);
  await lifecycle.stop();
  connection.resolve(); await Promise.resolve(); await lifecycle.tick();
  assert.equal(reconciled, 0); assert.equal(purges, 3); assert.equal(sends, 3);
  assert.deepEqual(failures, []);
});

test('shutdown drains notification work and prevents a late block from advancing the durable cursor', async () => {
  const pendingBlock = deferred<FinalizedBlock>();
  const requestedBlock = deferred<void>();
  const notification = deferred<void>();
  let cursor = 100; let accepted = 0; let stopped = false;
  const store = { cursor(next?: number) { if (next !== undefined) cursor = next; return cursor; }, accept() { accepted++; } } as unknown as OrderStore;
  const chain = { async head() { return 100; }, async block() { requestedBlock.resolve(); return pendingBlock.promise; }, async assertConfiguration() {}, async close() {} } satisfies ChainReader;
  const lifecycle = createRelayLifecycle({
    async reconcile(signal) { await scanFinalized(store, chain, 100, signal); },
    purge() {},
    notify: () => notification.promise,
  }, () => { throw new Error('Shutdown must not be reported as a retryable service failure'); });
  const tick = lifecycle.tick(); await requestedBlock.promise;
  const stopping = lifecycle.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  notification.resolve(); await stopping; await tick;
  assert.equal(stopped, true);
  pendingBlock.resolve({ number: 100, transfers: [] }); await Promise.resolve(); await Promise.resolve();
  assert.equal(cursor, 100); assert.equal(accepted, 0);
});
