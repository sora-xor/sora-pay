import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, validateConfig, createCatalogRefresher, type MerchantConfig, type CreateOrder, type OrderView } from '../../dist/relay/index.js';
import type { FinalizedTransferEvidence } from '../../dist/core/index.js';

const template = JSON.parse(readFileSync(new URL('../../deploy/merchant.polkaswap.json.example', import.meta.url), 'utf8')) as MerchantConfig;
const payer = encodeAddress(new Uint8Array(32).fill(1), 69);
const now = Date.parse('2026-09-27T00:00:00.000Z');

function config(approved?: string[]): MerchantConfig {
  const value = structuredClone(template);
  value.enabled = true;
  delete value.approvedShippingCountries;
  if (approved !== undefined) value.approvedShippingCountries = approved;
  value.refundPolicy = { version: 1, mode: 'full' };
  value.shipping = [
    { id: 'ems-zone-1-500', countries: ['JP', 'KR'], maxGrams: 500, priceXor: '0.5', label: 'Synthetic zone 1', reviewedAt: '2026-09-27' },
    { id: 'ems-zone-2-500', countries: ['US'], maxGrams: 500, priceXor: '0.75', label: 'Synthetic zone 2', reviewedAt: '2026-09-27' },
  ];
  return validateConfig(value);
}
function input(country = 'JP', shippingRateId = 'ems-zone-1-500'): CreateOrder {
  return { productId: template.product.id, quantity: 1, shippingRateId, payer, idempotencyKey: randomUUID(), address: { name: 'Synthetic', line1: 'Synthetic', city: 'Synthetic', country }, contact: { type: 'telegram', value: '@synthetic' } };
}
function store(value: MerchantConfig): OrderStore { return new OrderStore(':memory:', value, Buffer.alloc(32, 7), () => now); }
function evidence(order: OrderView): FinalizedTransferEvidence {
  const request = order.paymentRequest;
  return { chainGenesisHash: request.chainGenesisHash, assetId: request.assetId, payer: request.payer, recipient: request.recipient, amountCodec: request.amountCodec, reference: request.reference, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(now + 1000).toISOString() };
}

test('approved destination configuration accepts absent/empty/ISO lists and rejects malformed lists even while disabled', () => {
  for (const enabled of [false, true]) {
    for (const approved of [undefined, [], ['JP', 'GB', 'AX', 'BQ', 'TW', 'XK']]) {
      const value = config(); value.enabled = enabled; value.approvedShippingCountries = approved;
      assert.doesNotThrow(() => validateConfig(value));
    }
    for (const approved of [null, '', 'JP', 'JP,KR', {}, 1, true, ['JP', 'JP'], ['jp'], [' JP'], ['JP '], ['JPN'], ['ZZ'], ['UK'], ['EU'], [null], [1], [['JP']]]) {
      const value = config(); value.enabled = enabled;
      Object.assign(value, { approvedShippingCountries: approved });
      assert.throws(() => validateConfig(value), /Invalid approved shipping countries/, JSON.stringify(approved));
    }
  }
});

test('omitting the gate preserves generic rates and creation while explicit blocks still win', () => {
  const value = config(); value.blockedCountries = ['KR']; const orders = store(value);
  try {
    assert.deepEqual(orders.catalog().shipping.map((rate) => rate.countries), [['JP'], ['US']]);
    assert.equal(orders.create(input('US', 'ems-zone-2-500')).status, 'awaiting_payment');
    assert.throws(() => orders.create(input('KR')), /Shipping inquiry required/);
  } finally { orders.close(); }
});

test('empty approval list is a valid inquiry-only catalog and direct order creation cannot bypass it', () => {
  const orders = store(config([]));
  try {
    assert.equal(orders.catalog().enabled, true);
    assert.deepEqual(orders.catalog().shipping, []);
    assert.throws(() => orders.create(input()), { status: 400, message: 'Shipping inquiry required for this order' });
    assert.equal(orders.db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, 0);
    assert.equal(orders.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n, 0);
  } finally { orders.close(); }
});

