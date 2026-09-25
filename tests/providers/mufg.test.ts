import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assertMufgFresh, createMufgDailyProvider, fetchMufgUsdJpy, jstDate, parseMufgUsdJpy } from '../../dist/providers/mufg.js';
import { fetchOfficialText, SOURCES } from '../../dist/providers/http.js';

const now = new Date('2026-09-25T07:00:00Z');
function document(overrides: Record<string, string> = {}): string {
  return `\uFEFFvar kinri_deta = ${JSON.stringify({ G001DATE: '2026/09/25 10:26', G001TTSZ: '   159.78', G001TTBZ: '   157.78', ...overrides })};\n`;
}
function response(body = document()): Response { return new Response(body, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'last-modified': 'Fri, 25 Sep 2026 01:26:00 GMT' } }); }

describe('MUFG USD/JPY source', () => {
  it('uses the exact midpoint of published TTS/TTB and retains Japan publication time', () => {
    const result = parseMufgUsdJpy(document(), now);
    assert.equal(result.jpyPerUsd, '158.78');
    assert.equal(result.publishedAt, '2026-09-25T10:26:00+09:00');
    assert.equal(result.publicationDate, '2026-09-25');
    assert.equal(result.method, 'derived-midpoint-of-tts-ttb');
    assert.equal(result.evidence.sha256.length, 64);
  });
  it('retains half-minor-digit precision without floating-point averaging', () => {
    assert.equal(parseMufgUsdJpy(document({ G001TTSZ: '159.781111', G001TTBZ: '157.780000' }), now).jpyPerUsd, '158.7805555');
  });
  it('rejects executable expressions and appended script without executing them', () => {
    for (const source of [document() + 'globalThis.providerExecuted = true;', 'var kinri_deta = {"G001DATE": (() => "2026/09/25 10:26")()};']) {
      assert.throws(() => parseMufgUsdJpy(source, now), /invalid_mufg_document/);
    }
    assert.equal(Reflect.get(globalThis, 'providerExecuted'), undefined);
  });
  it('rejects missing or noncanonical decimal fields, inverted quotes, and calendar overflow', () => {
    for (const overrides of [{ G001DATE: '2026/02/31 10:00' }, { G001DATE: '2026/09/25 25:00' }, { G001TTSZ: 'NaN' }, { G001TTSZ: '1e2' }, { G001TTSZ: '157.70' }, { G001TTSZ: '200.00' }]) {
      assert.throws(() => parseMufgUsdJpy(document(overrides), now));
    }
  });
  it('permits seven Japan calendar days for bank holidays but never rejuvenates an older quote', () => {
    const source = document({ G001DATE: '2026/09/18 10:26' });
    const snapshot = parseMufgUsdJpy(source, now);
    assert.equal(snapshot.publicationDate, '2026-09-18');
    assert.throws(() => parseMufgUsdJpy(document({ G001DATE: '2026/09/17 10:26' }), now), /stale_mufg_quote/);
    assert.throws(() => assertMufgFresh({ ...snapshot, publicationDate: '2026-09-25' }, now), /stale_mufg_quote/);
    assert.throws(() => assertMufgFresh({ ...snapshot, fetchedAt: '2026-10-01T00:00:00Z' }, new Date('2026-10-01T00:00:00Z')), /stale_mufg_quote/);
  });
  it('rejects future source publication and recognizes the Japan midnight boundary', () => {
    assert.throws(() => parseMufgUsdJpy(document({ G001DATE: '2026/09/26 10:26' }), now), /stale_mufg_quote/);
    assert.equal(jstDate(new Date('2026-09-25T15:01:00Z')), '2026-09-26');
  });
  it('fetches only the official source and preserves HTTP evidence', async () => {
    let requested = '';
    const snapshot = await fetchMufgUsdJpy({ now, fetch: async (url, options) => { requested = String(url); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal); return response(); } });
    assert.equal(requested, SOURCES.mufg);
    assert.equal(snapshot.evidence.lastModified, 'Fri, 25 Sep 2026 01:26:00 GMT');
  });
  it('rechecks after the bank publishes today even if the first morning fetch returned yesterday', async () => {
    let clock = new Date('2026-09-25T00:30:00Z'); let calls = 0;
    const provider = createMufgDailyProvider({ clock: () => clock, fetch: async () => { calls++; return response(document({ G001DATE: calls === 1 ? '2026/09/24 10:26' : '2026/09/25 10:26' })); } });
    assert.equal((await provider.getSnapshot()).publicationDate, '2026-09-24');
    clock = now;
    assert.equal((await provider.getSnapshot()).publicationDate, '2026-09-25');
    assert.equal(calls, 2);
  });
  it('coalesces concurrent daily refreshes, refreshes on the next JST date, and fails closed after outages', async () => {
    let calls = 0; let clock = now; let unavailable = false;
    const provider = createMufgDailyProvider({ clock: () => clock, fetch: async () => { calls++; if (unavailable) throw new Error('offline'); return response(); } });
    const [first, second] = await Promise.all([provider.getSnapshot(), provider.getSnapshot()]);
    assert.equal(calls, 1); assert.deepEqual(first, second);
    first.jpyPerUsd = '1'; assert.equal((await provider.getSnapshot()).jpyPerUsd, '158.78');
    clock = new Date('2026-09-25T15:01:00Z'); unavailable = true;
    await assert.rejects(provider.getSnapshot(), /offline/); assert.equal(calls, 2);
    unavailable = false;
    assert.equal((await provider.getSnapshot()).publicationDate, '2026-09-25'); assert.equal(calls, 3);
  });
});

describe('bounded official source fetching', () => {
  it('refuses arbitrary URLs, redirects, HTTP errors, and wrong content types', async () => {
    await assert.rejects(fetchOfficialText('http://127.0.0.1/internal', { fetch: async () => { throw new Error('must not fetch'); } }), /unapproved_provider_source/);
    for (const result of [new Response('', { status: 302 }), new Response('', { status: 500 }), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      await assert.rejects(fetchOfficialText(SOURCES.mufg, { fetch: async () => result }), /provider_http_error|provider_content_type/);
    }
  });
  it('bounds streamed responses even when Content-Length is absent', async () => {
    await assert.rejects(fetchOfficialText(SOURCES.mufg, { fetch: async () => response('x'.repeat(2_000_001)) }), /provider_body_too_large/);
  });
  it('rejects advertised excess length and empty content', async () => {
    await assert.rejects(fetchOfficialText(SOURCES.mufg, { fetch: async () => new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': '2000001' } }) }), /provider_body_too_large/);
    await assert.rejects(fetchOfficialText(SOURCES.mufg, { fetch: async () => response(' ') }), /provider_empty_body/);
  });
});
