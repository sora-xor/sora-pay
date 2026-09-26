import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';
import { OrderStore, NATIVE_XOR, validateConfig, xorPriceFromJpy, xorToCodec, scanFinalized, deliverNext, createRelayServer, encryptedBackup, restoreBackup } from '../../dist/relay/index.js';

const alice = encodeAddress(new Uint8Array(32).fill(1), 69);
const bob = encodeAddress(new Uint8Array(32).fill(2), 69);
const third = encodeAddress(new Uint8Array(32).fill(3), 69);
const key = Buffer.alloc(32, 7);
const epoch = Date.parse('2026-09-25T00:00:00.000Z');
function config() {
  return validateConfig({ enabled: true, fulfillmentMode: 'on-demand', version: 'pilot-1', merchant: { id: 'test', name: 'Test merchant', operatorName: 'Test merchant', supportEmail: 'support@example.test', dispatchPolicy: 'Reviewed before dispatch', customsPolicy: 'Buyer customs charges', privacyPolicy: '30 days after completion', cancellationPolicy: 'Full XOR for unshippable orders' }, pricing: { version: 'fx-1', jpyPerUsd: '150', usdPerXor: '5.37', fxSource: 'https://example.test/fx', fxDate: '2026-09-25' }, product: { id: 'tea', name: 'Sencha', grams: 100, packedGrams: 120, packagingGrams: 80, priceJpy: '1500' }, shipping: [{ id: 'jp-500', countries: ['JP'], maxGrams: 500, priceJpy: '600', label: 'Test postal service', reviewedAt: '2026-09-25' }], chain: { genesisHash: '0x' + 'a'.repeat(64), assetId: NATIVE_XOR, decimals: 18, denomination: '1', recipient: bob, rpcUrl: 'wss://rpc.example.test', startBlock: 100 }, allowedOrigins: ['https://polkaswap.io'], retentionDays: 30 });
}
function input() { return { productId: 'tea', quantity: 1, shippingRateId: 'jp-500', payer: alice, idempotencyKey: randomUUID(), address: { name: 'Private Customer Name', line1: 'Secret Delivery Street', city: 'Shizuoka', postalCode: '420-0000', country: 'JP' }, contact: { type: 'email', value: 'private-customer@example.test' } }; }
function evidence(order, overrides = {}) { return { chainGenesisHash: order.paymentRequest.chainGenesisHash, assetId: NATIVE_XOR, payer: alice, recipient: bob, amountCodec: order.paymentRequest.amountCodec, reference: order.paymentRequest.reference, transactionHash: '0x' + '1'.repeat(64), blockHash: '0x' + '2'.repeat(64), blockNumber: '100', eventIndex: 0, successful: true, finalized: true, finalizedAt: new Date(epoch + 1000).toISOString(), ...overrides }; }
function fixture(c = config()) { let now = epoch; const directory = mkdtempSync(join(tmpdir(), 'sora-pay-test-')); const path = join(directory, 'orders.sqlite'); const store = new OrderStore(path, c, key, () => now); return { store, path, tick: (ms) => { now += ms; }, cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } }; }

test('frozen $5.37 conversion rounds up exactly and native denomination does not multiply payment', () => {
  assert.equal(xorPriceFromJpy('1500', '150'), '1.862198');
  assert.equal(xorPriceFromJpy('0', '150'), '0.000000');
  assert.equal(xorToCodec('1.862198', 18, '1000'), '1862198000000000000');
  assert.throws(() => xorPriceFromJpy('1500', '0'));
  assert.throws(() => xorPriceFromJpy('1e3', '150'));
});

test('order persisted before payment, encrypted at rest, recoverable only by secret, idempotent retry', () => {
  const f = fixture(); try {
    const request = input(); const order = f.store.create(request);
    assert.deepEqual(f.store.create(request), order);
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'awaiting_payment');
    assert.throws(() => f.store.get(order.orderId, 'wrong'));
    assert.throws(() => f.store.create({ ...request, quantity: 2 }));
    assert.equal(f.store.catalog().product.stockAvailable, null);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(f.path).toString('utf8');
    for (const privateText of ['Private Customer Name', 'Secret Delivery Street', 'private-customer@example.test', order.recoveryToken]) assert.equal(bytes.includes(privateText), false);
    assert.equal(order.paymentRequest.reference.startsWith('sp_'), true);
    assert.equal(JSON.stringify(order.paymentRequest).includes('Secret'), false);
  } finally { f.cleanup(); }
});

