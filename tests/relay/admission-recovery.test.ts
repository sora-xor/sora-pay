import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FinalizedTransferEvidence } from '../../dist/core/index.js';
import { OrderStore, createRelayServer, validateConfig, NATIVE_XOR } from '../../dist/relay/index.js';

const payer = 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA';
const recipient = 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C';
const operatorToken = 'o'.repeat(64);
const now = Date.parse('2026-09-26T00:00:00.000Z');

/** Synthetic capabilities, addresses and in-memory data; the only HTTP listener is ephemeral loopback. */
async function fixture() {
  const config = validateConfig({
    enabled: true, fulfillmentMode: 'on-demand', version: 'admission-test',
    merchant: { id: 'test', name: 'Test', operatorName: 'Test', supportTelegram: 'sora_xor', dispatchPolicy: 'Test', customsPolicy: 'Test', privacyPolicy: 'Test', cancellationPolicy: 'Test' },
    pricing: { kind: 'exact-xor', version: 'test', jpyPerUsd: '', usdPerXor: '', fxSource: '', fxDate: '' },
    product: { id: 'tea', name: 'Tea', grams: 100, packedGrams: 120, priceXor: '1' },
    shipping: [{ id: 'jp', countries: ['JP'], maxGrams: 500, priceXor: '0', label: 'Test', reviewedAt: '2026-09-26' }],
    chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, decimals: 18, denomination: '1', recipient, rpcUrl: 'wss://example.test', startBlock: 100 },
    allowedOrigins: ['https://polkaswap.io'], retentionDays: 30,
  });
  const store = new OrderStore(':memory:', config, Buffer.alloc(32, 7), () => now);
  const input = () => ({ productId: 'tea', quantity: 1, shippingRateId: 'jp', payer, idempotencyKey: randomUUID(), address: { name: 'Synthetic Customer', line1: 'Synthetic Delivery Street', city: 'Synthetic', country: 'JP' }, contact: { type: 'telegram' as const, value: '@synthetic' } });
  const cancelInput = input();
  const cancelOrder = store.create(cancelInput);
  const cancelLease = store.paymentAttempt(cancelOrder.orderId, cancelOrder.recoveryToken);
  const hintedOrder = store.create(input());
  const hintedLease = store.paymentAttempt(hintedOrder.orderId, hintedOrder.recoveryToken);
  const paidOrder = store.create(input());
  const finalized = (order: typeof paidOrder, eventIndex: number): FinalizedTransferEvidence => ({
    ...order.paymentRequest, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`,
    blockNumber: '100', eventIndex, successful: true, finalized: true, finalizedAt: new Date(now).toISOString(),
  });
  const paidEvidence = finalized(paidOrder, 1);
  store.accept(paidEvidence);
  const server = createRelayServer(store, { operatorToken, ready: () => false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'https://polkaswap.io', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    store, input, cancelInput, cancelOrder, cancelLease, hintedOrder, hintedLease, paidOrder, paidEvidence, finalized, request,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); },
  };
}

test('readiness pause blocks new admission but preserves capability recovery and explicit prebroadcast cancellation', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.request('/healthz'), { status: 200, body: { ready: false, configured: true } });
    assert.equal((await f.request('/v1/catalog')).body.enabled, false);
    assert.equal((await f.request('/v1/orders', f.input())).status, 503);
    const path = `/v1/orders/${f.cancelOrder.orderId}`;
    const token = f.cancelOrder.recoveryToken;
    assert.equal((await f.request(path + '/payment-attempt', {}, token)).status, 503);
    assert.equal(f.store.list().length, 3);
    const recovered = await f.request('/v1/orders/recover-create', { idempotencyKey: f.cancelInput.idempotencyKey });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.orderId, f.cancelOrder.orderId);
    assert.equal(recovered.body.recoveryToken, token);
    assert.equal(recovered.body.paymentPending, true);
    assert.equal((await f.request('/v1/orders/recover-create', { idempotencyKey: randomUUID() })).status, 404);
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, undefined, 'wrong')).status, 404);
    assert.equal((await f.request(path + '/payment-attempt/cancel', { attemptToken: f.cancelLease.attemptToken }, 'wrong')).status, 404);
    assert.equal(f.store.get(f.cancelOrder.orderId, token).paymentPending, true);
    assert.deepEqual(await f.request(path + '/payment-attempt/cancel', { attemptToken: f.cancelLease.attemptToken }, token), { status: 200, body: { canceled: true } });
    const saved = await f.request(path, undefined, token);
    assert.equal(saved.status, 200); assert.equal(saved.body.status, 'awaiting_payment'); assert.equal(saved.body.paymentPending, false);
    assert.deepEqual(saved.body.paymentRequest, f.cancelOrder.paymentRequest);
    assert.equal(JSON.stringify(saved.body).includes('Synthetic Delivery Street'), false);
    assert.equal((await f.request(path + '/payment-attempt', {}, token)).status, 503);
    assert.equal(f.store.get(f.cancelOrder.orderId, token).paymentPending, false);
    assert.equal(f.store.list().length, 3);
  } finally { await f.close(); }
});

test('readiness pause preserves finalized receipts and transaction hints without unlocking submitted attempts', async () => {
  const f = await fixture();
  try {
    const receipt = await f.request(`/v1/orders/${f.paidOrder.orderId}`, undefined, f.paidOrder.recoveryToken);
    assert.equal(receipt.status, 200); assert.equal(receipt.body.status, 'paid');
    assert.deepEqual(receipt.body.receipt.evidence, f.paidEvidence);
    const path = `/v1/orders/${f.hintedOrder.orderId}`; const token = f.hintedOrder.recoveryToken;
    const transactionHash = `0x${'3'.repeat(64)}`;
    assert.equal((await f.request(path + '/transaction', { transactionHash })).status, 401);
    assert.equal((await f.request(path + '/transaction', { transactionHash }, 'wrong')).status, 404);
    assert.equal((await f.request(path + '/transaction', { transactionHash: 'invalid' }, token)).status, 400);
    assert.deepEqual(await f.request(path + '/transaction', { transactionHash }, token), { status: 202, body: { accepted: true } });
    assert.equal(f.store.paymentEvidence(f.hintedOrder.orderId).length, 0);
    const pending = await f.request(path, undefined, token);
    assert.equal(pending.body.status, 'awaiting_payment'); assert.equal(pending.body.paymentPending, true);
    assert.equal((await f.request(path + '/payment-attempt/cancel', { attemptToken: f.hintedLease.attemptToken }, token)).status, 409);
    // The finalized reader remains independent of HTTP admission readiness.
    const evidence = f.finalized(f.hintedOrder, 2);
    assert.equal(f.store.accept(evidence), true);
    const finalized = await f.request(path, undefined, token);
    assert.equal(finalized.status, 200); assert.equal(finalized.body.status, 'paid');
    assert.deepEqual(finalized.body.receipt.evidence, evidence);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n, 2);
    assert.equal((await f.request('/healthz')).body.ready, false);
  } finally { await f.close(); }
});

test('readiness pause preserves operator authorization without granting operators customer recovery capabilities', async () => {
  const f = await fixture();
  try {
    const path = `/v1/operator/orders/${f.paidOrder.orderId}`;
    for (const token of [undefined, 'wrong', f.paidOrder.recoveryToken]) {
      assert.equal((await f.request('/v1/operator/orders', undefined, token)).status, 401);
      assert.equal((await f.request(path, undefined, token)).status, 401);
      assert.equal((await f.request(path + '/claim', { owner: 'volunteer' }, token)).status, 401);
    }
    assert.equal(f.store.operatorOrder(f.paidOrder.orderId).owner, null);
    assert.equal((await f.request('/v1/operator/orders', undefined, operatorToken)).body.orders.length, 3);
    assert.equal((await f.request(path, undefined, operatorToken)).status, 200);
    assert.equal((await f.request(path + '/claim', { owner: 'volunteer' }, operatorToken)).status, 200);
    assert.equal(f.store.operatorOrder(f.paidOrder.orderId).owner, 'volunteer');
    assert.equal((await f.request(`/v1/orders/${f.paidOrder.orderId}`, undefined, operatorToken)).status, 404);
    assert.equal((await f.request(path + '?token=synthetic', undefined, operatorToken)).status, 400);
  } finally { await f.close(); }
});
