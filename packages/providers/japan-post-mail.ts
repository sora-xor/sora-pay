import { createHash } from 'node:crypto';
import { evidence, fetchOfficialText, SOURCES } from './http.js';
import type { FetchOptions, SourceEvidence } from './http.js';
import { inertHtml, text, rows, officialCountryCode, parseEmsAvailability } from './japan-post.js';
import type { EmsService, EmsZone } from './japan-post.js';

export const INTERNATIONAL_POSTAL_SERVICES = ['ems', 'parcel-air', 'parcel-surface', 'small-packet-air', 'small-packet-surface'] as const;
type InternationalPostalService = typeof INTERNATIONAL_POSTAL_SERVICES[number];
export const POSTAL_SERVICES = [...INTERNATIONAL_POSTAL_SERVICES, 'letter-pack-plus'] as const;
export type PostalService = typeof POSTAL_SERVICES[number];
/** An explicit reviewed service; a restricted route requires an operational review tied to the carrier snapshot. */
export interface PostalRoute { service: PostalService; restrictedReviewVersion?: string; availabilityCountry?: string; }
export interface PostalCountry { code: string | null; name: string; services: Record<InternationalPostalService, EmsService>; }
export interface JapanPostAvailabilitySnapshot {
  version: string; fetchedAt: string; availabilityUpdatedLabel: string;
  countries: PostalCountry[]; sources: { availability: SourceEvidence; restrictionsUrl: string };
}
export interface PostalRateBand { service: Exclude<PostalService, 'ems' | 'letter-pack-plus'>; zone: EmsZone; maxGrams: number; priceJpy: string; }

/** Carrier spellings absent from Intl.DisplayNames, including the operational Kosovo code. */
function postalCountryCode(name: string): string | null {
  const aliases: Record<string, string> = { Kosovo: 'XK', Korea: 'KR', 'Turks and Caicos Islands': 'TC', 'Bermuda Islands': 'BM', Surinam: 'SR', 'Falkland Islands (Islas Malvinas)': 'FK', 'Caribbean Netherlands (Bonaire, Saba and Sint Eustatius)': 'BQ', 'Portugal (including Azores and Madeira Islands ）': 'PT' };
  return officialCountryCode(name) ?? aliases[name] ?? null;
}

/** Keep letter-post, parcel and EMS columns separate; SAL remains outside the supported services. */
export function parseJapanPostAvailability(html: string, now = new Date()): JapanPostAvailabilitySnapshot {
  const source = inertHtml(html);
  const meta = parseEmsAvailability(source);
  const countries: PostalCountry[] = [];
  const columns: Record<InternationalPostalService, number> = { ems: 7, 'parcel-air': 4, 'parcel-surface': 6, 'small-packet-air': 1, 'small-packet-surface': 3 };
  for (const row of rows(source)) {
    const cells = row.map(text);
    if (cells.length !== 9 || !cells[0] || !['✓', '✔', '*', 'X', '-', '－'].includes(cells[7] ?? '')) continue;
    const services = {} as Record<InternationalPostalService, EmsService>;
    for (const service of INTERNATIONAL_POSTAL_SERVICES) {
      const symbol = cells[columns[service]];
      if (!['✓', '✔', '*', 'X', '-', '－'].includes(symbol ?? '')) throw new Error('invalid_postal_service_symbol');
      services[service] = symbol === '✓' || symbol === '✔' ? 'accepted' : symbol === '*' ? 'restricted' : symbol === 'X' ? 'suspended' : 'unavailable';
    }
    countries.push({ code: postalCountryCode(cells[0]), name: cells[0], services });
  }
  const codes = countries.flatMap((country) => country.code ? [country.code] : []);
  if (new Set(codes).size !== codes.length) throw new Error('duplicate_postal_country');
  const hash = createHash('sha256').update(JSON.stringify({ countries, date: meta.updatedLabel })).digest('hex').slice(0, 16);
  return { version: `japan-post-mail-${hash}`, fetchedAt: now.toISOString(), availabilityUpdatedLabel: meta.updatedLabel, countries,
    sources: { availability: evidence(html, SOURCES.emsAvailability, now), restrictionsUrl: SOURCES.emsRestrictions } };
}

/** Daily carrier status never changes a merchant's frozen prices or adds a new destination. */
export async function fetchJapanPostAvailability(options: FetchOptions = {}): Promise<JapanPostAvailabilitySnapshot> {
  const result = await fetchOfficialText(SOURCES.emsAvailability, options);
  const snapshot = parseJapanPostAvailability(result.text, options.now);
  if (snapshot.countries.length < 200) throw new Error('incomplete_postal_availability');
  snapshot.sources.availability = result.evidence;
  return snapshot;
}

