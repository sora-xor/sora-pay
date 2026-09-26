import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CODEC_AMOUNT, PaymentError, assertWalletMatches, codecAmount,
  convertJpyToXor, fromCodec, parseDecimal, paymentEventId, toCodec, validatePaymentRequest, verifyFinalizedPayment,
} from '../../dist/core/index.js';
import { evidence, request, state } from './fixtures.ts';

test('launch pricing uses only fixed USD credit and selected FX, and rounds upward at six decimals', () => {
  assert.equal(convertJpyToXor('1500', '150', '5.37'), '1.862198');
  assert.equal(convertJpyToXor('1500', '150', '5.30'), '1.886793');
  assert.equal(convertJpyToXor('5.37', '1', '5.37'), '1');
  assert.equal(convertJpyToXor('0.000001', '150', '5.37'), '0.000001');
  assert.equal(convertJpyToXor('1500', '149.123456', '5.37'), '1.873144');
  for (const rate of ['0', '-1', '1e2', 'NaN']) assert.throws(() => convertJpyToXor('1500', rate, '5.37'));
});

test('codec conversion preserves every decimal and rejects precision loss or overflow', () => {
  assert.equal(toCodec('1.862198'), request.amountCodec);
  assert.equal(fromCodec(request.amountCodec), '1.862198');
  assert.equal(toCodec('0.000000000000000001'), '1');
  assert.equal(fromCodec('1'), '0.000000000000000001');
  assert.equal(toCodec('123', 0), '123');
  assert.equal(fromCodec('123', 0), '123');
  assert.equal(toCodec('1.0000000000000000000'), '1000000000000000000');
  assert.throws(() => toCodec('1.0000000000000000001'), /precision_loss/);
  assert.throws(() => toCodec(MAX_CODEC_AMOUNT.toString()), /invalid_amount/);
  assert.equal(codecAmount(MAX_CODEC_AMOUNT.toString()), MAX_CODEC_AMOUNT);
  for (const value of ['-1', '01', '1e18', '1.0', ' 1', (MAX_CODEC_AMOUNT + 1n).toString()]) assert.throws(() => codecAmount(value));
  assert.throws(() => fromCodec('1', 39));
  assert.throws(() => toCodec('1', -1));
  assert.deepEqual(parseDecimal('12.345'), { numerator: 12345n, denominator: 1000n });
});

test('request validates intent and rejects private data in its public reference', () => {
  assert.doesNotThrow(() => validatePaymentRequest(request));
  for (const change of [
    { amountCodec: '0' }, { denomination: '0' }, { assetId: `0x${'3'.repeat(64)}` },
    { reference: 'buyer@example.com' }, { payer: request.recipient }, { recipient: 'invalid' },
    { chainGenesisHash: 'mainnet' }, { expiresAt: '2030-02-31T00:00:00.000Z' },
    { merchant: { id: 'store', name: '<tag>\n' } },
  ]) assert.throws(() => validatePaymentRequest({ ...request, ...change }));
});

test('wallet checks include balance plus fee, exact chain identity, expiry, account and denomination', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.doesNotThrow(() => assertWalletMatches(request, state, now, '1000'));
  assert.throws(() => assertWalletMatches(request, { ...state, balanceCodec: request.amountCodec }, now, '1'), /insufficient_balance/);
  assert.throws(() => assertWalletMatches(request, { ...state, balanceCodec: undefined }, now), /balance_unavailable/);
  for (const change of [{ account: null }, { chainGenesisHash: null }, { denomination: '1000' }, { decimals: 17 }, { assetId: null }]) {
    assert.throws(() => assertWalletMatches(request, { ...state, ...change }, now));
  }
  assert.throws(() => assertWalletMatches(request, state, Date.parse(request.expiresAt)), /request_expired/);
});

test('only complete matching finalized evidence creates a receipt, even when verification is late', () => {
  const receipt = verifyFinalizedPayment(request, evidence);
  assert.equal(receipt.status, 'finalized');
  receipt.request.merchant.name = 'changed';
  assert.equal(request.merchant.name, 'Community store');
  assert.equal(paymentEventId(evidence), `${request.chainGenesisHash}:${evidence.blockHash}:4`);
  for (const change of [
    { successful: false }, { finalized: false }, { payer: request.recipient }, { recipient: request.payer },
    { amountCodec: '1' }, { reference: `sp_${'c'.repeat(32)}` }, { assetId: `0x${'3'.repeat(64)}` },
    { chainGenesisHash: `0x${'b'.repeat(64)}` }, { transactionHash: '0x123' }, { eventIndex: -1 }, { blockNumber: '1.5' },
    { finalizedAt: 'tomorrow' },
  ]) assert.throws(() => verifyFinalizedPayment(request, { ...evidence, ...change }));
  assert.equal(verifyFinalizedPayment({ ...request, expiresAt: '2020-01-01T00:00:00.000Z' }, evidence).status, 'finalized');
  assert.throws(() => paymentEventId({ ...evidence, eventIndex: -1 }), PaymentError);
});

test('optional finalized native fee evidence is bounded and does not alter the transfer amount', () => {
  const networkFee = { payer: request.payer, assetId: request.assetId, amountCodec: '123', eventIndex: 8 };
  const receipt = verifyFinalizedPayment(request, { ...evidence, networkFee });
  assert.equal(receipt.evidence.amountCodec, request.amountCodec);
  assert.deepEqual(receipt.evidence.networkFee, networkFee);
  assert.doesNotThrow(() => verifyFinalizedPayment(request, { ...evidence, networkFee: { ...networkFee, amountCodec: '0' } }));
  for (const change of [{ payer: 'invalid' }, { payer: [request.payer] }, { assetId: `0x${'3'.repeat(64)}` }, { amountCodec: '-1' }, { amountCodec: '1e18' }, { eventIndex: -1 }, { eventIndex: evidence.eventIndex }]) {
    assert.throws(() => verifyFinalizedPayment(request, { ...evidence, networkFee: { ...networkFee, ...change } }));
  }
});