test('shipping validates country and actual quantity weight including one parcel overhead', () => {
  const f = fixture(); try {
    assert.doesNotThrow(() => f.store.create({ ...input(), quantity: 3 }));
    assert.throws(() => f.store.create({ ...input(), quantity: 4 }));
    assert.throws(() => f.store.create({ ...input(), address: { ...input().address, country: 'US' } }));
    assert.throws(() => f.store.create({ ...input(), quantity: 0 }));
    assert.throws(() => f.store.create({ ...input(), payer: 'bad' }));
  } finally { f.cleanup(); }
});

test('optional postal code normalizes UAE orders and equivalent retries without changing other address fields', () => {
  const c = config(); c.shipping[0].countries = ['AE']; const f = fixture(c);
  try {
    const request = { ...input(), address: { ...input().address, city: 'Dubai', country: 'AE', postalCode: '' } };
    const saved = f.store.create(request);
    const { postalCode, ...addressWithoutPostalCode } = request.address;
    assert.equal(postalCode, '');
    assert.deepEqual(f.store.create({ ...request, address: addressWithoutPostalCode }), saved);
    assert.deepEqual(f.store.create({ ...request, address: { ...request.address, postalCode: '   ' } }), saved);
    assert.equal(f.store.list().length, 1);
    assert.deepEqual(f.store.operatorOrder(saved.orderId).address, request.address);
    const provided = f.store.create({ ...request, idempotencyKey: randomUUID(), address: { ...request.address, postalCode: '  420-0000  ' } });
    assert.equal(f.store.operatorOrder(provided.orderId).address.postalCode, '420-0000');
    const bounded = f.store.create({ ...request, idempotencyKey: randomUUID(), address: { ...request.address, postalCode: 'a'.repeat(200) } });
    assert.equal(f.store.operatorOrder(bounded.orderId).address.postalCode.length, 200);
  } finally { f.cleanup(); }
});

test('HTTP accepts UAE checkout without postal code but rejects malformed postal values and missing required delivery fields', async () => {
  const c = config(); c.shipping[0].countries = ['AE']; const f = fixture(c);
  const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => true, trustLoopbackProxy: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const request = { ...input(), address: { ...input().address, city: 'Dubai', country: 'AE', postalCode: '' } };
  const post = (value) => fetch(base + '/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://polkaswap.io', 'X-Sora-Pay-Client-IP': '127.0.0.1' }, body: JSON.stringify(value) });
  try {
    const response = await post(request); assert.equal(response.status, 201); const saved = await response.json();
    assert.equal(saved.status, 'awaiting_payment'); assert.equal(f.store.operatorOrder(saved.orderId).address.postalCode, '');
    const omitted = await post({ ...request, address: { ...request.address, postalCode: undefined } });
    assert.equal(omitted.status, 201); assert.deepEqual(await omitted.json(), saved);
    for (const postalCode of [null, 123, false, {}, [], 'a'.repeat(201), 'bad\npostal', 'bad\tpostal', 'bad\u0000postal', 'bad\u007fpostal']) {
      const rejected = await post({ ...request, idempotencyKey: randomUUID(), address: { ...request.address, postalCode } });
      assert.equal(rejected.status, 400); assert.deepEqual(await rejected.json(), { error: 'Invalid delivery address' });
    }
    for (const field of ['name', 'line1', 'city', 'country']) {
      for (const value of [undefined, '', '   ']) {
        const rejected = await post({ ...request, idempotencyKey: randomUUID(), address: { ...request.address, [field]: value } });
        assert.equal(rejected.status, 400); assert.deepEqual(await rejected.json(), { error: 'Invalid delivery address' });
      }
    }
    assert.equal(f.store.list().length, 1);
    assert.equal(JSON.stringify(saved).includes(request.address.line1), false);
  } finally { await new Promise((resolve) => server.close(resolve)); f.cleanup(); }
});

