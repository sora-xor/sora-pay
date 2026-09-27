import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CODEC_AMOUNT, PaymentError, paymentEventId, verifyFinalizedPayment, verifyFinalizedRefund,
  type FinalizedTransferEvidence, type ManualRefundReceipt,
} from '../../dist/core/index.js';
import { evidence, request } from './fixtures.ts';

/** Synthetic finalized direct-transfer receipt, with no wallet, RPC or customer data. */
function manualReceipt(): ManualRefundReceipt {
  return {
    status: 'finalized', request: structuredClone(request),
    evidence: { ...structuredClone(evidence), reference: null, transferKind: 'assets-transfer' },
    reconciliation: {
      version: 1, kind: 'operator-bound', expectedReference: request.reference,
      recordedAt: '2030-01-01T00:02:00.000Z',
    },
  };
}

test('manual refund verifies exact intent while preserving absent chain reference and independent binding', () => {
  const original = manualReceipt();
  const verified = verifyFinalizedRefund(request, original);
  assert.deepEqual(verified, original);
  assert.ok('reconciliation' in verified);
  assert.equal(verified.evidence.reference, null);
  assert.equal(verified.evidence.transferKind, 'assets-transfer');
  assert.equal(verified.request.reference, request.reference);
  assert.equal(verified.reconciliation.expectedReference, request.reference);
  assert.equal(paymentEventId(verified.evidence), paymentEventId(evidence));
  verified.request.merchant.name = 'Changed clone';
  verified.evidence.amountCodec = '1';
  verified.reconciliation.expectedReference = `sp_${'c'.repeat(32)}`;
  assert.deepEqual(original, manualReceipt());
  assert.equal(request.merchant.name, 'Community store');
});

test('ordinary referenced refunds retain strict verification and direct transfers never qualify as payments', () => {
  const automatic = verifyFinalizedPayment(request, evidence);
  assert.deepEqual(verifyFinalizedRefund(request, automatic), automatic);
  assert.equal('reconciliation' in verifyFinalizedRefund(request, automatic), false);
  assert.throws(() => verifyFinalizedPayment(request, manualReceipt().evidence as unknown as FinalizedTransferEvidence), /payment_mismatch_reference/);
  const { reconciliation: _binding, ...unbound } = manualReceipt();
  assert.throws(() => verifyFinalizedRefund(request, unbound), /invalid_refund_binding/);
  assert.throws(() => verifyFinalizedRefund(request, { ...automatic, evidence: { ...automatic.evidence, transferKind: 'assets-transfer' } }), /invalid_refund_binding/);
  assert.throws(() => verifyFinalizedRefund(request, { ...automatic, reconciliation: manualReceipt().reconciliation }), /invalid_refund_binding/);
});

test('manual binding rejects a substituted reference, version, kind, omitted binding or invented on-chain reference', () => {
  for (const change of [
    { version: 2 }, { version: '1' }, { kind: 'browser-bound' },
    { expectedReference: `sp_${'c'.repeat(32)}` }, { expectedReference: null }, { expectedReference: '' },
  ]) {
    const receipt = manualReceipt();
    Object.assign(receipt.reconciliation, change);
    assert.throws(() => verifyFinalizedRefund(request, receipt), /invalid_refund_binding/);
  }
  for (const binding of [undefined, null, [], true, 'operator-bound']) {
    assert.throws(() => verifyFinalizedRefund(request, { ...manualReceipt(), reconciliation: binding }), /invalid_refund_binding/);
  }
  for (const change of [
    { reference: request.reference }, { reference: '' }, { reference: undefined },
    { transferKind: 'xorless-transfer' }, { transferKind: undefined },
  ]) {
    const receipt = manualReceipt();
    Object.assign(receipt.evidence, change);
    assert.throws(() => verifyFinalizedRefund(request, receipt), /invalid_refund_binding/);
  }
});

test('every embedded request field is bound to independently supplied intent for both receipt forms', () => {
  for (const original of [manualReceipt(), verifyFinalizedPayment(request, evidence)]) {
    for (const change of [
      { version: 2 }, { merchant: { ...request.merchant, id: 'other-store' } },
      { merchant: { ...request.merchant, name: 'Other store' } },
      { chainGenesisHash: `0x${'c'.repeat(64)}` }, { assetId: `0x${'3'.repeat(64)}` },
      { payer: request.recipient, recipient: request.payer }, { amountCodec: '1' },
      { decimals: 17 }, { denomination: '1000' }, { reference: `sp_${'c'.repeat(32)}` },
      { expiresAt: '2030-01-01T01:00:00.000Z' },
    ]) {
      const receipt = structuredClone(original);
      Object.assign(receipt.request, change);
      assert.throws(() => verifyFinalizedRefund(request, receipt), PaymentError);
    }
  }
  const swapped = manualReceipt();
  swapped.request.reference = `sp_${'c'.repeat(32)}`;
  swapped.reconciliation.expectedReference = swapped.request.reference;
  assert.throws(() => verifyFinalizedRefund(request, swapped), /refund_mismatch_reference/);
});

