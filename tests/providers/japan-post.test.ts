import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildAvailableEmsRates, buildApprovedEmsRates, fetchJapanPostEms, officialCountryCode, parseEmsAvailability, parseEmsRates, parseEmsZones, parseJapanPostEms } from '../../dist/providers/japan-post.js';
import type { JapanPostEmsSnapshot } from '../../dist/providers/japan-post.js';

const now = new Date('2026-09-25T07:00:00Z');
const rates = '<p>For Zones 3 and 4, tentative extra charges are included.</p><table><tr><th>Weight</th><th>First Zone</th><th>Second Zone</th><th>Third Zone</th><th>Fourth Zone</th><th>Fifth Zone</th></tr><tr><td colspan="2">Up to 500g</td><td>1,450</td><td>1,900</td><td>3,150</td><td>3,900</td><td>3,600</td></tr><tr><td>Up to 1.25kg</td><td>2,500</td><td>3,500</td><td>5,000</td><td>5,990</td><td>5,850</td></tr></table>';
const zones = '<table><tr><th>Zone Name</th><th>Country/Area Names</th><th>Covered Area</th></tr><tr><td rowspan="2">Third Zone (Oceania)</td><td>Australia</td><td>All areas</td></tr><tr><td>Cook Islands</td><td>Available in some areas; Rarotonga only.</td></tr></table><table><tr><th>Zone Name</th><th>Country/Area Names</th><th>Covered Area</th></tr><tr><td>Fourth Zone</td><td>United States of America</td><td>All areas</td></tr></table>';
function country(name: string, status: string): string { return `<tr><td>${name}</td><td>✓</td><td>X</td><td>✓</td><td>✓</td><td>X</td><td>✓</td><td>${status}</td><td>Mandatory</td></tr>`; }
const availability = '<h2>International mail service availability chart (Updated on September 2)</h2><p>The countries/territories whose status has changed since the announcement on June 26, 2026 are indicated in light blue.</p><table>' + country('Australia', '✓') + country('United States of America', '*') + country('Cook Islands', '✓') + country('New Caledonia', 'X') + country('Afghanistan', '-') + '</table>';

