import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJapanPostAvailability, postalRouteAvailable, parsePostalRates, parsePostalZoneCountries, fetchJapanPostAvailability } from '../../dist/providers/japan-post-mail.js';

const row = (name: string, statuses: string[]) => `<tr><td>${name}</td>${statuses.map((s) => `<td>${s}</td>`).join('')}<td>Mandatory</td></tr>`;
const html = (content: string) => '<h2>International mail service availability chart (Updated on September 2)</h2><table>' + content + '</table>';
const available = html(row('France', ['✓', 'X', '✓', '✓', 'X', '✓', '✓']) + row('Fiji', ['X', 'X', '✓', 'X', 'X', '✓', 'X']) + row('United States of America', ['*', 'X', '*', '*', 'X', '*', '*']));

test('postal services stay independent, and restricted merchandise requires the exact reviewed snapshot', () => {
  const snapshot = parseJapanPostAvailability(available);
  assert.equal(postalRouteAvailable(snapshot, 'JP', { service: 'letter-pack-plus' }), true);
  assert.equal(postalRouteAvailable(snapshot, 'US', { service: 'letter-pack-plus' }), false);
  assert.equal(postalRouteAvailable(snapshot, 'FR', { service: 'parcel-air' }), true);
  assert.equal(postalRouteAvailable(snapshot, 'FJ', { service: 'ems' }), false);
  assert.equal(postalRouteAvailable(snapshot, 'FJ', { service: 'parcel-surface' }), true);
  assert.equal(postalRouteAvailable(snapshot, 'US', { service: 'ems' }), false);
  assert.equal(postalRouteAvailable(snapshot, 'US', { service: 'ems', restrictedReviewVersion: snapshot.version }), true);
  assert.equal(postalRouteAvailable({ ...snapshot, version: snapshot.version + '-changed' }, 'US', { service: 'ems', restrictedReviewVersion: snapshot.version }), false);
  assert.equal(postalRouteAvailable(snapshot, 'ZZ', { service: 'parcel-air' }), false);
  assert.equal(postalRouteAvailable(snapshot, 'MF', { service: 'parcel-air', availabilityCountry: 'FR' }), true);
  const ownTerritory = { ...snapshot, countries: [...snapshot.countries, { code: 'MF', name: 'Saint Martin', services: { ...snapshot.countries[0]!.services, 'parcel-air': 'suspended' as const } }] };
  assert.equal(postalRouteAvailable(ownTerritory, 'MF', { service: 'parcel-air', availabilityCountry: 'FR' }), false);
  assert.throws(() => parseJapanPostAvailability(available.replace('<td>✓</td>', '<td>?</td>')), /invalid_postal_service_symbol/);
  assert.throws(() => parseJapanPostAvailability(available.replace('</table>', row('France', ['✓', 'X', '✓', '✓', 'X', '✓', '✓']) + '</table>')), /duplicate_postal_country/);
});

test('incomplete live charts fail closed, while refetching identical status does not invalidate reviewed restrictions', async () => {
  assert.equal(parseJapanPostAvailability(available, new Date('2026-01-01')).version, parseJapanPostAvailability(available, new Date('2026-09-27')).version);
  await assert.rejects(fetchJapanPostAvailability({ fetch: async () => new Response(available, { headers: { 'content-type': 'text/html' } }) }), /incomplete_postal_availability/);
});

test('all five parcel/small-packet tables retain exact prices, boundaries and current surcharge amounts', () => {
  for (let zone = 1; zone <= 5; zone++) {
    for (const kind of ['parcel', 'normal'] as const) {
      const source = readFileSync(new URL(`../fixtures/japan-post/${kind}-zone${zone}.html`, import.meta.url), 'utf8');
      const bands = parsePostalRates(source, zone as 1, kind === 'parcel' ? 'parcel' : 'small-packet');
      assert.equal(bands.length, kind === 'parcel' ? 60 : 25);
      if (zone === 3 && kind === 'parcel') assert.deepEqual(bands[0], { service: 'parcel-air', zone: 3, maxGrams: 1000, priceJpy: '3850' });
      if (zone === 1 && kind === 'normal') assert.deepEqual(bands.find((band) => band.maxGrams === 200), { service: 'small-packet-air', zone: 1, maxGrams: 200, priceJpy: '450' });
      assert.throws(() => parsePostalRates(source.replaceAll('Up to 2.0kg', 'Up to 1.0kg'), zone as 1, kind === 'parcel' ? 'parcel' : 'small-packet'));
    }
  }
});

test('zone lists require explicit table entries, preserving unknown subregions for manual mapping', () => {
  assert.deepEqual(parsePostalZoneCountries('<table><tr><th>Country/Area Names</th></tr><tr><td>Third Zone</td><td>Iceland</td></tr><tr><td>Unknown islands</td></tr></table>', 3), [
    { code: 'IS', name: 'Iceland', zone: 3 }, { code: null, name: 'Unknown islands', zone: 3 },
  ]);
  assert.throws(() => parsePostalZoneCountries('<table><tr><td>Iceland</td></tr></table>', 3), /missing_postal_zone_countries/);
});