/** Restricted acceptance is allowed only for the reviewed source revision, never a later unknown restriction. */
export function postalRouteAvailable(snapshot: JapanPostAvailabilitySnapshot, country: string, route: PostalRoute): boolean {
  // Letter Pack is domestic-only and has no row in the international suspension chart.
  if (route.service === 'letter-pack-plus') return country === 'JP' && route.availabilityCountry === undefined;
  const entry = snapshot.countries.find((item) => item.code === country)
    ?? snapshot.countries.find((item) => item.code === route.availabilityCountry);
  const status = entry?.services[route.service];
  return status === 'accepted' || (status === 'restricted' && route.restrictedReviewVersion === snapshot.version);
}

/** Parse exact published weights and yen amounts, including existing surcharges once only. */
function rateRow(cells: string[]): { maxGrams: number; priceJpy: string } | undefined {
  const index = cells.findIndex((cell) => /^Up to /.test(cell));
  if (index < 0) return;
  const match = /^Up to (\d+)(?:\.(\d{1,3}))?(kg|g)$/.exec(cells[index]!);
  const price = cells[index + 1]?.replace(/yen$/, '').trim();
  if (!match || !price || !/^(?:\d{1,3}(?:,\d{3})*|\d{1,7})$/.test(price)) throw new Error('invalid_postal_rate');
  const fraction = match[2] ?? '';
  const numerator = BigInt(match[1] + fraction) * (match[3] === 'kg' ? 1000n : 1n);
  const scale = 10n ** BigInt(fraction.length);
  const maxGrams = Number(numerator / scale), priceJpy = price.replace(/,/g, '');
  if (numerator % scale || maxGrams < 1 || maxGrams > 30_000 || BigInt(priceJpy) < 1n || BigInt(priceJpy) > 1_000_000n) throw new Error('invalid_postal_rate');
  return { maxGrams, priceJpy };
}

/** Extract only ordinary parcels or small packets; printed matter and D-mail are never goods quotes. */
export function parsePostalRates(html: string, zone: EmsZone, kind: 'parcel' | 'small-packet'): PostalRateBand[] {
  const source = inertHtml(html), result: PostalRateBand[] = [];
  const zoneName = ['First', 'Second', 'Third', 'Fourth', 'Fifth'][zone - 1];
  if (!new RegExp(`Rate schedule \\((?:International Parcel Post|Letter-Post)\\s*:\\s*${zoneName} Zone\\)`, 'i').test(text(source))) throw new Error('invalid_postal_zone');
  if (kind === 'parcel' && (zone === 3 || zone === 4) && !/Air parcels include tentative extra charges/i.test(text(source))) throw new Error('postal_surcharge_policy_changed');
  let heading = '';
  for (const token of source.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>|<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (token[1] !== undefined) { heading = text(token[1]); continue; }
    const table = token[2]!, tableRows = rows(table).map((row) => row.map(text));
    const header = kind === 'parcel' ? heading : tableRows[0]?.[0];
    if (header !== 'Airmail' && header !== 'Surface Mail') continue;
    if (kind === 'small-packet' && !tableRows.some((row) => row[0] === 'Small Packets')) continue;
    const service = `${kind}-${header === 'Airmail' ? 'air' : 'surface'}` as PostalRateBand['service'];
    for (const row of tableRows) {
      const rate = rateRow(row);
      if (rate) result.push({ service, zone, ...rate });
    }
  }
  for (const suffix of ['air', 'surface']) {
    const selected = result.filter((band) => band.service === `${kind}-${suffix}`);
    const expected = kind === 'parcel' ? Array.from({ length: 30 }, (_, i) => (i + 1) * 1000) : suffix === 'air' ? Array.from({ length: 20 }, (_, i) => (i + 1) * 100) : [100, 250, 500, 1000, 2000];
    if (selected.length !== expected.length || selected.some((band, i) => band.maxGrams !== expected[i] || (i > 0 && BigInt(band.priceJpy) <= BigInt(selected[i - 1]!.priceJpy)))) throw new Error('incomplete_postal_rates');
  }
  return result;
}

/** Join the carrier's published zone list without geographic guesses or EMS coverage assumptions. */
export function parsePostalZoneCountries(html: string, zone: EmsZone): Array<{ code: string | null; name: string; zone: EmsZone }> {
  const result: Array<{ code: string | null; name: string; zone: EmsZone }> = [];
  for (const table of inertHtml(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (!text(table[1]!).includes('Country/Area Names')) continue;
    for (const row of rows(table[1]!)) {
      const cells = row.map(text), name = cells.at(-1);
      if (!name || name === 'Country/Area Names') continue;
      result.push({ code: postalCountryCode(name), name, zone });
    }
  }
  if (!result.length) throw new Error('missing_postal_zone_countries');
  return result;
}