describe('Japan Post EMS official table parsers', () => {
  it('parses all five prices and fractional kg boundaries without double-adding tentative charges', () => {
    const parsed = parseEmsRates(rates);
    assert.equal(parsed.length, 10);
    assert.deepEqual(parsed.find((band) => band.zone === 4 && band.maxGrams === 500), { zone: 4, maxGrams: 500, priceJpy: '3900' });
    assert.deepEqual(parsed.find((band) => band.zone === 3 && band.maxGrams === 1250), { zone: 3, maxGrams: 1250, priceJpy: '5000' });
  });
  it('fails closed when headers, price order, or the surcharge policy changes', () => {
    for (const source of [rates.replace('tentative extra charges are included', 'tentative extra charges are excluded'), rates.replace('Fourth Zone', 'Fourth'), rates.replace('3,150', '999,999'), rates.replace('Up to 1.25kg', 'Up to 500g')]) assert.throws(() => parseEmsRates(source));
  });
  it('joins multirow zones to official ISO names and preserves delivery-area limitations', () => {
    const parsed = parseEmsZones(zones);
    assert.deepEqual(parsed.map((entry) => [entry.code, entry.zone]), [['AU', 3], ['CK', 3], ['US', 4]]);
    assert.equal(parsed[1]?.coverage, 'Available in some areas; Rarotonga only.');
    assert.equal(officialCountryCode('Republic of Korea'), 'KR');
    assert.equal(officialCountryCode('Viet Nam'), 'VN');
    assert.equal(officialCountryCode('Reunion'), 'RE');
    assert.equal(officialCountryCode('Saipan'), null);
  });
  it('does not confuse letter/parcel acceptance with the EMS service column', () => {
    const parsed = parseEmsAvailability(availability);
    assert.deepEqual(parsed.entries.map((entry) => entry.service), ['accepted', 'restricted', 'accepted', 'suspended', 'unavailable']);
    assert.equal(parsed.updatedLabel, 'Updated on September 2');
    assert.equal(parsed.previousAnnouncement, 'June 26, 2026');
  });
  it('preserves restrictions and never silently enables limited-area, suspended, or unknown destinations', () => {
    const result = parseJapanPostEms({ rates, zones, availability }, now);
    const us = result.countries.find((country) => country.code === 'US')!;
    assert.equal(us.requiresReview, true); assert.ok(us.reasons.includes('carrier_restricted'));
    assert.equal(result.countries.find((country) => country.code === 'CK')?.requiresReview, true);
    assert.equal(result.countries.find((country) => country.code === 'AU')?.requiresReview, false);
    assert.equal(result.countries.find((country) => country.code === 'NC')?.zone, null);
    const approved = buildApprovedEmsRates(result, ['AU', 'US', 'CK', 'NC']);
    assert.equal(approved.length, 2);
    assert.deepEqual(approved[0]?.countries, ['AU']);
    assert.equal(approved[0]?.priceJpy, '3150');
  });
  it('supports worldwide carrier acceptance with an explicit denylist and no compulsory approval list', () => {
    const snapshot = parseJapanPostEms({ rates, zones, availability }, now);
    const available = buildAvailableEmsRates(snapshot);
    assert.deepEqual(available[0]?.countries, ['AU']);
    assert.equal(available[0]?.reviewedAt, '2026-09-25');
    assert.deepEqual(buildAvailableEmsRates(snapshot, ['AU']), []);
    assert.throws(() => buildAvailableEmsRates(snapshot, ['Australia']), /invalid_blocked_countries/);
  });
  it('requires explicit valid merchant country approvals, independently of carrier coverage', () => {
    const result = parseJapanPostEms({ rates, zones, availability }, now);
    assert.deepEqual(buildApprovedEmsRates(result, []), []);
    assert.throws(() => buildApprovedEmsRates(result, ['Australia']), /invalid_approved_countries/);
    assert.throws(() => buildApprovedEmsRates(result, ['AU', 'AU']), /invalid_approved_countries/);
  });
  it('keeps semantic source version stable on refetch instead of fabricating a new publication date', () => {
    const first = parseJapanPostEms({ rates, zones, availability }, now);
    const later = parseJapanPostEms({ rates, zones, availability }, new Date('2026-09-26T00:00:00Z'));
    assert.equal(first.version, later.version); assert.notEqual(first.fetchedAt, later.fetchedAt);
    assert.equal(first.availabilityUpdatedLabel, later.availabilityUpdatedLabel);
  });
  it('ignores scripts/comments as inert content and rejects off-domain detail URLs', () => {
    const parsed = parseEmsRates(`<script>${rates}</script>${rates}`);
    assert.equal(parsed.length, 10);
    assert.throws(() => parseEmsZones(zones.replace('Rarotonga only.', 'Rarotonga only.<a href="https://evil.invalid/">Details</a>')), /invalid_ems_details_url/);
  });
  it('rejects incomplete live tables instead of publishing a small accidental destination subset', async () => {
    await assert.rejects(fetchJapanPostEms({ now, fetch: async (url) => new Response(String(url).includes('list-ems') ? rates : String(url).includes('/country/') ? zones : availability, { headers: { 'content-type': 'text/html' } }) }), /incomplete_ems_snapshot/);
  });
  it('ships a full official source snapshot with all 210 rate bands and explicit US restrictions', async () => {
    const snapshot = JSON.parse(await readFile(new URL('../../packages/providers/data/japan-post-ems.json', import.meta.url), 'utf8')) as JapanPostEmsSnapshot;
    assert.equal(snapshot.bands.length, 210);
    assert.ok(snapshot.countries.length >= 200);
    assert.equal(snapshot.countries.find((country) => country.code === 'US')?.service, 'restricted');
    assert.equal(snapshot.sources.rates.sha256.length, 64);
    assert.equal(snapshot.tentativeSurchargesIncluded, true);
    const codes = snapshot.countries.map((country) => country.code).filter(Boolean);
    assert.equal(codes.length, new Set(codes).size);
  });
});
