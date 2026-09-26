import { createHash } from 'node:crypto';

/** Fixed official sources; callers cannot turn this helper into an arbitrary URL fetcher. */
export const SOURCES = {
  mufg: 'https://www.bk.mufg.jp/gdocs/kinri/kinri_data_utf8.js',
  mufgReference: 'https://www.bk.mufg.jp/ippan/kinri/list_j/kinri/kawase.html',
  emsRates: 'https://www.post.japanpost.jp/send/oversea/charge/list-ems/all_en.html',
  emsZones: 'https://www.post.japanpost.jp/service/send/oversea/list/delivery/ems/country/all_en.html',
  emsAvailability: 'https://www.post.japanpost.jp/service/send/oversea/information/overview_en.html',
  emsRestrictions: 'https://www.post.japanpost.jp/service/send/oversea/information/overview_en.pdf',
} as const;

export interface FetchOptions { fetch?: typeof globalThis.fetch; now?: Date; }
export interface SourceEvidence { url: string; fetchedAt: string; sha256: string; lastModified: string | null; }

/** Hash evidence without storing executable JavaScript or third-party HTML in the package. */
export function evidence(text: string, url: string, fetchedAt: Date, lastModified: string | null = null): SourceEvidence {
  return { url, fetchedAt: fetchedAt.toISOString(), sha256: createHash('sha256').update(text, 'utf8').digest('hex'), lastModified };
}

/** Fetch a fixed official source with timeout, redirect refusal, and streaming size limits. */
export async function fetchOfficialText(url: string, options: FetchOptions = {}): Promise<{ text: string; evidence: SourceEvidence }> {
  if (!Object.values(SOURCES).includes(url as (typeof SOURCES)[keyof typeof SOURCES])) throw new Error('unapproved_provider_source');
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'text/html, application/javascript, text/javascript' },
  });
  if (!response.ok || response.status !== 200 || response.redirected) throw new Error('provider_http_error');
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!['text/html', 'application/javascript', 'text/javascript', 'text/plain'].includes(contentType ?? '')) throw new Error('provider_content_type');
  const limit = 2_000_000;
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || BigInt(contentLength) > BigInt(limit))) throw new Error('provider_body_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('provider_empty_body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error('provider_body_too_large');
      chunks.push(result.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim()) throw new Error('provider_empty_body');
  return { text, evidence: evidence(text, url, options.now ?? new Date(), response.headers.get('last-modified')) };
}
