import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCatalogRefresher, validateConfig, OrderStore, type MerchantConfig } from '../../dist/relay/index.js';
import { parseJapanPostAvailability } from '../../dist/providers/japan-post-mail.js';

const template = JSON.parse(readFileSync(new URL('../../deploy/merchant.polkaswap.json.example', import.meta.url), 'utf8')) as MerchantConfig;
const chart = (active = true) => parseJapanPostAvailability(`<h2>International mail service availability chart (Updated on September 2)</h2><table><tr><td>France</td><td>✓</td><td>X</td><td>✓</td><td>${active ? '✓' : 'X'}</td><td>X</td><td>✓</td><td>✓</td><td>Mandatory</td></tr></table>`);
function config(): MerchantConfig {
  return validateConfig({ ...structuredClone(template), enabled: true, approvedShippingCountries: ['FR'], providers: { shipping: 'japan-post' }, shipping: [{ id: 'fr-air-1000', carrier: { service: 'parcel-air' }, countries: ['FR'], maxGrams: 1000, priceXor: '4.515344', label: 'Japan Post Air Parcel', reviewedAt: '2026-09-27' }] });
}

test('daily service suspension and restoration preserve fixed XOR prices, country scope and legal weight caps', async () => {
  const c = config(); let time = new Date('2026-09-27T00:00:00Z'), active = true, calls = 0;
  const refresh = createCatalogRefresher(c, { clock: () => time, postal: async () => { calls++; return chart(active); }, fx: async () => { throw new Error('Frozen prices must never request FX'); }, shipping: async () => { throw new Error('Must not use EMS availability for parcels'); } });
  await Promise.all([refresh.refresh(), refresh.refresh()]); assert.equal(calls, 1);
  const original = structuredClone(c.shipping); assert.equal(c.shipping[0]?.priceXor, '4.515344');
  time = new Date('2026-09-28T00:00:00Z'); active = false; await refresh.refresh(); assert.deepEqual(c.shipping, []);
  time = new Date('2026-09-29T00:00:00Z'); active = true; await refresh.refresh(); assert.deepEqual(c.shipping, original);
  const store = new OrderStore(':memory:', c, Buffer.alloc(32, 7));
  try { assert.equal('carrier' in store.catalog().shipping[0]!, false); } finally { store.close(); }
});

test('carrier failures retry without partially publishing a new catalog and malformed service config fails', async () => {
  const c = config(), original = structuredClone(c.shipping); let calls = 0;
  const refresh = createCatalogRefresher(c, { postal: async () => { if (++calls === 1) throw new Error('offline'); return chart(); } });
  await assert.rejects(refresh.refresh(), /offline/); assert.deepEqual(c.shipping, original);
  await refresh.refresh(); assert.equal(calls, 2);
  for (const carrier of [undefined, { service: 'letter' }, { service: 'ems', restrictedReviewVersion: 'yes' }, { service: 'ems', availabilityCountry: 'ZZ' }]) {
    const candidate = config(); Object.assign(candidate.shipping[0]!, { carrier }); assert.throws(() => validateConfig(candidate));
  }
});