test('stocked merchants atomically reserve and expire; on-demand merchants do not cap orders', () => {
  const c = config(); c.fulfillmentMode = 'stocked'; c.product.stock = 1; const f = fixture(c);
  try { const first = f.store.create(input()); assert.throws(() => f.store.create(input())); f.tick(30 * 60_000 + 1); assert.equal(f.store.get(first.orderId, first.recoveryToken).status, 'expired'); assert.doesNotThrow(() => f.store.create(input())); } finally { f.cleanup(); }
});

test('one durable signing lease prevents multiple tabs and ambiguous submitted retries', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); const lease = f.store.paymentAttempt(order.orderId, order.recoveryToken);
    assert.throws(() => f.store.paymentAttempt(order.orderId, order.recoveryToken));
    f.store.cancelAttempt(order.orderId, order.recoveryToken, lease.attemptToken);
    const second = f.store.paymentAttempt(order.orderId, order.recoveryToken);
    f.store.transactionHint(order.orderId, order.recoveryToken, '0x' + '1'.repeat(64));
    assert.throws(() => f.store.cancelAttempt(order.orderId, order.recoveryToken, second.attemptToken));
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'awaiting_payment');
  } finally { f.cleanup(); }
});

test('only correct finalized successful native transfer establishes payment; duplicate event consumed once', () => {
  const f = fixture(); try {
    const order = f.store.create(input());
    for (const patch of [{ successful: false }, { finalized: false }, { recipient: third }, { payer: third }, { assetId: '0x' + '3'.repeat(64) }, { chainGenesisHash: '0x' + '4'.repeat(64) }]) assert.equal(f.store.accept(evidence(order, patch)), false);
    assert.equal(f.store.accept(evidence(order)), true); assert.equal(f.store.accept(evidence(order)), false);
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'paid');
    assert.equal(f.store.pendingNotification().kind, 'paid');
  } finally { f.cleanup(); }
});

test('wrong amount and late payments are reviewable and refundable without fulfillment', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.tick(31 * 60_000);
    f.store.accept(evidence(order, { amountCodec: '42', finalizedAt: new Date(epoch + 31 * 60_000).toISOString() }));
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'shipping_review');
    f.store.claim(order.orderId, 'volunteer'); assert.throws(() => f.store.ship(order.orderId, 'volunteer', 'TRACK', true));
    const obligation = f.store.refund(order.orderId, 'volunteer'); assert.equal(obligation.amountCodec, '42'); assert.equal(obligation.recipient, alice);
  } finally { f.cleanup(); }
});

test('refund verifies full amount outgoing to original payer and cannot be recorded twice', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'a');
    assert.throws(() => f.store.claim(order.orderId, 'b'));
    const refund = f.store.refund(order.orderId, 'a'); assert.deepEqual(f.store.refund(order.orderId, 'a'), refund);
    const transfer = evidence(order, { payer: bob, recipient: alice, reference: refund.reference, amountCodec: refund.amountCodec, eventIndex: 2 });
    assert.equal(f.store.accept({ ...transfer, amountCodec: '1' }), false);
    assert.equal(f.store.accept(transfer), true); assert.equal(f.store.accept(transfer), false);
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'refunded');
    assert.throws(() => f.store.refund(order.orderId, 'a'));
  } finally { f.cleanup(); }
});

test('late exact payment needs explicit volunteer approval; shipment requires current ownership/review', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.tick(31 * 60_000); f.store.accept(evidence(order, { finalizedAt: new Date(epoch + 31 * 60_000).toISOString() }));
    f.store.claim(order.orderId, 'owner'); f.store.approve(order.orderId, 'owner');
    assert.throws(() => f.store.ship(order.orderId, 'owner', 'TRACK', false));
    f.store.ship(order.orderId, 'owner', 'TRACK', true);
    assert.equal(f.store.get(order.orderId, order.recoveryToken).tracking, 'TRACK');
    assert.throws(() => f.store.ship(order.orderId, 'owner', 'TRACK2', true));
  } finally { f.cleanup(); }
});

