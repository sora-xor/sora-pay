import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, validateConfig, createRelayServer, NATIVE_XOR, type RefundReconciliation } from '../../dist/relay/index.js';
import { verifyFinalizedRefund, verifyFinalizedPayment, type FinalizedManualRefundEvidence } from '../../dist/core/index.js';
import { decrypt } from '../../dist/relay/crypto.js';

const customer = encodeAddress(new Uint8Array(32).fill(1), 69), merchant = encodeAddress(new Uint8Array(32).fill(2), 69);
const gross = '5453596000000000000', deduction = '110000000000000000', net = '5343596000000000000';
const key = Buffer.alloc(32, 4), owner = 'volunteer';
const start = Date.parse('2026-09-27T12:00:00.000Z');
/** Encrypted synthetic order and existing signed-at lease; never uses a real store or wallet. */
function fixture(path = ':memory:', mode: 'agreed' | 'full' | 'net' = 'agreed', fundingAmount = gross) {
  let now = start;
  const config = validateConfig({ enabled: true, version: 'test', fulfillmentMode: 'on-demand', refundPolicy: mode === 'net' ? { version: 2, mode: 'net-network-fee' } : { version: 1, mode: 'full' },
    merchant: { id: 'test', name: 'Synthetic', operatorName: 'Synthetic', supportTelegram: 'example_support', dispatchPolicy: 'Test', customsPolicy: 'Test', privacyPolicy: 'Test', cancellationPolicy: 'Test' },
    pricing: { kind: 'exact-xor', version: 'test', jpyPerUsd: '', usdPerXor: '', fxDate: '', fxSource: '' },
    product: { id: 'test', name: 'Synthetic', grams: 100, packedGrams: 120, priceXor: '5.453596' }, shipping: [{ id: 'test', countries: ['JP'], maxGrams: 500, priceXor: '0', label: 'Synthetic', reviewedAt: '2026-09-27' }],
    chain: { genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, recipient: merchant, decimals: 18, denomination: '1', rpcUrl: 'wss://example.test', startBlock: 100 }, allowedOrigins: ['https://merchant.example'], retentionDays: 30 });
  const store = new OrderStore(path, config, key, () => now);
  const input = () => ({ productId: 'test', quantity: 1, shippingRateId: 'test', payer: customer, idempotencyKey: randomUUID(), address: { name: 'Synthetic', line1: 'Synthetic', city: 'Synthetic', country: 'JP' }, contact: { type: 'telegram' as const, value: '@synthetic' } });
  const order = store.create(input());
  const paid = { ...order.paymentRequest, amountCodec: fundingAmount, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(now).toISOString() };
  store.accept(paid); store.claim(order.orderId, owner); const original = store.refund(order.orderId, owner);
  if (mode === 'agreed') store.agreeRefundDeduction(order.orderId, { owner, expectedReference: original.reference, expectedGrossAmountCodec: gross, agreedDeductionCodec: deduction, consentId: randomUUID(), consentNote: 'Synthetic explicit agreement.' });
  if (mode === 'net') store.quoteRefund(order.orderId, owner, { amountCodec: net, feeCodec: deduction, blockHash: `0x${'b'.repeat(64)}`, blockNumber: '100', expiresAt: new Date(now + 60000).toISOString() });
  now += 1000; const lease = store.refundAttempt(order.orderId, owner); now += 1000;
  const refund = store.operatorOrder(order.orderId).refund!;
  const evidence: FinalizedManualRefundEvidence = { chainGenesisHash: config.chain.genesisHash, assetId: NATIVE_XOR, payer: merchant, recipient: customer, amountCodec: refund.amountCodec!, reference: null, transferKind: 'assets-transfer', transactionHash: `0x${'3'.repeat(64)}`, blockHash: `0x${'4'.repeat(64)}`, blockNumber: '101', eventIndex: 3, successful: true, finalized: true, finalizedAt: new Date(now).toISOString(), networkFee: { payer: merchant, assetId: NATIVE_XOR, amountCodec: '100018400000000000', eventIndex: 4 } };
  const reconcile: RefundReconciliation = { owner, attemptToken: lease.attemptToken, expectedReference: original.reference, expectedGrossAmountCodec: original.grossAmountCodec, expectedAmountCodec: refund.amountCodec!, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, transactionHash: evidence.transactionHash, eventIndex: evidence.eventIndex };
  now += 1000;
  const row = (id = order.orderId) => store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)!;
  return { store, config, order, original, refund, paid, evidence, reconcile, input, row, clock: () => now, advance: (ms: number) => { now += ms; } };
}

