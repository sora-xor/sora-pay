import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, createRelayServer, validateConfig, telegramDelivery, NATIVE_XOR, type RefundDeductionConsent, type RefundObligation } from '../../dist/relay/index.js';
import { decrypt } from '../../dist/relay/crypto.js';

const payer = encodeAddress(new Uint8Array(32).fill(1), 69);
const merchant = encodeAddress(new Uint8Array(32).fill(2), 69);
const key = Buffer.alloc(32, 7);
const now = Date.parse('2026-09-27T05:00:00.000Z');
const gross = '5453596000000000000';
const deduction = '110000000000000000';
const net = '5343596000000000000';
const actualFee = '100025912589707326';

/** Synthetic finalized payment and assigned unsigned full refund; never uses external services. */
function fixture(path = ':memory:', legacy = true) {
  const config = validateConfig({ enabled: true, fulfillmentMode: 'on-demand', refundPolicy: legacy ? { version: 1, mode: 'full' } : { version: 2, mode: 'net-network-fee' }, version: 'test',
    merchant: { id: 'test', name: 'Synthetic', operatorName: 'Synthetic', supportTelegram: 'example_support', dispatchPolicy: 'Test', customsPolicy: 'Test', privacyPolicy: 'Test', cancellationPolicy: 'Test' },
    pricing: { kind: 'exact-xor', version: 'test', jpyPerUsd: '', usdPerXor: '', fxDate: '', fxSource: '' },
    product: { id: 'test', name: 'Synthetic', grams: 100, packedGrams: 120, priceXor: '5.453596' },
    shipping: [{ id: 'test', countries: ['JP'], maxGrams: 500, priceXor: '0', label: 'Synthetic', reviewedAt: '2026-09-27' }],
    chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, recipient: merchant, decimals: 18, denomination: '1', rpcUrl: 'wss://example.test', startBlock: 100 }, allowedOrigins: ['https://merchant.example'], retentionDays: 30 });
  const store = new OrderStore(path, config, key, () => now);
  const input = () => ({ productId: 'test', quantity: 1, shippingRateId: 'test', payer, idempotencyKey: randomUUID(), address: { name: 'Synthetic', line1: 'Synthetic', city: 'Synthetic', country: 'JP' }, contact: { type: 'telegram' as const, value: '@synthetic' } });
  const order = store.create(input());
  const incoming = (overrides = {}) => ({ ...order.paymentRequest, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(now).toISOString(), ...overrides });
  store.accept(incoming()); store.claim(order.orderId, 'volunteer');
  const original = store.refund(order.orderId, 'volunteer');
  const consent = (overrides = {}): RefundDeductionConsent => ({ owner: 'volunteer', expectedReference: original.reference, expectedGrossAmountCodec: gross, agreedDeductionCodec: deduction, consentId: randomUUID(), consentNote: 'Synthetic customer explicitly agrees to a 0.11 XOR deduction on this refund only.', ...overrides });
  const outgoing = (refund: RefundObligation, overrides = {}) => incoming({ payer: merchant, recipient: payer, amountCodec: refund.amountCodec, reference: refund.reference, eventIndex: 1, ...overrides });
  const fee = (amountCodec = actualFee, overrides = {}) => ({ payer: merchant, assetId: NATIVE_XOR, amountCodec, eventIndex: 9, ...overrides });
  const row = (id = order.orderId) => store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)!;
  return { store, config, input, order, original, consent, incoming, outgoing, fee, row };
}

