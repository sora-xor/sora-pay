import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, NATIVE_XOR, resolveRefundPolicy, validateConfig } from '../../dist/relay/index.js';
import { decrypt, encrypt } from '../../dist/relay/crypto.js';

const payer = encodeAddress(new Uint8Array(32).fill(1), 69);
const recipient = encodeAddress(new Uint8Array(32).fill(2), 69);
const key = Buffer.alloc(32, 7);
const epoch = Date.parse('2026-09-26T00:00:00.000Z');
const netPolicy = { version: 2, mode: 'net-network-fee' } as const;
const fullPolicy = { version: 1, mode: 'full' } as const;

function fixture(policy = netPolicy) {
  let now = epoch;
  const config = validateConfig({
    enabled: true, fulfillmentMode: 'on-demand', refundPolicy: policy, version: 'test',
    merchant: { id: 'test', name: 'Test', operatorName: 'Test', supportTelegram: 'sora_xor', dispatchPolicy: 'Test', customsPolicy: 'Test', privacyPolicy: 'Test', cancellationPolicy: 'Test' },
    pricing: { kind: 'exact-xor', version: 'test', jpyPerUsd: '', usdPerXor: '', fxSource: '', fxDate: '' },
    product: { id: 'test', name: 'Test', grams: 100, packedGrams: 120, priceXor: '0.000001' },
    shipping: [{ id: 'test', label: 'Test', countries: ['JP'], maxGrams: 500, priceXor: '0', reviewedAt: '2026-09-26' }],
    chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, decimals: 6, denomination: '1', recipient, rpcUrl: 'wss://example.test', startBlock: 100 },
    allowedOrigins: ['https://polkaswap.io'], retentionDays: 30,
  });
  const store = new OrderStore(':memory:', config, key, () => now);
  const input = { productId: 'test', quantity: 1, shippingRateId: 'test', payer, idempotencyKey: randomUUID(), address: { name: 'Synthetic', line1: 'Synthetic', city: 'Synthetic', country: 'JP' }, contact: { type: 'telegram', value: '@synthetic' } };
  const order = store.create(input);
  const evidence = (overrides = {}) => ({ ...order.paymentRequest, amountCodec: '100', transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(epoch + 1000).toISOString(), ...overrides });
  store.accept(evidence()); store.claim(order.orderId, 'owner');
  const draft = () => store.refund(order.orderId, 'owner');
  const quote = (fee = '10', overrides = {}) => ({ amountCodec: (BigInt(draft().grossAmountCodec) - BigInt(fee)).toString(), feeCodec: fee, blockHash: `0x${'3'.repeat(64)}`, blockNumber: '101', expiresAt: new Date(now + 60_000).toISOString(), ...overrides });
  const feeEvidence = (amountCodec = '10', overrides = {}) => ({ payer: recipient, assetId: NATIVE_XOR, amountCodec, eventIndex: 9, ...overrides });
  const outgoing = (refund, overrides = {}) => evidence({ payer: recipient, recipient: payer, reference: refund.reference, amountCodec: refund.amountCodec, eventIndex: 4, ...overrides });
  return { store, config, input, order, draft, quote, evidence, feeEvidence, outgoing, tick: (ms) => { now += ms; } };
}

test('only known refund-policy versions validate and missing settings retain legacy terms', () => {
  assert.deepEqual(resolveRefundPolicy(), fullPolicy);
  for (const value of [null, {}, { version: 1, mode: 'net-network-fee' }, { version: 2, mode: 'full' }, { version: 3, mode: 'net-network-fee' }]) {
    assert.throws(() => resolveRefundPolicy(value), /Invalid refund policy/);
    assert.throws(() => validateConfig({ enabled: false, refundPolicy: value }), /Invalid refund policy/);
  }
});