test('trusted manual binding preserves real null reference, original receipt and policy, exact agreed accounting and private audit', () => {
  const f = fixture(); try {
    const other = f.store.create(f.input()); const otherRow = f.row(other.orderId); const before = f.store.operatorOrder(f.order.orderId); const meta = f.store.db.prepare('SELECT * FROM meta').all();
    assert.equal(f.store.accept(f.evidence as never), false, 'automatic matching must not relax');
    const result = f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence);
    assert.equal(result.status, 'finalized'); assert.equal(result.reference, f.original.reference); assert.equal(result.attempt, undefined);
    assert.equal(result.receipt!.evidence.reference, null); assert.equal(result.receipt!.request.reference, f.original.reference);
    assert.equal('reconciliation' in result.receipt!, true); assert.equal(result.actualFeeCodec, '100018400000000000');
    assert.equal(result.deductedFeeCodec, '0'); assert.equal(result.feeCorrectionCodec, '0');
    verifyFinalizedRefund(result.receipt!.request, result.receipt!); assert.throws(() => verifyFinalizedPayment(result.receipt!.request, result.receipt!.evidence as never));
    const after = f.store.operatorOrder(f.order.orderId);
    assert.equal(after.status, 'refunded'); assert.equal(after.refundedCodec, net); assert.equal(after.refundAgreedDeductionsCodec, deduction); assert.equal(after.refundFeesCodec, '0'); assert.equal(after.refundFeeCorrectionCodec, '0');
    assert.deepEqual(after.receipt, before.receipt); assert.deepEqual(after.refundPolicy, before.refundPolicy); assert.deepEqual(after.refundAmendment, before.refundAmendment);
    assert.equal(after.refundReconciliations.length, 1); assert.equal(after.refundReconciliations[0]!.owner, owner); assert.equal(after.refundReconciliations[0]!.attemptToken, undefined);
    assert.deepEqual(f.row(other.orderId), otherRow); assert.deepEqual(f.store.db.prepare('SELECT * FROM meta').all(), meta);
    const publicOrder = f.store.get(f.order.orderId, f.order.recoveryToken);
    assert.equal(publicOrder.refundReconciliations, undefined); assert(!JSON.stringify(publicOrder).includes(f.reconcile.attemptToken));
    const saved = decrypt(f.row().data as string, key, f.order.orderId); assert.equal(saved.refund.attempt.submitted, true); assert.equal(saved.refund.attempt.transactionHash, f.evidence.transactionHash);
    assert.equal(f.store.paymentEvidence(f.order.orderId).filter((entry) => entry.reference === null).length, 1);
  } finally { f.store.close(); }
});
test('same binding retries and restart are idempotent; a changed consent locator/token cannot reuse the settlement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sora-refund-manual-')); const f = fixture(join(dir, 'orders.sqlite'));
  try {
    const accepted = f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence); const row = f.row(); const jobs = f.store.db.prepare('SELECT * FROM outbox').all();
    assert.deepEqual(f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence), accepted); assert.deepEqual(f.row(), row); assert.deepEqual(f.store.db.prepare('SELECT * FROM outbox').all(), jobs);
    for (const change of [{ attemptToken: 'a'.repeat(64) }, { owner: 'other' }, { expectedAmountCodec: '1' }, { expectedReference: `sp_${'f'.repeat(32)}` }, { transactionHash: `0x${'f'.repeat(64)}` }]) assert.throws(() => f.store.checkRefundReconciliation(f.order.orderId, { ...f.reconcile, ...change }), { status: 409 });
    f.store.close(); const reopened = new OrderStore(join(dir, 'orders.sqlite'), f.config, key, f.clock);
    try { assert.deepEqual(reopened.checkRefundReconciliation(f.order.orderId, f.reconcile), accepted); assert.equal(reopened.operatorOrder(f.order.orderId).refundAgreedDeductionsCodec, deduction); } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