test('consent preserves original full terms and prior obligation while atomically publishing the exact agreed net', () => {
  const f = fixture(); try {
    const another = f.store.create(f.input()); const otherRow = f.row(another.orderId);
    const beforeMeta = f.store.db.prepare('SELECT * FROM meta ORDER BY key').all();
    const before = decrypt(f.row().data as string, key, f.order.orderId);
    const consent = f.consent(); const amended = f.store.agreeRefundDeduction(f.order.orderId, consent);
    assert.equal(amended.amountCodec, net); assert.equal(amended.grossAmountCodec, gross);
    assert.equal(amended.reference, f.original.reference); assert.equal(amended.feeExempt, true);
    assert.equal(amended.feeQuote, undefined); assert.equal(amended.actualFeeCodec, undefined);
    assert.deepEqual(amended.agreedDeduction, { version: 1, amountCodec: deduction, consentId: consent.consentId, recordedAt: new Date(now).toISOString() });
    const saved = f.store.operatorOrder(f.order.orderId);
    assert.deepEqual(saved.refundPolicy, { version: 1, mode: 'full' });
    assert.deepEqual(saved.refundAmendment?.previousRefund, f.original);
    assert.deepEqual(saved.refundAmendment?.originalPolicy, saved.refundPolicy);
    assert.equal(saved.refundAmendment?.consentNote, consent.consentNote);
    const after = decrypt(f.row().data as string, key, f.order.orderId);
    assert.deepEqual(after.refundPolicySnapshot, before.refundPolicySnapshot);
    for (const name of ['input', 'paymentRequest', 'receivedCodec', 'refundedCodec', 'receipt', 'pricingSnapshot', 'shippingSnapshot']) assert.deepEqual(after[name], before[name]);
    assert.deepEqual(f.row(another.orderId), otherRow); assert.deepEqual(f.store.db.prepare('SELECT * FROM meta ORDER BY key').all(), beforeMeta);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='refund_amended'").get()!.n, 1);
    const customer = f.store.get(f.order.orderId, f.order.recoveryToken);
    assert.equal(customer.refundAgreedDeductionsCodec, '0'); assert.equal(customer.refundAmendment, undefined);
    assert.equal(JSON.stringify(customer).includes(consent.consentNote), false);
    assert.equal(String(f.row().data).includes(consent.consentNote), false);
    assert.equal(customer.status, 'refund_pending');
    assert.throws(() => f.store.quoteRefund(f.order.orderId, 'volunteer', { amountCodec: net, feeCodec: deduction, blockHash: `0x${'3'.repeat(64)}`, blockNumber: '101', expiresAt: new Date(now + 60_000).toISOString() }), /unavailable/);
  } finally { f.store.close(); }
});

test('strict consent validation rejects extra fields, noncanonical amounts and stale owner/reference/gross without changing any row', () => {
  const f = fixture(); try {
    const before = f.row();
    for (const change of [{ extra: true }, { consentNote: '' }, { consentNote: 'bad\ntext' }, { consentId: 'not-a-uuid' }, { agreedDeductionCodec: '0' }, { agreedDeductionCodec: gross }, { agreedDeductionCodec: '1e17' }, { agreedDeductionCodec: '0110000000000000000' }, { agreedDeductionCodec: 1 }, { expectedGrossAmountCodec: '01' }]) {
      assert.throws(() => f.store.agreeRefundDeduction(f.order.orderId, f.consent(change)), { status: 400 });
      assert.deepEqual(f.row(), before);
    }
    for (const change of [{ owner: 'another' }, { expectedReference: `sp_${'0'.repeat(32)}` }, { expectedGrossAmountCodec: (BigInt(gross) + 1n).toString() }]) {
      assert.throws(() => f.store.agreeRefundDeduction(f.order.orderId, f.consent(change)), { status: 409 });
      assert.deepEqual(f.row(), before);
    }
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='refund_amended'").get()!.n, 0);
  } finally { f.store.close(); }
});