test('new orders snapshot policy while historical orders and pending obligations stay full-refund', () => {
  const f = fixture(); try {
    assert.deepEqual(f.order.refundPolicy, netPolicy); assert.deepEqual(f.store.catalog().refundPolicy, netPolicy);
    f.config.refundPolicy = fullPolicy;
    assert.deepEqual(f.store.create(f.input).refundPolicy, netPolicy);
    assert.deepEqual(f.store.catalog().refundPolicy, fullPolicy);
    const row = f.store.db.prepare('SELECT data FROM orders WHERE id=?').get(f.order.orderId);
    const historical = decrypt(row.data, key, f.order.orderId); delete historical.refundPolicySnapshot;
    historical.refund = { reference: `sp_${'d'.repeat(32)}`, recipient: payer, amountCodec: '100', status: 'pending' };
    f.store.db.prepare("UPDATE orders SET data=?,status='refund_pending' WHERE id=?").run(encrypt(historical, key, f.order.orderId), f.order.orderId);
    f.config.refundPolicy = netPolicy;
    const restored = f.store.get(f.order.orderId, f.order.recoveryToken);
    assert.deepEqual(restored.refundPolicy, fullPolicy); assert.equal(restored.refund.feeExempt, true);
    assert.equal(restored.refund.grossAmountCodec, '100'); assert.equal(restored.refund.amountCodec, '100');
    assert.equal(f.store.accept(f.outgoing(restored.refund)), true);
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).status, 'refunded');
  } finally { f.store.close(); }
});

test('net refund drafts cannot sign or accept a fee greater than the outstanding received amount', () => {
  const f = fixture(); try {
    const draft = f.draft(); assert.equal(draft.grossAmountCodec, '100'); assert.equal(draft.amountCodec, undefined);
    assert.equal(draft.feeExempt, false); assert.deepEqual(f.draft(), draft);
    assert.throws(() => f.store.refundAttempt(f.order.orderId, 'owner'), /current refund fee quote/);
    assert.equal(f.store.accept(f.outgoing(draft, { amountCodec: '90' })), false);
    assert.throws(() => f.store.quoteRefund(f.order.orderId, 'other', f.quote()), /unavailable/);
    for (const quote of [f.quote('100'), f.quote('101'), f.quote('10', { amountCodec: '91' }), f.quote('10', { feeCodec: '1e1' }), f.quote('10', { blockHash: 'bad' }), f.quote('10', { expiresAt: new Date(epoch).toISOString() }), f.quote('10', { expiresAt: new Date(epoch + 300_001).toISOString() })]) {
      assert.throws(() => f.store.quoteRefund(f.order.orderId, 'owner', quote), /Invalid refund fee quote/);
    }
    assert.equal(f.draft().amountCodec, undefined);
  } finally { f.store.close(); }
});

test('refund quotes expire and cannot change after an unresolved signing attempt', () => {
  const f = fixture(); try {
    f.store.quoteRefund(f.order.orderId, 'owner', f.quote()); f.tick(60_000);
    assert.throws(() => f.store.refundAttempt(f.order.orderId, 'owner'), /current refund fee quote/);
    f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    const lease = f.store.refundAttempt(f.order.orderId, 'owner');
    assert.throws(() => f.store.quoteRefund(f.order.orderId, 'owner', f.quote('11')), /unavailable/);
    assert.throws(() => f.store.refundAttempt(f.order.orderId, 'owner'), /already pending/);
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).refund.attempt, undefined);
    f.store.cancelRefundAttempt(f.order.orderId, 'owner', lease.attemptToken);
    f.store.quoteRefund(f.order.orderId, 'owner', f.quote('11'));
    const next = f.store.refundAttempt(f.order.orderId, 'owner');
    f.store.refundTransactionHint(f.order.orderId, 'owner', next.attemptToken, `0x${'9'.repeat(64)}`);
    assert.throws(() => f.store.cancelRefundAttempt(f.order.orderId, 'owner', next.attemptToken), /reconciliation/);
    assert.throws(() => f.store.quoteRefund(f.order.orderId, 'owner', f.quote()), /unavailable/);
  } finally { f.store.close(); }
});

for (const actual of ['10', '12']) test(`finalized actual fee ${actual} is deducted once, capped at the quote`, () => {
  const f = fixture(); try {
    const refund = f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    const transfer = f.outgoing(refund, { networkFee: f.feeEvidence(actual) });
    assert.equal(f.store.accept(transfer), true); assert.equal(f.store.accept(transfer), false);
    const result = f.store.operatorOrder(f.order.orderId);
    assert.equal(result.receivedCodec, '100'); assert.equal(result.refundedCodec, '90'); assert.equal(result.refundFeesCodec, '10');
    assert.equal(result.status, 'refunded'); assert.equal(result.refund.actualFeeCodec, actual);
    assert.equal(result.refund.deductedFeeCodec, '10'); assert.equal(result.refund.feeCorrectionCodec, '0');
    assert.throws(() => f.draft(), /not refundable/);
  } finally { f.store.close(); }
});

