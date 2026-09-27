import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, validateConfig, createRelayServer, createCatalogRefresher, type MerchantConfig, type CreateOrder } from '../../dist/relay/index.js';
import { decrypt } from '../../dist/relay/crypto.js';

const template = JSON.parse(readFileSync(new URL('../../deploy/merchant.polkaswap.json.example', import.meta.url), 'utf8')) as MerchantConfig;
const key = Buffer.alloc(32, 19);
const time = Date.parse('2026-09-27T00:00:00.000Z');
function config(): MerchantConfig {
  const c = structuredClone(template); c.enabled = true; c.personalUseOnly = true; c.approvedShippingCountries = ['TW'];
  c.shipping = c.shipping.flatMap((rate) => {
    const countries = rate.countries.filter((country) => country !== 'TW' || rate.maxGrams <= 6000);
    return countries.length ? [{ ...rate, countries }] : [];
  });
  return validateConfig(c);
}
function input(quantity = 1, rate = 'ems-zone-1-500'): CreateOrder {
  return { productId: template.product.id, quantity, shippingRateId: rate, payer: encodeAddress(new Uint8Array(32).fill(1), 69), address: { name: 'Synthetic Person', line1: 'Synthetic Street', city: 'Synthetic City', country: 'TW' }, contact: { type: 'telegram', value: '@synthetic' }, idempotencyKey: randomUUID(), personalUseAccepted: true };
}

test('personal-use merchant policy accepts booleans only, including disabled configuration', () => {
  for (const enabled of [true, false]) {
    for (const value of [undefined, true, false]) { const c = config(); c.enabled = enabled; c.personalUseOnly = value; assert.doesNotThrow(() => validateConfig(c)); }
    for (const value of [null, 'true', 'false', 0, 1, [], {}]) { const c = config(); c.enabled = enabled; Object.assign(c, { personalUseOnly: value }); assert.throws(() => validateConfig(c), /Invalid personal-use policy/); }
  }
});