test('strict body, owner, existing lease and CAS refusal happen without any settlement writes', () => {
  const f = fixture(); try {
    const before = f.row();
    for (const change of [{ evidence: f.evidence }, { attemptToken: 'bad' }, { eventIndex: -1 }, { blockNumber: '01' }, { expectedAmountCodec: '01' }, { expectedGrossAmountCodec: 2 }]) assert.throws(() => f.store.checkRefundReconciliation(f.order.orderId, { ...f.reconcile, ...change } as never), { status: 400 });
    for (const change of [{ attemptToken: 'a'.repeat(64) }, { owner: 'other' }, { expectedAmountCodec: '1' }, { expectedGrossAmountCodec: '1' }, { expectedReference: `sp_${'f'.repeat(32)}` }]) assert.throws(() => f.store.checkRefundReconciliation(f.order.orderId, { ...f.reconcile, ...change }), { status: 409 });
    assert.deepEqual(f.row(), before);
    f.store.cancelRefundAttempt(f.order.orderId, owner, f.reconcile.attemptToken);
    assert.throws(() => f.store.checkRefundReconciliation(f.order.orderId, f.reconcile), { status: 409 });
  } finally { f.store.close(); }
});
test('wrong chain/asset/amount/payer/recipient/reference/finality/timing evidence cannot settle', () => {
  const changes = [{ chainGenesisHash: `0x${'f'.repeat(64)}` }, { assetId: `0x${'f'.repeat(64)}` }, { amountCodec: gross }, { payer: customer }, { recipient: merchant }, { reference: `sp_${'f'.repeat(32)}` }, { transferKind: 'balances-transfer' }, { finalized: false }, { successful: false }, { finalizedAt: new Date(start - 1000).toISOString() }, { finalizedAt: new Date(start + 500).toISOString() }, { finalizedAt: new Date(start + 10000).toISOString() }, { blockHash: `0x${'f'.repeat(64)}` }, { transactionHash: `0x${'f'.repeat(64)}` }, { eventIndex: 2 }];
  for (const change of changes) { const f = fixture(); try { const before = f.row(); assert.throws(() => f.store.reconcileRefund(f.order.orderId, f.reconcile, { ...f.evidence, ...change } as never), { status: 409 }); assert.deepEqual(f.row(), before); } finally { f.store.close(); } }
});
test('a prior submitted hint must match canonical transaction and cannot be replaced by reconciliation', () => {
  const f = fixture(); try {
    f.store.refundTransactionHint(f.order.orderId, owner, f.reconcile.attemptToken, `0x${'f'.repeat(64)}`); const before = f.row();
    assert.throws(() => f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence), { status: 409 }); assert.deepEqual(f.row(), before);
  } finally { f.store.close(); }
});
test('physical transfer consumed for another order or mirrored event is rejected atomically', () => {
  const f = fixture(); try {
    f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence);
    const second = f.store.create(f.input()); f.store.accept({ ...f.paid, ...second.paymentRequest, eventIndex: 8 }); f.store.claim(second.orderId, owner); const pending = f.store.refund(second.orderId, owner); const lease = f.store.refundAttempt(second.orderId, owner);
    const attempt = { ...f.reconcile, attemptToken: lease.attemptToken, expectedReference: pending.reference, expectedAmountCodec: gross, eventIndex: 2 };
    f.advance(1000); const evidence = { ...f.evidence, eventIndex: 2, amountCodec: gross, finalizedAt: new Date(f.clock()).toISOString() };
    const before = f.row(second.orderId);
    assert.throws(() => f.store.reconcileRefund(second.orderId, attempt, evidence), /Physical transfer already consumed/); assert.deepEqual(f.row(second.orderId), before);
  } finally { f.store.close(); }
});
test('outbox failure rolls back audit, accounting and event consumption together', () => {
  const f = fixture(); try {
    const before = f.row(); const count = f.store.db.prepare('SELECT COUNT(*) AS n FROM payments').get()!.n;
    f.store.db.exec("CREATE TRIGGER fail_refund_outbox BEFORE INSERT ON outbox WHEN NEW.kind='refunded' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    assert.throws(() => f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence), /synthetic failure/); assert.deepEqual(f.row(), before); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payments').get()!.n, count);
  } finally { f.store.close(); }
});
test('legacy full and ordinary net-policy refunds retain existing accounting through manual binding', () => {
  for (const mode of ['full', 'net'] as const) { const f = fixture(':memory:', mode); try {
    f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence); const result = f.store.operatorOrder(f.order.orderId);
    assert.equal(result.refundAgreedDeductionsCodec, '0');
    if (mode === 'full') { assert.equal(result.status, 'refunded'); assert.equal(result.refundedCodec, gross); assert.equal(result.refundFeesCodec, '0'); }
    else { assert.equal(result.status, 'shipping_review'); assert.equal(result.refundFeesCodec, '100018400000000000'); assert.equal(result.refundFeeCorrectionCodec, '9981600000000000'); }
  } finally { f.store.close(); } }
});
test('protected HTTP rereads only locator, refuses caller evidence, handles CAS race and no-op replay', async () => {
  const f = fixture(); let reads = 0; let unavailable = false; let duringRead: (() => void) | undefined;
  const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => true, admissionReady: () => false, readRefundTransfer: async (locator) => { reads++; assert.deepEqual(locator, { blockNumber: f.evidence.blockNumber, blockHash: f.evidence.blockHash, transactionHash: f.evidence.transactionHash, eventIndex: f.evidence.eventIndex }); duringRead?.(); if (unavailable) throw new Error('Synthetic private RPC diagnostics must not appear'); return f.evidence; } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/operator/orders/${f.order.orderId}/refund-reconcile`;
  const send = (body: unknown, token = 'o'.repeat(64)) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await send(f.reconcile, 'x'.repeat(64))).status, 401); assert.equal(reads, 0);
    assert.equal((await send({ ...f.reconcile, evidence: f.evidence })).status, 400); assert.equal(reads, 0);
    assert.equal((await send({ ...f.reconcile, owner: 'other' })).status, 409); assert.equal(reads, 0);
    unavailable = true; const failure = await send(f.reconcile); assert.equal(failure.status, 503); assert(!JSON.stringify(await failure.json()).includes('diagnostics')); assert.equal(f.store.operatorOrder(f.order.orderId).status, 'refund_pending');
    unavailable = false;
    // The post-fetch transaction rechecks the live lease; no stale RPC response can overwrite it.
    duringRead = () => f.store.cancelRefundAttempt(f.order.orderId, owner, f.reconcile.attemptToken);
    assert.equal((await send(f.reconcile)).status, 409); duringRead = undefined;
    const lease = f.store.refundAttempt(f.order.orderId, owner); f.reconcile.attemptToken = lease.attemptToken;
    assert.equal((await send(f.reconcile)).status, 200); const count = reads;
    const replay = await send(f.reconcile); assert.equal(replay.status, 200); assert.equal(reads, count); const receipt = await replay.json(); assert.equal(receipt.receipt.evidence.reference, null); assert.equal(receipt.attempt, undefined);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close(); }
});


test('mismatched original funding has no convenience receipt but its saved evidence still supports exact refund reconciliation', () => {
  const f = fixture(':memory:', 'full', '5000000000000000000'); try {
    assert.equal(f.store.operatorOrder(f.order.orderId).receipt, undefined);
    assert.equal(f.reconcile.expectedGrossAmountCodec, '5000000000000000000');
    f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence);
    const order = f.store.operatorOrder(f.order.orderId); assert.equal(order.status, 'refunded'); assert.equal(order.refundedCodec, '5000000000000000000'); assert.equal(order.receipt, undefined);
  } finally { f.store.close(); }
});
test('later exact payment cannot rewrite original refund timing and remains a separate full-refund liability', () => {
  const f = fixture(); try {
    f.advance(1000); const later = { ...f.paid, transactionHash: `0x${'5'.repeat(64)}`, blockHash: `0x${'6'.repeat(64)}`, blockNumber: '102', eventIndex: 7, finalizedAt: new Date(f.clock()).toISOString() };
    f.store.accept(later); const currentReceipt = f.store.operatorOrder(f.order.orderId).receipt;
    assert.equal(currentReceipt!.evidence.transactionHash, later.transactionHash);
    f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence);
    const order = f.store.operatorOrder(f.order.orderId); assert.equal(order.status, 'shipping_review'); assert.deepEqual(order.receipt, currentReceipt); assert.equal(order.refundAgreedDeductionsCodec, deduction);
    const next = f.store.refund(f.order.orderId, owner); assert.equal(next.grossAmountCodec, gross); assert.equal(next.amountCodec, gross); assert.equal(next.agreedDeduction, undefined); assert.equal(next.feeExempt, true);
    assert.equal(f.store.checkRefundReconciliation(f.order.orderId, f.reconcile)!.receipt!.evidence.reference, null);
  } finally { f.store.close(); }
});
test('existing uppercase hexadecimal transaction hint agrees with its canonical lowercase locator', () => {
  const f = fixture(); try {
    const tx = `0x${'a'.repeat(64)}`; f.reconcile.transactionHash = tx; f.evidence.transactionHash = tx;
    f.store.refundTransactionHint(f.order.orderId, owner, f.reconcile.attemptToken, '0x' + tx.slice(2).toUpperCase());
    assert.equal(f.store.reconcileRefund(f.order.orderId, f.reconcile, f.evidence).status, 'finalized');
  } finally { f.store.close(); }
});