test('one consent is durable and idempotent across restart; competing or revised consent never changes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sora-pay-consent-'));
  const f = fixture(join(directory, 'orders.sqlite')); const consent = f.consent();
  try {
    const first = f.store.agreeRefundDeduction(f.order.orderId, consent); const before = f.row();
    assert.deepEqual(f.store.agreeRefundDeduction(f.order.orderId, consent), first); assert.deepEqual(f.row(), before);
    for (const change of [{ consentId: randomUUID() }, { agreedDeductionCodec: '100000000000000000' }, { consentNote: 'Different instruction' }]) assert.throws(() => f.store.agreeRefundDeduction(f.order.orderId, { ...consent, ...change }), { status: 409 });
    f.store.close();
    const reopened = new OrderStore(join(directory, 'orders.sqlite'), f.config, key, () => now);
    try { assert.deepEqual(reopened.agreeRefundDeduction(f.order.orderId, consent), first); assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='refund_amended'").get()!.n, 1); }
    finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test('signing, submitted signing, even a canceled prior signature, finality, or a net-policy draft forbid amendment', () => {
  for (const mode of ['signing', 'submitted', 'canceled', 'finalized', 'net-policy', 'new-payment']) {
    const f = fixture(':memory:', mode !== 'net-policy'); try {
      if (['signing', 'submitted', 'canceled'].includes(mode)) {
        const lease = f.store.refundAttempt(f.order.orderId, 'volunteer');
        if (mode === 'submitted') f.store.refundTransactionHint(f.order.orderId, 'volunteer', lease.attemptToken, `0x${'3'.repeat(64)}`);
        if (mode === 'canceled') f.store.cancelRefundAttempt(f.order.orderId, 'volunteer', lease.attemptToken);
      }
      if (mode === 'finalized') f.store.accept(f.outgoing(f.original));
      if (mode === 'new-payment') f.store.accept(f.incoming({ amountCodec: '1', eventIndex: 2 }));
      const before = f.row();
      assert.throws(() => f.store.agreeRefundDeduction(f.order.orderId, f.consent()), { status: 409 }, mode);
      assert.deepEqual(f.row(), before);
    } finally { f.store.close(); }
  }
});

for (const actual of [actualFee, '120000000000000000', '0', 'missing', 'other-payer']) test(`fixed deduction settles exactly once with ${actual} actual fee and never creates a fee correction`, () => {
  const f = fixture(); try {
    const consent = f.consent(); const refund = f.store.agreeRefundDeduction(f.order.orderId, consent);
    assert.equal(f.store.accept(f.outgoing(refund, { amountCodec: gross })), false);
    assert.equal(f.store.accept(f.outgoing(refund, { amountCodec: (BigInt(gross) - BigInt(actualFee)).toString() })), false);
    assert.equal(f.store.get(f.order.orderId, f.order.recoveryToken).refundAgreedDeductionsCodec, '0');
    const networkFee = actual === 'missing' ? undefined : f.fee(actual === 'other-payer' ? actualFee : actual, actual === 'other-payer' ? { payer } : {});
    const transfer = f.outgoing(refund, { networkFee });
    assert.equal(f.store.accept(transfer), true); assert.equal(f.store.accept(transfer), false);
    const result = f.store.operatorOrder(f.order.orderId);
    assert.equal(result.status, 'refunded'); assert.equal(result.refundedCodec, net);
    assert.equal(result.refundAgreedDeductionsCodec, deduction); assert.equal(result.refundFeesCodec, '0');
    assert.equal(result.refundFeeCorrectionCodec, '0'); assert.equal(result.refund?.feeCorrectionCodec, '0'); assert.equal(result.refund?.deductedFeeCodec, '0');
    assert.equal(result.refund?.actualFeeCodec, ['missing', 'other-payer'].includes(actual) ? undefined : actual);
    assert.equal(BigInt(result.refundedCodec) + BigInt(result.refundAgreedDeductionsCodec), BigInt(gross));
    assert.deepEqual(result.refundPolicy, { version: 1, mode: 'full' });
    const before = f.row(); assert.equal(f.store.agreeRefundDeduction(f.order.orderId, consent).status, 'finalized'); assert.deepEqual(f.row(), before);
  } finally { f.store.close(); }
});

test('later additional payments keep full-refund policy and cannot reuse or repeat the agreed deduction', () => {
  const f = fixture(); try {
    const consent = f.consent(); const amended = f.store.agreeRefundDeduction(f.order.orderId, consent);
    f.store.accept(f.outgoing(amended, { networkFee: f.fee() }));
    f.store.accept(f.incoming({ amountCodec: '1000000000000000000', eventIndex: 2 }));
    const extra = f.store.refund(f.order.orderId, 'volunteer');
    assert.equal(extra.grossAmountCodec, '1000000000000000000'); assert.equal(extra.amountCodec, extra.grossAmountCodec);
    assert.equal(extra.feeExempt, true); assert.equal(extra.agreedDeduction, undefined);
    assert.notEqual(extra.reference, amended.reference);
    assert.throws(() => f.store.agreeRefundDeduction(f.order.orderId, f.consent({ expectedReference: extra.reference, expectedGrossAmountCodec: extra.grossAmountCodec })), { status: 409 });
    assert.equal(f.store.agreeRefundDeduction(f.order.orderId, consent).reference, amended.reference);
    assert.equal(f.store.accept(f.outgoing(extra, { eventIndex: 3 })), true);
    const result = f.store.operatorOrder(f.order.orderId);
    assert.equal(result.status, 'refunded'); assert.equal(result.refundedCodec, '6343596000000000000');
    assert.equal(result.refundAgreedDeductionsCodec, deduction); assert.equal(result.refundHistory[0]?.agreedDeduction?.amountCodec, deduction);
  } finally { f.store.close(); }
});

test('operator-only amendment HTTP is strict, concurrent/idempotent, and leases the exact agreed amount without repricing', async () => {
  const f = fixture(); let quoteCalls = 0;
  const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => true, admissionReady: () => false, quoteRefund: async () => { quoteCalls++; throw new Error('Must not reprice an agreed deduction'); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/operator/orders/${f.order.orderId}`;
  const post = (route: string, body: object, token = 'o'.repeat(64)) => fetch(base + '/' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const consent = f.consent();
    assert.equal((await post('refund-agreed-deduction', consent, 'bad')).status, 401);
    assert.equal((await post('refund-agreed-deduction', { ...consent, recipient: merchant })).status, 400);
    const competing = { ...consent, consentId: randomUUID() };
    const responses = await Promise.all([post('refund-agreed-deduction', consent), post('refund-agreed-deduction', competing)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const winner = responses[0]!.status === 200 ? consent : competing;
    const accepted = await responses.find((response) => response.status === 200)!.json(); assert.equal(accepted.amountCodec, net);
    assert.equal((await post('refund-agreed-deduction', winner)).status, 200);
    const leases = await Promise.all([post('refund-attempt', { owner: 'volunteer' }), post('refund-attempt', { owner: 'volunteer' })]);
    assert.deepEqual(leases.map((response) => response.status).sort(), [200, 409]);
    const replay = await post('refund-agreed-deduction', winner); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).attempt, undefined);
    assert.equal(quoteCalls, 0); assert.equal(f.store.operatorOrder(f.order.orderId).refund?.amountCodec, net);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='refund_amended'").get()!.n, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close(); }
});

test('volunteer notifications distinguish the agreed deduction, pending return and proven actual fee', async () => {
  const f = fixture(); const messages: string[] = [];
  const delivery = telegramDelivery('12345:synthetic', '12345', async (_url, options) => {
    messages.push(JSON.parse(String(options?.body)).text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    const consent = f.consent(); const refund = f.store.agreeRefundDeduction(f.order.orderId, consent);
    let job;
    while ((job = f.store.pendingNotification())) {
      if (job.kind === 'refund_amended') await delivery.send(job);
      f.store.finishNotification(job.id, job.claimToken, true);
    }
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Agreed deduction \(not a network fee\): 0\.11 XOR/);
    assert.match(messages[0]!, /Refund pending, not confirmed sent: 5\.343596 XOR/);
    assert.match(messages[0]!, /Actual SORA network fee: not verified/);
    assert.match(messages[0]!, /Original refund policy: full \(version 1\), unchanged/);
    assert.equal(messages[0]!.includes(consent.consentNote), false);
    f.store.accept(f.outgoing(refund, { networkFee: f.fee() }));
    job = f.store.pendingNotification(); assert.ok(job); await delivery.send(job);
    assert.match(messages[1]!, /Refund finalized: 5\.343596 XOR/);
    assert.match(messages[1]!, /Actual SORA network fee: 0\.100025912589707326 XOR \(paid by store\)/);
  } finally { f.store.close(); }
});