test('scanner recovers without browser hint and restart replay does not duplicate notifications', async () => {
  const f = fixture(); try {
    const order = f.store.create(input()); const chain = { head: async () => 100, block: async (number) => ({ number, transfers: [evidence(order)] }), assertConfiguration: async () => {}, close: async () => {} };
    await scanFinalized(f.store, chain); assert.equal(f.store.cursor(), 101);
    f.store.cursor(100); await scanFinalized(f.store, chain);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
    const reopened = new OrderStore(f.path, config(), key, () => epoch); try { assert.equal(reopened.get(order.orderId, order.recoveryToken).status, 'paid'); assert.equal(reopened.cursor(), 101); } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('notification failure is durably retried and never erases paid status', async () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order));
    await deliverNext(f.store, { send: async () => { throw new Error('offline'); } });
    assert.equal(f.store.get(order.orderId, order.recoveryToken).notificationStatus, 'retrying');
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'paid');
    assert.equal(f.store.pendingNotification(), undefined); f.tick(30_000);
    await deliverNext(f.store, { send: async () => {} });
    assert.equal(f.store.get(order.orderId, order.recoveryToken).notificationStatus, 'delivered');
  } finally { f.cleanup(); }
});

test('PII purge removes address and contact after terminal retention', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'owner'); f.store.ship(order.orderId, 'owner', 'TRACK', true);
    f.tick(31 * 86_400_000); assert.equal(f.store.purgePersonalData(), 1); assert.equal(f.store.list()[0].address.name, ''); assert.equal(f.store.list()[0].contact.value, '');
  } finally { f.cleanup(); }
});

test('encrypted backup restores cursor and recovery; wrong encryption key fails closed', async () => {
  const f = fixture(); const archive = join(dirname(f.path), 'backup.enc'); const restoredPath = join(dirname(f.path), 'restored.sqlite');
  try {
    const order = f.store.create(input()); f.store.cursor(105);
    await encryptedBackup(f.store, archive, Buffer.alloc(32, 9));
    assert.equal(readFileSync(archive, 'utf8').includes('SQLite'), false);
    await restoreBackup(archive, restoredPath, Buffer.alloc(32, 9));
    const restored = new OrderStore(restoredPath, config(), key, () => epoch); try { assert.equal(restored.cursor(), 105); assert.equal(restored.get(order.orderId, order.recoveryToken).status, 'awaiting_payment'); } finally { restored.close(); }
    assert.throws(() => new OrderStore(restoredPath, config(), Buffer.alloc(32, 8)));
  } finally { f.cleanup(); }
});

import { dirname } from 'node:path';
test('HTTP protects recovery/operator reads, CORS, readiness and payload size', async () => {
  const f = fixture(); const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rejected = await fetch(base + '/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: JSON.stringify(input()) }); assert.equal(rejected.status, 403);
    assert.equal((await fetch(base + '/v1/catalog')).status, 200); assert.equal((await (await fetch(base + '/v1/catalog')).json()).enabled, false);
    assert.equal((await fetch(base + '/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input()) })).status, 503);
    assert.equal((await fetch(base + '/v1/operator/orders')).status, 401);
    assert.equal((await fetch(base + '/v1/operator/orders', { headers: { Authorization: 'Bearer ' + 'o'.repeat(64) } })).status, 200);
    assert.equal((await fetch(base + '/v1/catalog?token=secret')).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); f.cleanup(); }
});

test('lost create response recovers using secret idempotency key without returning shipping PII', () => {
  const f = fixture(); try { const request = input(); const saved = f.store.create(request); assert.deepEqual(f.store.recoverCreate(request.idempotencyKey), saved); assert.equal(JSON.stringify(f.store.recoverCreate(request.idempotencyKey)).includes(request.address.line1), false); assert.throws(() => f.store.recoverCreate(randomUUID())); } finally { f.cleanup(); }
});

test('extra payment during pending refund remains reconcilable and refunds exact remaining amount', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'owner');
    const first = f.store.refund(order.orderId, 'owner');
    f.store.accept(evidence(order, { eventIndex: 3, amountCodec: '12' }));
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'refund_pending');
    assert.equal(f.store.accept(evidence(order, { eventIndex: 4, reference: first.reference, payer: bob, recipient: alice, amountCodec: first.amountCodec })), true);
    assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'shipping_review');
    const second = f.store.refund(order.orderId, 'owner'); assert.equal(second.amountCodec, '12'); assert.notEqual(first.reference, second.reference);
  } finally { f.cleanup(); }
});