test('a lower finalized fee creates a fee-exempt make-good before refunding any additional payment', () => {
  const f = fixture(); try {
    const refund = f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    assert.equal(f.store.accept(f.evidence({ amountCodec: '20', eventIndex: 2 })), true);
    assert.equal(f.store.accept(f.outgoing(refund, { networkFee: f.feeEvidence('7') })), true);
    const result = f.store.get(f.order.orderId, f.order.recoveryToken);
    assert.equal(result.status, 'shipping_review'); assert.equal(result.refundFeeCorrectionCodec, '3');
    assert.equal(result.refund.deductedFeeCodec, '7'); assert.equal(result.refund.feeCorrectionCodec, '3');
    assert.throws(() => f.store.approve(f.order.orderId, 'owner'));
    const correction = f.draft(); assert.equal(correction.grossAmountCodec, '3'); assert.equal(correction.amountCodec, '3'); assert.equal(correction.feeExempt, true);
    assert.notEqual(correction.reference, refund.reference);
    assert.throws(() => f.store.quoteRefund(f.order.orderId, 'owner', f.quote('1')), /unavailable/);
    assert.doesNotThrow(() => f.store.refundAttempt(f.order.orderId, 'owner'));
    assert.equal(f.store.accept(f.outgoing(correction, { eventIndex: 5, networkFee: f.feeEvidence('10') })), true);
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).refundFeeCorrectionCodec, '0');
    const extra = f.draft(); assert.equal(extra.grossAmountCodec, '20'); assert.equal(extra.feeExempt, false);
    const extraQuoted = f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    assert.equal(f.store.accept(f.outgoing(extraQuoted, { eventIndex: 6, networkFee: f.feeEvidence() })), true);
    const final = f.store.operatorOrder(f.order.orderId);
    assert.equal(final.status, 'refunded'); assert.equal(final.refundedCodec, '103'); assert.equal(final.refundFeesCodec, '17');
    const saved = f.store.db.prepare('SELECT data FROM orders WHERE id=?').get(f.order.orderId);
    const history = decrypt(saved.data, key, f.order.orderId).refundHistory;
    assert.equal(history.length, 2); assert.equal(history[0].feeQuote.feeCodec, '10'); assert.equal(history[0].deductedFeeCodec, '7');
    assert.equal(history[1].feeExempt, true); assert.equal(history[1].amountCodec, '3');
    assert.equal(history[1].attempt, undefined);
    assert.deepEqual(final.refundHistory, history);
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).refundHistory, undefined);
  } finally { f.store.close(); }
});

for (const mode of ['missing', 'different-payer', 'zero']) test(`${mode} actual fee never becomes an unproven charge or an outgoing transfer retry`, () => {
  const f = fixture(); try {
    const refund = f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    const fee = mode === 'missing' ? undefined : f.feeEvidence(mode === 'zero' ? '0' : '10', mode === 'different-payer' ? { payer } : {});
    const transfer = f.outgoing(refund, { networkFee: fee });
    assert.equal(f.store.accept(transfer), true); assert.equal(f.store.accept(transfer), false);
    const result = f.store.get(f.order.orderId, f.order.recoveryToken);
    assert.equal(result.refund.receipt.evidence.amountCodec, '90'); assert.equal(result.refund.deductedFeeCodec, '0');
    assert.equal(result.refundFeeCorrectionCodec, '10'); assert.equal(result.status, 'shipping_review');
    assert.equal(result.refund.actualFeeCodec, mode === 'zero' ? '0' : undefined);
    const correction = f.draft(); assert.equal(correction.amountCodec, '10'); assert.equal(correction.feeExempt, true);
    assert.equal(f.store.accept(f.outgoing(correction, { eventIndex: 5 })), true);
    assert.equal(f.store.operatorOrder(f.order.orderId).refundedCodec, '100');
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).status, 'refunded');
  } finally { f.store.close(); }
});

test('incoming payment fees are neither received nor subtracted again from a refund', () => {
  const f = fixture(); try {
    f.store.accept(f.evidence({ eventIndex: 2, amountCodec: '100', networkFee: f.feeEvidence('25', { payer }) }));
    assert.equal(f.draft().grossAmountCodec, '200');
    const refund = f.store.quoteRefund(f.order.orderId, 'owner', f.quote());
    assert.equal(refund.amountCodec, '190');
    assert.equal(f.store.accept(f.outgoing(refund, { networkFee: f.feeEvidence() })), true);
    assert.equal(f.store.operatorOrder(f.order.orderId).refundedCodec, '190');
  } finally { f.store.close(); }
});