test('approval intersects every band and explicit blocks without changing configured countries or amounts', () => {
  const value = config(['JP', 'KR']); value.blockedCountries = ['KR'];
  const original = structuredClone(value.shipping); const orders = store(value);
  try {
    const published = orders.catalog().shipping;
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].countries, ['JP']);
    assert.equal(published[0].priceXor, '0.5');
    assert.deepEqual(value.shipping, original);
    assert.throws(() => orders.create(input('US', 'ems-zone-2-500')), /Shipping inquiry required/);
    assert.throws(() => orders.create(input('KR')), /Shipping inquiry required/);
    assert.equal(orders.create(input()).paymentRequest.amountCodec, '2259225000000000000');
  } finally { orders.close(); }
});

test('removing destination approval preserves saved retries, signing, payment recovery and full refund evidence', () => {
  const value = config(['JP']); const orders = store(value);
  try {
    const request = input(); const saved = orders.create(request);
    value.approvedShippingCountries = [];
    assert.deepEqual(orders.create(request), saved);
    assert.deepEqual(orders.recoverCreate(request.idempotencyKey), saved);
    assert.deepEqual(orders.get(saved.orderId, saved.recoveryToken).paymentRequest, saved.paymentRequest);
    assert.doesNotThrow(() => orders.paymentAttempt(saved.orderId, saved.recoveryToken));
    assert.equal(orders.accept(evidence(saved)), true);
    orders.claim(saved.orderId, 'volunteer');
    const refund = orders.refund(saved.orderId, 'volunteer');
    assert.equal(refund.amountCodec, saved.paymentRequest.amountCodec);
    assert.equal(refund.feeExempt, true);
    assert.equal(orders.accept({ ...evidence(saved), payer: saved.paymentRequest.recipient, recipient: saved.paymentRequest.payer, reference: refund.reference, eventIndex: 1, transactionHash: `0x${'3'.repeat(64)}` }), true);
    assert.equal(orders.get(saved.orderId, saved.recoveryToken).status, 'refunded');
    assert.throws(() => orders.create(input()), /Shipping inquiry required/);
  } finally { orders.close(); }
});

test('carrier refresh can restore frozen rates but never adds approval for new checkout destinations', async () => {
  const value = config(['JP']); const orders = store(value);
  let time = new Date(now); let accepted = ['JP', 'KR', 'CN'];
  const refresh = createCatalogRefresher(value, { clock: () => time, shipping: async () => ({
    version: 'synthetic-ems', carrier: 'Japan Post', service: 'EMS', currency: 'JPY', fetchedAt: time.toISOString(), availabilityUpdatedLabel: 'Synthetic', availabilityPreviousAnnouncement: '', tentativeSurchargesIncluded: true,
    sources: {} as never, bands: [{ zone: 1, maxGrams: 500, priceJpy: '99999' }],
    countries: ['JP', 'KR', 'CN'].map((code) => ({ code, name: code, zone: 1, service: accepted.includes(code) ? 'accepted' : 'suspended', coverage: '', ead: '', requiresReview: false, reasons: [], detailsUrl: null })),
  }) });
  try {
    await refresh.refresh();
    assert.deepEqual(value.shipping[0].countries, ['JP', 'KR']);
    assert.deepEqual(orders.catalog().shipping[0].countries, ['JP']);
    assert.throws(() => orders.create(input('KR')), /Shipping inquiry required/);
    accepted = ['KR', 'CN']; time = new Date(now + 86_400_000); await refresh.refresh();
    assert.deepEqual(orders.catalog().shipping, []);
    value.approvedShippingCountries = []; accepted.push('JP'); time = new Date(now + 2 * 86_400_000); await refresh.refresh();
    assert.deepEqual(value.shipping[0].countries, ['JP', 'KR']);
    assert.equal(value.shipping[0].priceXor, '0.5');
    assert.deepEqual(value.approvedShippingCountries, []);
    assert.deepEqual(orders.catalog().shipping, []);
    assert.throws(() => orders.create(input()), /Shipping inquiry required/);
  } finally { orders.close(); }
});