test('additional payment after shipment can refund only excess, never ship or refund the fulfilled purchase twice', () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'owner'); f.store.ship(order.orderId, 'owner', 'TRACK', true);
    f.store.accept(evidence(order, { eventIndex: 5, amountCodec: '21' }));
    assert.throws(() => f.store.approve(order.orderId, 'owner'));
    assert.equal(f.store.refund(order.orderId, 'owner').amountCodec, '21');
  } finally { f.cleanup(); }
});

test('mismatched payments keep actual evidence private without publishing a false quote receipt', () => {
  const f = fixture(); try { const order = f.store.create(input()); f.store.accept(evidence(order, { amountCodec: '42' })); assert.equal(f.store.get(order.orderId, order.recoveryToken).receipt, undefined); assert.equal(f.store.paymentEvidence(order.orderId)[0].amountCodec, '42'); } finally { f.cleanup(); }
});

test('outbox lease is atomic across database connections and stale worker cannot acknowledge a new lease', () => {
  const f = fixture(); const second = new OrderStore(f.path, config(), key, f.store.now);
  try { const order = f.store.create(input()); f.store.accept(evidence(order)); const first = f.store.pendingNotification(); assert.equal(second.pendingNotification(), undefined); f.tick(60_001); const retry = second.pendingNotification(); assert.equal(retry.id, first.id); assert.notEqual(retry.claimToken, first.claimToken); f.store.finishNotification(first.id, first.claimToken, true); assert.equal(f.store.get(order.orderId, order.recoveryToken).notificationStatus, 'pending'); second.finishNotification(retry.id, retry.claimToken, true); assert.equal(f.store.get(order.orderId, order.recoveryToken).notificationStatus, 'delivered'); } finally { second.close(); f.cleanup(); }
});

test('refund signing lease survives repeated obligation reads and an ambiguous broadcast cannot be canceled', () => {
  const f = fixture(); try { const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'a'); f.store.refund(order.orderId, 'a'); const lease = f.store.refundAttempt(order.orderId, 'a'); assert.throws(() => f.store.refundAttempt(order.orderId, 'a')); f.store.cancelRefundAttempt(order.orderId, 'a', lease.attemptToken); const next = f.store.refundAttempt(order.orderId, 'a'); f.store.refundTransactionHint(order.orderId, 'a', next.attemptToken, '0x'+'1'.repeat(64)); assert.throws(() => f.store.cancelRefundAttempt(order.orderId, 'a', next.attemptToken)); assert.equal(f.store.get(order.orderId, order.recoveryToken).refund.attempt, undefined); } finally { f.cleanup(); }
});

test('generic exact-XOR merchant and mandatory post-payment shipping review do not inherit tea pricing policy', () => {
  const c = config(); c.pricing.kind = 'exact-xor'; c.pricing.jpyPerUsd = ''; c.pricing.fxSource = ''; c.pricing.fxDate = ''; c.product.priceXor = '2.5'; c.product.grams = 50; c.shipping[0].priceXor = '0.25'; c.reviewEveryPaidOrder = true;
  validateConfig(c); const f = fixture(c); try { const order = f.store.create(input()); assert.equal(order.paymentRequest.amountCodec, '2750000000000000000'); f.store.accept(evidence(order)); assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'shipping_review'); assert.equal(f.store.get(order.orderId, order.recoveryToken).reviewReason, 'shipping_check_required'); f.store.claim(order.orderId, 'a'); f.store.approve(order.orderId, 'a'); assert.equal(f.store.get(order.orderId, order.recoveryToken).status, 'paid'); } finally { f.cleanup(); }
});

