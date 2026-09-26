import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { OrderStore, validateConfig, createRelayServer, NATIVE_XOR, type RefundFeeQuote } from '../../dist/relay/index.js';
import type { PaymentRequest } from '../../dist/core/index.js';
const payer = 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA';
const merchant = 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C';
const now = Date.parse('2026-09-26T00:00:00.000Z');

/** A private in-memory order and ephemeral loopback HTTP server; no external services are contacted. */
async function fixture(options: { legacy?: boolean; quote?: (request: PaymentRequest, gross: string) => Promise<RefundFeeQuote> } = {}) {
  const config = validateConfig({ enabled: true, fulfillmentMode: 'on-demand', version: 'test', refundPolicy: options.legacy ? { version: 1, mode: 'full' } : { version: 2, mode: 'net-network-fee' }, merchant: { id: 'test', name: 'Test', operatorName: 'Test', supportTelegram: 'sora_xor', dispatchPolicy: 'Test', customsPolicy: 'Test', privacyPolicy: 'Test', cancellationPolicy: 'Test' }, pricing: { kind: 'exact-xor', mode: 'launch-fixed', version: 'test', jpyPerUsd: '150', usdPerXor: '5.37', fxDate: '2026-09-26', fxSource: 'https://example.test' }, product: { id: 'tea', name: 'Tea', priceXor: '1', grams: 100, packedGrams: 120, packagingGrams: 80 }, shipping: [{ id: 'jp', countries: ['JP'], maxGrams: 500, priceXor: '0', label: 'Test', reviewedAt: '2026-09-26' }], chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, decimals: 18, denomination: '1', recipient: merchant, rpcUrl: 'wss://example.test', startBlock: 100 }, allowedOrigins: ['https://polkaswap.io'], retentionDays: 30 });
  let clock = now;
  const store = new OrderStore(':memory:', config, Buffer.alloc(32, 7), () => clock);
  const order = store.create({ productId: 'tea', quantity: 1, shippingRateId: 'jp', payer, idempotencyKey: randomUUID(), address: { name: 'Synthetic', line1: 'Synthetic', city: 'Synthetic', country: 'JP' }, contact: { type: 'telegram', value: '@synthetic' } });
  store.accept({ ...order.paymentRequest, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, finalized: true, successful: true, finalizedAt: new Date(now).toISOString() });
  store.claim(order.orderId, 'volunteer');
  const server = createRelayServer(store, { operatorToken: 'o'.repeat(64), ready: () => true, quoteRefund: options.quote });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/operator/orders/${order.orderId}`;
  const post = (action: string, extra: object = {}, token = 'o'.repeat(64)) => fetch(base + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ owner: 'volunteer', ...extra }) });
  return { store, order, post, tick: () => { clock += 121_000; }, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); } };
}
const quote = (gross: string, fee = '100'): RefundFeeQuote => ({ amountCodec: (BigInt(gross) - BigInt(fee)).toString(), feeCodec: fee, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', expiresAt: new Date(now + 120_000).toISOString() });

test('HTTP refund fee comes only from trusted reverse transfer intent and is rechecked before signing', async () => {
  const requests: PaymentRequest[] = [];
  const f = await fixture({ quote: async (request, gross) => { requests.push(request); return quote(gross); } });
  try {
    const denied = await f.post('refund', {}, 'bad'); assert.equal(denied.status, 401); assert.equal(requests.length, 0);
    assert.equal((await f.post('refund-attempt')).status, 409); assert.equal(requests.length, 0);
    assert.equal(f.store.operatorOrder(f.order.orderId).refund, undefined);
    const response = await f.post('refund', { feeCodec: '0', amountCodec: '1', recipient: merchant }); assert.equal(response.status, 200);
    const refund = await response.json(); assert.equal(refund.feeQuote.feeCodec, '100'); assert.equal(refund.amountCodec, '999999999999999900');
    assert.equal(requests[0]?.payer, merchant); assert.equal(requests[0]?.recipient, payer); assert.equal(requests[0]?.reference, refund.reference); assert.equal(requests[0]?.amountCodec, f.order.paymentRequest.amountCodec);
    const leased = await f.post('refund-attempt'); assert.equal(leased.status, 200); const { attemptToken } = await leased.json(); assert.equal(requests.length, 2);
    assert.equal(f.store.operatorOrder(f.order.orderId).refund?.attempt, undefined);
    assert.equal(f.store.refund(f.order.orderId, 'volunteer').attempt?.token, attemptToken);
    assert.equal((await f.post('refund-attempt')).status, 409); assert.equal(requests.length, 2);
    // Reopening pending instructions cannot mutate an uncertain signing attempt.
    assert.equal((await f.post('refund')).status, 200); assert.equal(requests.length, 2);
    assert.equal((await f.post('refund-transaction', { attemptToken, transactionHash: `0x${'5'.repeat(64)}` })).status, 200);
    for (const response of await Promise.all([f.post('refund-attempt'), f.post('refund-attempt')])) assert.equal(response.status, 409);
    assert.equal(requests.length, 2); assert.equal(f.store.refund(f.order.orderId, 'volunteer').attempt?.token, attemptToken);
  } finally { await f.close(); }
});

test('changed trusted fee rejects the lease until operator obtains another quote', async () => {
  let fee = '100'; const f = await fixture({ quote: async (_request, gross) => quote(gross, fee) });
  try {
    assert.equal((await f.post('refund')).status, 200); fee = '101';
    assert.equal((await f.post('refund-attempt')).status, 409); assert.equal(f.store.operatorOrder(f.order.orderId).refund?.attempt, undefined);
    assert.equal((await f.post('refund')).status, 200); assert.equal((await f.post('refund-attempt')).status, 200);
  } finally { await f.close(); }
});

test('missing or failed fee provider saves the obligation but never enables net signing or exposes errors', async () => {
  for (const provider of [undefined, async () => { throw new Error('private RPC credential'); }]) {
    const f = await fixture({ quote: provider });
    try {
      const result = await f.post('refund'); assert.equal(result.status, 503); assert.equal(JSON.stringify(await result.json()).includes('credential'), false);
      assert.equal(f.store.operatorOrder(f.order.orderId).refund?.amountCodec, undefined);
      assert.equal((await f.post('refund-attempt')).status, 409);
    } finally { await f.close(); }
  }
  const legacy = await fixture({ legacy: true });
  try { assert.equal((await legacy.post('refund')).status, 200); assert.equal((await legacy.post('refund-attempt')).status, 200); }
  finally { await legacy.close(); }
});

test('expired quote and concurrent fee checks cannot authorize duplicate refund submissions', async () => {
  const f = await fixture({ quote: async (_request, gross) => quote(gross) });
  try {
    assert.equal((await f.post('refund')).status, 200);
    const attempts = await Promise.all([f.post('refund-attempt'), f.post('refund-attempt')]);
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409]);
  } finally { await f.close(); }
  const expired = await fixture({ quote: async (_request, gross) => quote(gross) });
  try { await expired.post('refund'); expired.tick(); assert.equal((await expired.post('refund-attempt')).status, 409); }
  finally { await expired.close(); }
});