test('manual transfer chain, asset, payer, recipient and exact positive codec amount must match', () => {
  for (const change of [
    { chainGenesisHash: `0x${'c'.repeat(64)}` }, { assetId: `0x${'3'.repeat(64)}` },
    { payer: request.recipient }, { recipient: request.payer },
    { payer: request.recipient, recipient: request.payer }, { amountCodec: '1' },
    { amountCodec: '0' }, { amountCodec: '-1' }, { amountCodec: '1e18' },
    { amountCodec: '01' }, { amountCodec: (MAX_CODEC_AMOUNT + 1n).toString() },
  ]) {
    const receipt = manualReceipt();
    Object.assign(receipt.evidence, change);
    assert.throws(() => verifyFinalizedRefund(request, receipt), PaymentError);
  }
});

test('manual receipts require successful finalized evidence with canonical hashes and bounded event coordinates', () => {
  for (const change of [
    { finalized: false }, { successful: false }, { finalized: 'true' }, { successful: 1 },
    { transactionHash: '0x123' }, { transactionHash: [evidence.transactionHash] },
    { blockHash: '0x123' }, { blockHash: [evidence.blockHash] },
    { blockNumber: '-1' }, { blockNumber: '01' }, { blockNumber: '1.5' },
    { blockNumber: 123 }, { blockNumber: '9'.repeat(21) },
    { eventIndex: -1 }, { eventIndex: 0.5 }, { eventIndex: Number.MAX_SAFE_INTEGER + 1 }, { eventIndex: '4' },
    { finalizedAt: 'tomorrow' }, { finalizedAt: '2030-02-31T00:01:00.000Z' },
    { finalizedAt: '2030-01-01T00:01:00Z' },
  ]) {
    const receipt = manualReceipt();
    Object.assign(receipt.evidence, change);
    assert.throws(() => verifyFinalizedRefund(request, receipt), PaymentError);
  }
  assert.throws(() => verifyFinalizedRefund(request, { ...manualReceipt(), status: 'pending' }), /payment_not_finalized/);
});

test('reconciliation timestamp is canonical and cannot precede finality, while expired intent remains recoverable', () => {
  for (const recordedAt of [
    '', 'tomorrow', '2030-02-31T00:02:00.000Z', '2030-01-01T00:02:00Z',
    '2030-01-01T09:02:00.000+09:00', '2030-01-01T00:00:59.999Z', null, 1,
  ]) {
    const receipt = manualReceipt();
    Object.assign(receipt.reconciliation, { recordedAt });
    assert.throws(() => verifyFinalizedRefund(request, receipt), /invalid_reconciliation_at/);
  }
  const receipt = manualReceipt();
  receipt.reconciliation.recordedAt = receipt.evidence.finalizedAt;
  assert.doesNotThrow(() => verifyFinalizedRefund(request, receipt));
  receipt.request.expiresAt = '2020-01-01T00:00:00.000Z';
  assert.doesNotThrow(() => verifyFinalizedRefund({ ...request, expiresAt: receipt.request.expiresAt }, receipt));
});

test('optional direct-transfer fee evidence preserves actual fee without changing transfer or inventing a deduction', () => {
  const receipt = manualReceipt();
  receipt.evidence.networkFee = { payer: request.payer, assetId: request.assetId, amountCodec: '123', eventIndex: 8 };
  const verified = verifyFinalizedRefund(request, receipt);
  assert.deepEqual(verified.evidence.networkFee, receipt.evidence.networkFee);
  assert.equal(verified.evidence.amountCodec, request.amountCodec);
  assert.equal('deductedFeeCodec' in verified, false);
  receipt.evidence.networkFee.amountCodec = '0';
  assert.doesNotThrow(() => verifyFinalizedRefund(request, receipt));
  for (const change of [
    { payer: request.recipient }, { payer: [request.payer] }, { assetId: `0x${'3'.repeat(64)}` },
    { amountCodec: '-1' }, { amountCodec: '01' }, { amountCodec: (MAX_CODEC_AMOUNT + 1n).toString() },
    { eventIndex: -1 }, { eventIndex: evidence.eventIndex }, { eventIndex: '8' },
  ]) {
    const changed = structuredClone(receipt);
    Object.assign(changed.evidence.networkFee!, change);
    assert.throws(() => verifyFinalizedRefund(request, changed), PaymentError);
  }
  for (const networkFee of [null, [], '123']) {
    const changed = manualReceipt();
    Object.assign(changed.evidence, { networkFee });
    assert.throws(() => verifyFinalizedRefund(request, changed), /invalid_network_fee/);
  }
});

test('malformed receipt objects fail without exposing arbitrary input in error messages', () => {
  for (const value of [
    undefined, null, [], 'private fixture', 1, {},
    { ...manualReceipt(), request: null }, { ...manualReceipt(), request: [] },
    { ...manualReceipt(), evidence: null }, { ...manualReceipt(), evidence: [] },
  ]) {
    assert.throws(() => verifyFinalizedRefund(request, value), (error: unknown) => {
      assert.ok(error instanceof PaymentError);
      assert.match(error.code, /^[a-z_]+$/);
      assert.equal(error.message.includes('private fixture'), false);
      return true;
    });
  }
});