import { createCatalogRefresher } from '../../dist/relay/index.js';
test('daily catalog refresh updates new quotes atomically and preserves saved orders on refresh failure', async () => {
  const c = config(); c.pricing.mode = 'daily'; c.providers = { fx: 'mufg-daily', shipping: 'japan-post-ems' }; const f = fixture(c);
  let time = new Date(epoch); let fail = false; let calls = 0; let shippingCalls = 0;
  const refresher = createCatalogRefresher(c, {
    clock: () => time,
    fx: async () => { calls++; return { jpyPerUsd: '160', publicationDate: '2026-09-25', publishedAt: '2026-09-25T09:00:00+09:00', fetchedAt: time.toISOString(), sourceUrl: 'https://example.test/mufg' }; },
    shipping: async () => { shippingCalls++; if (fail) throw new Error('offline'); return { version: 'ems1', fetchedAt: time.toISOString(), availabilityUpdatedLabel: 'September 25', sources: {}, bands: [{ zone: 1, maxGrams: 500, priceJpy: '1500' }], countries: [{ code: 'KR', zone: 1, service: 'accepted', requiresReview: false }, { code: 'US', zone: 1, service: 'restricted', requiresReview: true }] }; },
  });
  try {
    const saved = f.store.create(input()); const initialAmount = saved.paymentRequest.amountCodec;
    await refresher.refresh(); await refresher.refresh(); assert.equal(calls, 2); assert.equal(shippingCalls, 1); assert.equal(c.pricing.jpyPerUsd, '160'); assert.deepEqual(c.shipping[0].countries, ['KR']);
    assert.equal(f.store.get(saved.orderId, saved.recoveryToken).paymentRequest.amountCodec, initialAmount);
    time = new Date(epoch + 86_400_000); fail = true; await assert.rejects(() => refresher.refresh()); assert.equal(c.pricing.jpyPerUsd, '160'); assert.deepEqual(c.shipping[0].countries, ['KR']);
  } finally { f.cleanup(); }
});

