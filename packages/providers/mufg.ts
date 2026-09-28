import { fromCodec } from '../core/index.js';
import { evidence, fetchOfficialText, SOURCES } from './http.js';
import type { FetchOptions, SourceEvidence } from './http.js';

/** Snapshot of USD TTS/TTB from MUFG; the midpoint is derived, not a claimed published TTM. */
export interface MufgUsdJpySnapshot {
  version: 1;
  provider: 'MUFG';
  method: 'derived-midpoint-of-tts-ttb';
  jpyPerUsd: string;
  tts: string;
  ttb: string;
  publicationDate: string;
  publishedAt: string;
  fetchedAt: string;
  sourceUrl: string;
  referenceUrl: string;
  evidence: SourceEvidence;
}

/** Return the calendar date in Japan for daily refresh and bank-holiday freshness. */
export function jstDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_provider_clock');
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Parse decimal bank quotes into a common exact scale. */
function bankUnits(value: unknown): { text: string; units: bigint } {
  if (typeof value !== 'string' || !/^\s*\d{1,4}\.\d{2,6}\s*$/.test(value)) throw new Error('invalid_mufg_quote');
  const text = value.trim();
  const [whole, fractional = ''] = text.split('.');
  const units = BigInt(`${whole}${fractional.padEnd(6, '0')}`);
  if (units < 1_000_000n || units > 1_000_000_000n) throw new Error('invalid_mufg_quote');
  return { text, units };
}

/** Parse only the JSON object assigned to kinri_deta; executable JavaScript is rejected. */
export function parseMufgUsdJpy(source: string, now = new Date()): MufgUsdJpySnapshot {
  if (source.length > 2_000_000) throw new Error('provider_body_too_large');
  const assignment = /^\uFEFF?\s*var\s+kinri_deta\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(source);
  if (!assignment?.[1]) throw new Error('invalid_mufg_document');
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(assignment[1]) as Record<string, unknown>; } catch { throw new Error('invalid_mufg_document'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_mufg_document');
  const date = typeof parsed.G001DATE === 'string' ? /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(parsed.G001DATE.trim()) : null;
  if (!date) throw new Error('invalid_mufg_publication_date');
  const publicationDate = `${date[1]}-${date[2]}-${date[3]}`;
  const publishedAt = `${publicationDate}T${date[4]}:${date[5]}:00+09:00`;
  const publication = new Date(publishedAt);
  if (!Number.isFinite(publication.getTime()) || jstDate(publication) !== publicationDate || Number(date[4]) > 23 || Number(date[5]) > 59) throw new Error('invalid_mufg_publication_date');
  const tts = bankUnits(parsed.G001TTSZ);
  const ttb = bankUnits(parsed.G001TTBZ);
  if (tts.units < ttb.units || tts.units - ttb.units > 10_000_000n) throw new Error('invalid_mufg_spread');
  const result: MufgUsdJpySnapshot = {
    version: 1, provider: 'MUFG', method: 'derived-midpoint-of-tts-ttb',
    jpyPerUsd: fromCodec(((tts.units + ttb.units) * 5n).toString(), 7), tts: tts.text, ttb: ttb.text,
    publicationDate, publishedAt, fetchedAt: now.toISOString(), sourceUrl: SOURCES.mufg, referenceUrl: SOURCES.mufgReference,
    evidence: evidence(source, SOURCES.mufg, now),
  };
  assertMufgFresh(result, now);
  return result;
}

/** Freshness follows the bank's publication date, never a later fetch or cache write time. */
export function assertMufgFresh(snapshot: MufgUsdJpySnapshot, now = new Date()): void {
  const published = Date.parse(snapshot.publishedAt);
  const age = Date.parse(`${jstDate(now)}T00:00:00Z`) - Date.parse(`${snapshot.publicationDate}T00:00:00Z`);
  if (!Number.isFinite(published) || !Number.isFinite(age) || jstDate(new Date(published)) !== snapshot.publicationDate || published > now.getTime() + 300_000 || age < 0 || age > 7 * 86_400_000) throw new Error('stale_mufg_quote');
}

/** Fetch and validate the official USD/JPY data before accepting a new daily price snapshot. */
export async function fetchMufgUsdJpy(options: FetchOptions = {}): Promise<MufgUsdJpySnapshot> {
  const now = options.now ?? new Date();
  const result = await fetchOfficialText(SOURCES.mufg, { ...options, now });
  const snapshot = parseMufgUsdJpy(result.text, now);
  snapshot.evidence = result.evidence;
  return snapshot;
}

/** Deduplicate daily refreshes. An unsuccessful new-day refresh does not silently reopen checkout. */
export function createMufgDailyProvider(options: { fetch?: typeof globalThis.fetch; clock?: () => Date; initial?: MufgUsdJpySnapshot } = {}): { getSnapshot(): Promise<MufgUsdJpySnapshot> } {
  let cached = options.initial;
  let checkedDay: string | null = null;
  let checkedAt = 0;
  let pending: Promise<MufgUsdJpySnapshot> | null = null;
  return { async getSnapshot() {
    const now = options.clock?.() ?? new Date();
    const today = jstDate(now);
    // A morning refresh can still carry yesterday’s bank quote. Recheck until today’s publication appears.
    const waitingForToday = cached?.publicationDate !== today && now.getTime() - checkedAt >= 15 * 60_000;
    if (cached && checkedDay === today && !waitingForToday) { assertMufgFresh(cached, now); return structuredClone(cached); }
    if (!pending) pending = fetchMufgUsdJpy({ fetch: options.fetch, now }).then((snapshot) => { cached = snapshot; checkedDay = today; checkedAt = now.getTime(); return snapshot; }).finally(() => { pending = null; });
    return structuredClone(await pending);
  } };
}