test('new orders require explicit true and privately retain the policy/attestation without public or chain leakage', () => {
  const c = config(); const store = new OrderStore(':memory:', c, key, () => time);
  try {
    assert.equal(store.catalog().personalUseOnly, true);
    for (const value of [undefined, false, null, 'true', 1, {}, []]) assert.throws(() => store.create({ ...input(), personalUseAccepted: value } as unknown as CreateOrder), { status: 400 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, 0);
    const request = input(); const saved = store.create(request);
    const raw = store.db.prepare('SELECT data FROM orders WHERE id=?').get(saved.orderId) as { data: string };
    assert.equal(raw.data.includes('personalUse'), false);
    const privateOrder = decrypt<any>(raw.data, key, saved.orderId);
    const expected = { version: 1, personalUseOnly: true, accepted: true, acceptedAt: new Date(time).toISOString() };
    assert.deepEqual(privateOrder.personalUseAttestation, expected);
    assert.equal(privateOrder.input.personalUseAccepted, true);
    assert.deepEqual(store.operatorOrder(saved.orderId).personalUseAttestation, expected);
    assert.equal(JSON.stringify(saved).includes('personalUse'), false);
    assert.equal(JSON.stringify(saved.paymentRequest).includes('personalUse'), false);
    assert.deepEqual(store.create(request), saved);
    assert.throws(() => store.create({ ...request, personalUseAccepted: false }), { status: 409 });
    c.personalUseOnly = false;
    assert.deepEqual(store.operatorOrder(saved.orderId).personalUseAttestation, expected);
  } finally { store.close(); }
});

test('old generic orders retry, recover, pay and refund unchanged after personal-use and country policy changes', () => {
  const c = config(); delete c.personalUseOnly; c.refundPolicy = { version: 1, mode: 'full' };
  const store = new OrderStore(':memory:', c, key, () => time);
  try {
    const request = input(); delete request.personalUseAccepted;
    const saved = store.create(request); assert.equal(store.catalog().personalUseOnly, false);
    c.personalUseOnly = true; c.approvedShippingCountries = [];
    assert.deepEqual(store.create(request), saved);
    assert.deepEqual(store.recoverCreate(request.idempotencyKey), saved);
    assert.deepEqual(store.get(saved.orderId, saved.recoveryToken).paymentRequest, saved.paymentRequest);
    assert.equal(store.operatorOrder(saved.orderId).personalUseAttestation, undefined);
    store.paymentAttempt(saved.orderId, saved.recoveryToken);
    const r = saved.paymentRequest;
    const evidence = { chainGenesisHash: r.chainGenesisHash, assetId: r.assetId, payer: r.payer, recipient: r.recipient, amountCodec: r.amountCodec, reference: r.reference, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(time + 1000).toISOString() };
    assert.equal(store.accept(evidence), true); store.claim(saved.orderId, 'volunteer');
    const refund = store.refund(saved.orderId, 'volunteer');
    assert.equal(refund.amountCodec, r.amountCodec);
    assert.equal(store.accept({ ...evidence, payer: r.recipient, recipient: r.payer, reference: refund.reference, eventIndex: 1, transactionHash: `0x${'3'.repeat(64)}` }), true);
    assert.equal(store.get(saved.orderId, saved.recoveryToken).status, 'refunded');
  } finally { store.close(); }
});

test('Taiwan frozen 6 kg table allows 49 bags, rejects 50 even through a retained non-Taiwan 30 kg band, and refresh never expands it', async () => {
  const c = config(); const before = structuredClone(c.shipping); const store = new OrderStore(':memory:', c, key, () => time);
  try {
    assert.equal(store.create(input()).paymentRequest.amountCodec, '3459809000000000000');
    assert.equal(49 * c.product.packedGrams + c.product.packagingGrams!, 5960);
    assert.equal(50 * c.product.packedGrams + c.product.packagingGrams!, 6080);
    assert.equal(store.create(input(49, 'ems-zone-1-6000')).status, 'awaiting_payment');
    for (const band of ['ems-zone-1-6000', 'ems-zone-1-7000', 'ems-zone-1-30000']) assert.throws(() => store.create(input(50, band)), /Shipping inquiry required/);
    assert.ok(c.shipping.some((rate) => rate.maxGrams === 30000 && rate.countries.includes('CN')));
    assert.ok(store.catalog().shipping.every((rate) => rate.maxGrams <= 6000 && rate.countries.length === 1 && rate.countries[0] === 'TW'));
    const refresh = createCatalogRefresher(c, { clock: () => new Date(time), shipping: async () => ({
      version: 'synthetic-ems', carrier: 'Japan Post', service: 'EMS', currency: 'JPY', fetchedAt: new Date(time).toISOString(), availabilityUpdatedLabel: 'Synthetic', availabilityPreviousAnnouncement: '', tentativeSurchargesIncluded: true,
      sources: {} as never, bands: before.filter((r) => r.id.startsWith('ems-zone-1-')).map((rate) => ({ zone: 1, maxGrams: rate.maxGrams, priceJpy: '1' })),
      countries: ['TW', 'CN', 'KR'].map((code) => ({ code, name: code, zone: 1, service: 'accepted', coverage: '', ead: '', requiresReview: false, reasons: [], detailsUrl: null })),
    }) });
    await refresh.refresh();
    for (const rate of c.shipping) { const old = before.find((r) => r.id === rate.id)!; assert.deepEqual(rate.countries, old.countries); assert.equal(rate.priceXor, old.priceXor); assert.equal(rate.maxGrams, old.maxGrams); }
    assert.equal(c.personalUseOnly, true);
    assert.ok(store.catalog().shipping.every((rate) => rate.maxGrams <= 6000));
    assert.throws(() => store.create(input(50, 'ems-zone-1-30000')), /Shipping inquiry required/);
  } finally { store.close(); }
});

test('HTTP create cannot bypass personal-use confirmation and errors never reflect customer input', async () => {
  const store = new OrderStore(':memory:', config(), key, () => time);
  const server = createRelayServer(store, { operatorToken: 'o'.repeat(64), ready: () => true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (value: unknown) => fetch(base + '/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://polkaswap.io' }, body: JSON.stringify(value) });
  try {
    const catalog = await (await fetch(base + '/v1/catalog')).json(); assert.equal(catalog.personalUseOnly, true);
    for (const value of [undefined, false, null, 'true', 1]) { const response = await post({ ...input(), personalUseAccepted: value }); assert.equal(response.status, 400); assert.equal(JSON.stringify(await response.json()).includes('Synthetic'), false); }
    const response = await post(input()); assert.equal(response.status, 201);
    const saved = await response.json(); assert.equal(saved.status, 'awaiting_payment'); assert.equal(JSON.stringify(saved).includes('personalUse'), false);
    assert.equal((await post(input(50, 'ems-zone-1-30000'))).status, 400);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM orders').get()!.n, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
});