import { telegramDelivery, emailDelivery } from '../../dist/relay/index.js';
test('Telegram delivery sends private order information only in POST body and handles API rejection', async () => {
  const f = fixture(); try {
    const order = f.store.create(input()); f.store.accept(evidence(order)); const job = f.store.pendingNotification(); let request;
    const delivery = telegramDelivery('12345:abcdEFG', '-123', async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    await delivery.send(job); assert.equal(request.options.method, 'POST'); assert.equal(request.url.includes(job.order.address.line1), false); const payload = JSON.parse(request.options.body); assert.equal(payload.chat_id, '-123'); assert.equal(payload.protect_content, true); assert.equal(payload.text.includes('Secret Delivery Street'), true);
    await assert.rejects(() => telegramDelivery('12345:abcdEFG', '-123', async () => new Response(JSON.stringify({ ok: false }), { status: 200 })).send(job));
    assert.throws(() => telegramDelivery('bad', '-123')); assert.throws(() => emailDelivery({ host: 'mail.example.test', port: 465, user: 'operator', password: 'secret', from: 'bad\r\nmail', to: 'operator@example.test' }));
  } finally { f.cleanup(); }
});

test('ready HTTP rejects oversized request bodies without creating a private order', async () => {
  const f = fixture(); const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => true }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try { const response = await fetch(base+'/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'a'.repeat(20_000) }) }); assert.equal(response.status, 413); assert.equal(f.store.list().length, 0); } finally { await new Promise((resolve) => server.close(resolve)); f.cleanup(); }
});

test('background expiry purges abandoned orders without any browser read', () => {
  const f = fixture(); try { const order = f.store.create(input()); f.tick(2 * 86_400_000); assert.equal(f.store.purgePersonalData(), 1); assert.equal(f.store.operatorOrder(order.orderId).address.name, ''); assert.equal(f.store.operatorOrder(order.orderId).status, 'expired'); } finally { f.cleanup(); }
});

test('notification retries cannot extend the post-shipment PII retention deadline', () => {
  const f = fixture(); try { const order = f.store.create(input()); f.store.accept(evidence(order)); f.store.claim(order.orderId, 'owner'); f.store.ship(order.orderId, 'owner', 'TRACK', true); f.tick(31 * 86_400_000); const job = f.store.pendingNotification(); f.store.finishNotification(job.id, job.claimToken, false); assert.equal(f.store.purgePersonalData(), 1); assert.equal(f.store.operatorOrder(order.orderId).contact.value, ''); } finally { f.cleanup(); }
});

import { createMufgDailyProvider } from '../../dist/providers/index.js';
test('midnight catalog does not hide the next MUFG publication while EMS remains cached once per JST day', async () => {
  const c = config(); c.pricing.mode = 'daily'; c.providers = { fx: 'mufg-daily', shipping: 'japan-post-ems' }; const f = fixture(c);
  let time = new Date('2026-09-25T00:00:00+09:00'); let fxFetches = 0; let shippingFetches = 0;
  const bank = createMufgDailyProvider({ clock: () => time, fetch: async () => {
    fxFetches++;
    const publishedToday = time.getTime() >= Date.parse('2026-09-25T10:26:00+09:00');
    const data = { G001DATE: publishedToday ? '2026/09/25 10:26' : '2026/09/24 10:26', G001TTSZ: publishedToday ? '161.00' : '151.00', G001TTBZ: publishedToday ? '159.00' : '149.00' };
    return new Response(`var kinri_deta = ${JSON.stringify(data)};`, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  } });
  const refresher = createCatalogRefresher(c, { clock: () => time, fx: () => bank.getSnapshot(), shipping: async () => {
    shippingFetches++;
    return { version: 'ems1', fetchedAt: time.toISOString(), availabilityUpdatedLabel: 'September 25', sources: {}, bands: [{ zone: 1, maxGrams: 500, priceJpy: '600' }], countries: [{ code: 'JP', zone: 1, service: 'accepted', requiresReview: false }] };
  } });
  try {
    await refresher.refresh(); assert.equal(c.pricing.fxDate, '2026-09-24'); assert.equal(c.pricing.jpyPerUsd, '150');
    const earlyOrder = f.store.create({ ...input(), shippingRateId: 'ems-zone-1-500' });
    time = new Date('2026-09-25T00:05:00+09:00'); await refresher.refresh(); assert.equal(fxFetches, 1);
    time = new Date('2026-09-25T10:26:00+09:00'); await refresher.refresh();
    assert.equal(fxFetches, 2); assert.equal(shippingFetches, 1); assert.equal(c.pricing.fxDate, '2026-09-25'); assert.equal(c.pricing.jpyPerUsd, '160');
    const lateOrder = f.store.create({ ...input(), shippingRateId: 'ems-zone-1-500' });
    assert.notEqual(lateOrder.paymentRequest.amountCodec, earlyOrder.paymentRequest.amountCodec);
    assert.equal(f.store.get(earlyOrder.orderId, earlyOrder.recoveryToken).paymentRequest.amountCodec, earlyOrder.paymentRequest.amountCodec);
  } finally { f.cleanup(); }
});

import { relayClientAddress } from '../../dist/relay/index.js';
test('proxy IP trust requires explicit loopback opt-in and ignores spoofed headers from direct peers', () => {
  assert.equal(relayClientAddress('192.0.2.10', '198.51.100.9', true), '192.0.2.10');
  assert.equal(relayClientAddress('192.0.2.10', 'malformed', true), '192.0.2.10');
  assert.equal(relayClientAddress('127.0.0.1', '198.51.100.9'), '127.0.0.1');
  assert.equal(relayClientAddress('127.0.0.1', '198.51.100.9', true), '198.51.100.9');
  assert.equal(relayClientAddress('::ffff:127.0.0.1', '::ffff:198.51.100.9', true), '198.51.100.9');
  assert.equal(relayClientAddress('0:0:0:0:0:0:0:1', '2001:0DB8:0:0:0:0:0:1', true), '2001:db8::1');
  for (const header of [undefined, ['192.0.2.1'], '192.0.2.1, 192.0.2.2', 'invalid', 'https://192.0.2.1', '192.0.2.1:1234', 'fe80::1%en0']) assert.throws(() => relayClientAddress('127.0.0.1', header, true));
});

test('trusted nginx clients have independent rate buckets and malformed proxy headers fail closed', async () => {
  const f = fixture(); const server = createRelayServer(f.store, { operatorToken: 'o'.repeat(64), ready: () => true, trustLoopbackProxy: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const get = (ip) => fetch(base+'/healthz', { headers: ip === undefined ? {} : { 'X-Sora-Pay-Client-IP': ip } });
  try {
    assert.equal((await get(undefined)).status, 400); assert.equal((await get('192.0.2.1,198.51.100.1')).status, 400);
    for (let index=0; index<240; index++) assert.equal((await get('192.0.2.1')).status, 200);
    assert.equal((await get('192.0.2.1')).status, 429);
    assert.equal((await get('198.51.100.1')).status, 200);
    assert.equal((await get('::ffff:192.0.2.1')).status, 429);
  } finally { await new Promise((resolve) => server.close(resolve)); f.cleanup(); }
});

test('exact-XOR public catalog excludes private fiat conversion and shipping audit fields', () => {
  const c = config(); c.pricing.kind = 'exact-xor'; c.pricing.mode = 'launch-fixed'; c.product.priceXor = '1.759225'; c.shipping[0].priceXor = '0.5'; c.sourceMetadata = { fx: { jpyPerUsd:'158.78',usdPerXor:'5.37' }, chain:{},shipping:{version:'ems-v1'} };
  const f = fixture(c); try {
    const catalog = f.store.catalog(); assert.deepEqual(catalog.pricing,{kind:'exact-xor',version:'fx-1'}); assert.equal(catalog.product.priceXor,'1.759225'); assert.equal(catalog.shipping[0].priceXor,'0.5');
    for (const field of ['jpyPerUsd','usdPerXor','fxSource','fxDate','priceJpy']) assert.equal(JSON.stringify(catalog).includes(field),false);
    assert.equal(catalog.sourceMetadata.fx,undefined); assert.equal(c.pricing.jpyPerUsd,'150'); assert.equal(c.shipping[0].priceJpy,'600');
  } finally { f.cleanup(); }
});

test('exact-XOR merchant refreshes only carrier availability and restores suspended bands at their fixed price', async () => {
  const c = config(); c.pricing.kind='exact-xor'; c.pricing.mode='launch-fixed'; c.product.priceXor='1.759225'; c.providers={fx:'mufg-daily',shipping:'japan-post-ems'};
  c.shipping=[{...c.shipping[0],id:'ems-zone-1-500',priceXor:'0.5'}];
  const f=fixture(c); let time=new Date(epoch); let accepted=true; let fxCalls=0; let carrierPrice='600';
  const refresher=createCatalogRefresher(c,{clock:()=>time,fx:async()=>{fxCalls++;throw new Error('Exact XOR must not fetch MUFG');},shipping:async()=>({version:'ems',fetchedAt:time.toISOString(),availabilityUpdatedLabel:'September 25',sources:{},bands:[{zone:1,maxGrams:500,priceJpy:carrierPrice}],countries:[{code:'JP',zone:1,service:accepted?'accepted':'suspended',requiresReview:!accepted}]})});
  try {
    await refresher.refresh(); const saved=f.store.create({...input(),shippingRateId:'ems-zone-1-500'}); assert.equal(saved.paymentRequest.amountCodec,'2259225000000000000');
    time=new Date(epoch+86_400_000);carrierPrice='1200';await refresher.refresh();assert.equal(c.shipping[0].priceXor,'0.5');assert.equal(c.product.priceXor,'1.759225');assert.equal(fxCalls,0);
    time=new Date(epoch+2*86_400_000);accepted=false;await refresher.refresh();assert.equal(c.shipping.length,0);
    time=new Date(epoch+3*86_400_000);accepted=true;await refresher.refresh();assert.equal(c.shipping[0].priceXor,'0.5');assert.equal(c.shipping[0].priceJpy,'600');assert.equal(fxCalls,0);
    assert.equal(f.store.get(saved.orderId,saved.recoveryToken).paymentRequest.amountCodec,'2259225000000000000');
  } finally {f.cleanup();}
});
