import { createHash } from 'node:crypto';
import { evidence, fetchOfficialText, SOURCES } from './http.js';
import type { FetchOptions, SourceEvidence } from './http.js';

export type EmsZone = 1 | 2 | 3 | 4 | 5;
export type EmsService = 'accepted' | 'restricted' | 'suspended' | 'unavailable';
export interface EmsRateBand { zone: EmsZone; maxGrams: number; priceJpy: string; }
export interface EmsCountry {
  code: string | null; name: string; zone: EmsZone | null; service: EmsService;
  coverage: string; ead: string; requiresReview: boolean; reasons: string[]; detailsUrl: string | null;
}
export interface JapanPostEmsSnapshot {
  version: string; carrier: 'Japan Post'; service: 'EMS'; currency: 'JPY'; fetchedAt: string;
  /** Exact source label; the source omits a year, so do not fabricate a publication timestamp. */
  availabilityUpdatedLabel: string;
  availabilityPreviousAnnouncement: string;
  tentativeSurchargesIncluded: true;
  sources: { rates: SourceEvidence; zones: SourceEvidence; availability: SourceEvidence; restrictionsUrl: string };
  bands: EmsRateBand[]; countries: EmsCountry[];
}

const ISO_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const isoSet = new Set(ISO_CODES);
const aliases: Record<string, string> = {
  'United States of America': 'US', 'Republic of Korea': 'KR', 'Hong Kong': 'HK', 'United Kingdom of Great Britain and Northern Ireland': 'GB',
  'Great Britain': 'GB', 'Antigua and Barbuda': 'AG', 'Bonaire, Saba and Sint Eustatius': 'BQ', 'Kyrgyz': 'KG', 'Ivory Coast': 'CI',
  'Comoros Islands': 'KM', 'Congo': 'CG', 'The Democratic Republic of the Congo': 'CD', 'Independent State of Samoa': 'WS',
  'Sao Tome and Principe': 'ST', 'St. Pierre and Miquelon': 'PM', 'Saint Maarten': 'SX', 'Saint Christopher and Nevis': 'KN',
  'Saint Vincent': 'VC', 'Saint Lucia': 'LC', 'Turks and Caicos': 'TC', 'Tanzania (United Rep.)': 'TZ', 'Czech Republic': 'CZ',
  'Central Africa': 'CF', 'Trinidad and Tobago': 'TT', 'Turkey': 'TR', 'French Southern and Antarctic Territories': 'TF',
  'Vatican': 'VA', 'East Timor': 'TL', 'Pitcairn': 'PN', 'Falkland': 'FK', 'Virgin Islands': 'VI', 'Bosnia and Herzegovina': 'BA',
  'Macao': 'MO', 'Federated States of Micronesia': 'FM', 'Myanmar': 'MM', "Lao People's Democratic Republic": 'LA',
  'Russian Federation': 'RU', 'Wallis and Futuna': 'WF', 'Solomon': 'SB',
};

/** Normalize official destination spelling solely for a deterministic ISO-country join. */
function normalizedName(value: string): string { return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, ''); }
const display = new Intl.DisplayNames(['en'], { type: 'region' });
const codeByName = new Map(ISO_CODES.map((code) => [normalizedName(display.of(code) ?? code), code]));
for (const [name, code] of Object.entries(aliases)) codeByName.set(normalizedName(name), code);

/** Return only ISO 3166-1 codes; non-country subregions remain visible but unquotable. */
export function officialCountryCode(name: string): string | null { return codeByName.get(normalizedName(name)) ?? null; }

/** Extract inert text from source markup; scripts, styles, and comments never become data. */
function inertHtml(source: string): string {
  if (source.length > 2_000_000) throw new Error('provider_body_too_large');
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}
function text(source: string): string {
  return source.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, value: string) => {
      const code = value[0]?.toLowerCase() === 'x' ? Number.parseInt(value.slice(1), 16) : Number.parseInt(value, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim();
}
function rows(source: string): string[][] {
  return [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...(row[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cell[1] ?? ''));
}

/** Parse all five published EMS price columns; these prices already include tentative surcharges. */
export function parseEmsRates(html: string): EmsRateBand[] {
  const source = inertHtml(html);
  if (!/tentative extra charges are included/i.test(text(source))) throw new Error('ems_surcharge_policy_changed');
  for (const label of ['First Zone', 'Second Zone', 'Third Zone', 'Fourth Zone', 'Fifth Zone']) if (!text(source).includes(label)) throw new Error('invalid_ems_columns');
  const bands: EmsRateBand[] = [];
  const seen = new Set<number>();
  for (const row of rows(source)) {
    const cells = row.map(text);
    const weight = /^Up to (\d+(?:\.\d{1,2})?)(kg|g)$/i.exec(cells[0] ?? '');
    if (!weight) continue;
    if (cells.length !== 6) throw new Error('invalid_ems_rate_row');
    const [whole = '0', fraction = ''] = (weight[1] ?? '').split('.');
    const weightUnits = BigInt(whole + fraction);
    const gramsScaled = weightUnits * (weight[2]?.toLowerCase() === 'kg' ? 1000n : 1n);
    const divisor = 10n ** BigInt(fraction.length);
    if (gramsScaled % divisor !== 0n) throw new Error('invalid_ems_weight');
    const maxGrams = Number(gramsScaled / divisor);
    if (maxGrams < 1 || maxGrams > 30_000 || seen.has(maxGrams)) throw new Error('invalid_ems_weight');
    seen.add(maxGrams);
    for (let zone = 1; zone <= 5; zone++) {
      const raw = cells[zone] ?? '';
      if (!/^\d{1,3}(?:,\d{3})*$|^\d{1,7}$/.test(raw)) throw new Error('invalid_ems_price');
      const priceJpy = raw.replace(/,/g, '');
      if (BigInt(priceJpy) < 1n || BigInt(priceJpy) > 1_000_000n) throw new Error('invalid_ems_price');
      bands.push({ zone: zone as EmsZone, maxGrams, priceJpy });
    }
  }
  if (!bands.length) throw new Error('missing_ems_rates');
  bands.sort((a, b) => a.maxGrams - b.maxGrams || a.zone - b.zone);
  for (let zone = 1; zone <= 5; zone++) {
    const zoneBands = bands.filter((band) => band.zone === zone);
    for (let i = 1; i < zoneBands.length; i++) if (BigInt(zoneBands[i]!.priceJpy) <= BigInt(zoneBands[i - 1]!.priceJpy)) throw new Error('invalid_ems_price_order');
  }
  return bands;
}

export interface EmsZoneEntry { code: string | null; name: string; zone: EmsZone; coverage: string; detailsUrl: string | null; }
/** Parse explicit country/zone assignments and retain region exclusions for human review. */
export function parseEmsZones(html: string): EmsZoneEntry[] {
  const source = inertHtml(html);
  const result: EmsZoneEntry[] = [];
  const zoneNumbers: Record<string, EmsZone> = { First: 1, Second: 2, Third: 3, Fourth: 4, Fifth: 5 };
  for (const table of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tableHtml = table[1] ?? '';
    if (!text(tableHtml).includes('Covered Area')) continue;
    const zoneLabel = /\b(First|Second|Third|Fourth|Fifth) Zone\b/.exec(text(tableHtml));
    const zone = zoneLabel?.[1] ? zoneNumbers[zoneLabel[1]] : undefined;
    if (!zone) throw new Error('unknown_ems_zone');
    for (const row of rows(tableHtml)) {
      if (row.some((cell) => text(cell) === 'Covered Area')) continue;
      if (row.length < 2 || row.length > 3) throw new Error('invalid_ems_zone_row');
      const name = text(row[row.length - 2] ?? '');
      const coverageHtml = row[row.length - 1] ?? '';
      const coverage = text(coverageHtml).replace(/\s+Details$/, '').trim();
      const link = /<a\b[^>]*href=["']([^"']+)["']/i.exec(coverageHtml)?.[1];
      const detailsUrl = link ? new URL(link, SOURCES.emsZones).href : null;
      if (detailsUrl && new URL(detailsUrl).origin !== 'https://www.post.japanpost.jp') throw new Error('invalid_ems_details_url');
      if (!name || !coverage) throw new Error('invalid_ems_zone_row');
      result.push({ code: officialCountryCode(name), name, zone, coverage, detailsUrl });
    }
  }
  if (!result.length) throw new Error('missing_ems_zones');
  return result;
}

export interface EmsAvailabilityEntry { code: string | null; name: string; service: EmsService; ead: string; }
/** Read the EMS column specifically; air letters and parcels are separate products. */
export function parseEmsAvailability(html: string): { entries: EmsAvailabilityEntry[]; updatedLabel: string; previousAnnouncement: string } {
  const source = inertHtml(html);
  const plain = text(source);
  const updatedLabel = /International mail service availability chart\s*\((Updated on [^)]+)\)/i.exec(plain)?.[1];
  if (!updatedLabel) throw new Error('missing_ems_availability_date');
  const previousAnnouncement = /since the announcement on\s+([A-Za-z]+ \d{1,2}, \d{4})/i.exec(plain)?.[1] ?? '';
  const entries: EmsAvailabilityEntry[] = [];
  for (const row of rows(source)) {
    const cells = row.map(text);
    if (cells.length !== 9 || !cells[0] || !['✓', '✔', '*', 'X', '-', '－'].includes(cells[7] ?? '')) continue;
    const symbol = cells[7];
    const service: EmsService = symbol === '✓' || symbol === '✔' ? 'accepted' : symbol === '*' ? 'restricted' : symbol === 'X' ? 'suspended' : 'unavailable';
    entries.push({ code: officialCountryCode(cells[0]), name: cells[0], service, ead: cells[8] ?? '' });
  }
  if (!entries.length) throw new Error('missing_ems_availability');
  return { entries, updatedLabel, previousAnnouncement };
}

/** Join published rates, destination zones and current EMS acceptance; ambiguous destinations stay closed. */
export function parseJapanPostEms(input: { rates: string; zones: string; availability: string }, now = new Date()): JapanPostEmsSnapshot {
  const bands = parseEmsRates(input.rates);
  const zones = parseEmsZones(input.zones);
  const availability = parseEmsAvailability(input.availability);
  const countries: EmsCountry[] = availability.entries.map((entry) => {
    const matches = entry.code ? zones.filter((zone) => zone.code === entry.code) : [];
    const zone = matches.length === 1 ? matches[0] : undefined;
    const reasons: string[] = [];
    if (!entry.code) reasons.push('unmapped_region');
    if (!zone) reasons.push('unconfirmed_zone');
    if (entry.service !== 'accepted') reasons.push(`carrier_${entry.service}`);
    if (zone && zone.coverage !== 'All areas') reasons.push('limited_delivery_area');
    return { ...entry, zone: zone?.zone ?? null, coverage: zone?.coverage ?? '', detailsUrl: zone?.detailsUrl ?? null, requiresReview: reasons.length > 0, reasons };
  });
  // A destination listed by the zone table but absent from availability is never assumed accepted.
  for (const zone of zones) if (!countries.some((entry) => entry.code && entry.code === zone.code)) {
    countries.push({ code: zone.code, name: zone.name, zone: zone.zone, service: 'unavailable', coverage: zone.coverage, ead: '', detailsUrl: zone.detailsUrl, requiresReview: true, reasons: ['missing_availability'] });
  }
  const contentHash = createHash('sha256').update(JSON.stringify({ bands, countries, updatedLabel: availability.updatedLabel })).digest('hex').slice(0, 16);
  return {
    version: `japan-post-ems-${contentHash}`, carrier: 'Japan Post', service: 'EMS', currency: 'JPY', fetchedAt: now.toISOString(),
    availabilityUpdatedLabel: availability.updatedLabel, availabilityPreviousAnnouncement: availability.previousAnnouncement,
    tentativeSurchargesIncluded: true,
    sources: { rates: evidence(input.rates, SOURCES.emsRates, now), zones: evidence(input.zones, SOURCES.emsZones, now), availability: evidence(input.availability, SOURCES.emsAvailability, now), restrictionsUrl: SOURCES.emsRestrictions },
    bands, countries,
  };
}

/** Download a complete official snapshot, rejecting truncated tables and unmatched active destinations. */
export async function fetchJapanPostEms(options: FetchOptions = {}): Promise<JapanPostEmsSnapshot> {
  const now = options.now ?? new Date();
  const [rates, zones, availability] = await Promise.all([SOURCES.emsRates, SOURCES.emsZones, SOURCES.emsAvailability].map((url) => fetchOfficialText(url, { ...options, now })));
  if (!rates || !zones || !availability) throw new Error('missing_ems_source');
  const snapshot = parseJapanPostEms({ rates: rates.text, zones: zones.text, availability: availability.text }, now);
  const expectedWeights = [500, 600, 700, 800, 900, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, ...Array.from({ length: 24 }, (_, i) => (i + 7) * 1000)];
  if (snapshot.bands.length !== expectedWeights.length * 5 || expectedWeights.some((weight) => snapshot.bands.filter((band) => band.maxGrams === weight).length !== 5) || snapshot.countries.length < 200 || parseEmsZones(zones.text).length < 100) throw new Error('incomplete_ems_snapshot');
  if (snapshot.countries.some((country) => country.service === 'accepted' && !country.code)) throw new Error('unmapped_accepted_ems_destination');
  snapshot.sources.rates = rates.evidence; snapshot.sources.zones = zones.evidence; snapshot.sources.availability = availability.evidence;
  return snapshot;
}

/** Carrier status is not a legal tea-import approval. Only explicit merchant-approved ISO countries produce rates. */
export function buildApprovedEmsRates(snapshot: JapanPostEmsSnapshot, approvedCountries: readonly string[]): Array<{ id: string; countries: string[]; maxGrams: number; priceJpy: string; label: string; reviewedAt: string }> {
  const approved = new Set(approvedCountries);
  if (approved.size !== approvedCountries.length || approvedCountries.some((code) => !isoSet.has(code))) throw new Error('invalid_approved_countries');
  return snapshot.bands.flatMap((band) => {
    const countries = snapshot.countries.filter((country) => country.code && approved.has(country.code) && country.zone === band.zone && country.service === 'accepted' && !country.requiresReview).map((country) => country.code!).sort();
    return countries.length ? [{ id: `ems-zone-${band.zone}-${band.maxGrams}`, countries, maxGrams: band.maxGrams, priceJpy: band.priceJpy, label: `Japan Post EMS · up to ${band.maxGrams} g`, reviewedAt: snapshot.fetchedAt.slice(0, 10) }] : [];
  });
}

/** Build broad worldwide carrier rates, excluding carrier restrictions and the merchant's explicit denylist. */
export function buildAvailableEmsRates(snapshot: JapanPostEmsSnapshot, blockedCountries: readonly string[] = []): ReturnType<typeof buildApprovedEmsRates> {
  if (blockedCountries.some((code) => !isoSet.has(code))) throw new Error('invalid_blocked_countries');
  const blocked = new Set(blockedCountries);
  const available = snapshot.countries.filter((country) => country.code && !blocked.has(country.code) && country.service === 'accepted' && !country.requiresReview).map((country) => country.code!);
  return buildApprovedEmsRates(snapshot, available);
}
