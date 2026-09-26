import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { parseRehearsalProxyArguments, startRehearsalProxy } from '../../dist/relay/rehearsal-proxy.js';

const origin = 'http://127.0.0.1:5173';
const id = '12345678-1234-4234-8234-123456789abc';
const token = 'a'.repeat(64);
interface Captured { method: string | undefined; path: string | undefined; headers: IncomingHttpHeaders; body: string }

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as AddressInfo).port;
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
async function availablePort(): Promise<number> { const server = createServer(); const port = await listen(server); await close(server); return port; }

/** All fixtures are synthetic loopback services; no SSH, private files, RPC or notifier is used. */
async function fixture(t: test.TestContext, reply: { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean } = {}) {
  const captured: Captured[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    captured.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (reply.hang) return;
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers }); response.end(reply.body ?? '{"ok":true}');
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const port = await availablePort(); const proxy = await startRehearsalProxy({ listenPort: port, upstream: `http://127.0.0.1:${upstreamPort}`, frontendOrigin: origin });
  t.after(() => close(proxy));
  const send = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string; chunks?: string[]; noOrigin?: boolean } = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { ...(!options.noOrigin ? { Origin: origin } : {}), ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })); response.on('error', reject);
    });
    outgoing.once('error', reject); if (options.chunks) for (const chunk of options.chunks) outgoing.write(chunk); outgoing.end(options.body);
  });
  return { captured, send, port, proxy, upstream, upstreamPort };
}

test('rehearsal configuration requires explicit distinct literal loopback endpoints', () => {
  const args = ['--listen-port', '39849', '--upstream', 'http://127.0.0.1:39850', '--frontend-origin', origin];
  assert.deepEqual(parseRehearsalProxyArguments(args), { listenPort: 39849, upstream: 'http://127.0.0.1:39850', frontendOrigin: origin });
  for (const upstream of ['http://localhost:39850', 'https://127.0.0.1:39850', 'http://0.0.0.0:39850', 'http://127.0.0.2:39850', 'http://127.0.0.1:39850/', 'http://127.0.0.1:39850?token=x', 'http://user@127.0.0.1:39850', 'http://127.0.0.1:65536', 'http://127.0.0.1:80', 'http://127.0.0.1:039850', 'http://127.0.0.1:39849']) {
    const invalid = [...args]; invalid[3] = upstream; assert.throws(() => parseRehearsalProxyArguments(invalid));
  }
  for (const invalid of [[], args.slice(0, 4), [...args, '--listen-port', '39851'], [...args, '--host', '0.0.0.0'], ['--listen-port', '0', ...args.slice(2)], ['--listen-port', '1e4', ...args.slice(2)]]) assert.throws(() => parseRehearsalProxyArguments(invalid));
  assert.throws(() => parseRehearsalProxyArguments([...args.slice(0, 4), '--frontend-origin', 'https://polkaswap.io']));
});

test('CLI without explicit flags prints usage and exits without starting a proxy', () => {
  const result = execFileSync(process.execPath, [new URL('../../deploy/rehearsal-proxy.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 5_000 });
  assert.match(result, /^Usage:/); assert.doesNotMatch(result, /listening/);
});

test('proxy binds IPv4 loopback and forwards catalog with fixed upstream identity only', async (t) => {
  const { proxy, send, captured, upstreamPort } = await fixture(t, { headers: { 'Set-Cookie': 'discard=1', 'Access-Control-Allow-Origin': '*', 'Location': 'https://invalid.example/' } });
  assert.equal((proxy.address() as AddressInfo).address, '127.0.0.1');
  const result = await send('/v1/catalog', { headers: { Cookie: 'private=value', Authorization: 'Bearer never-forward-on-catalog', 'X-Sora-Pay-Client-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.2', 'X-Private-Header': 'discard' } });
  assert.equal(result.status, 200); assert.equal(result.headers['access-control-allow-origin'], origin); assert.equal(result.headers['cache-control'], 'no-store');
  for (const header of ['set-cookie', 'location', 'access-control-allow-credentials']) assert.equal(result.headers[header], undefined);
  assert.deepEqual(captured[0]?.headers, { accept: 'application/json', origin: 'https://polkaswap.io', 'x-sora-pay-client-ip': '127.0.0.1', connection: 'close', host: `127.0.0.1:${upstreamPort}` });
});

test('missing or mismatched Origin and Host fail before contacting upstream', async (t) => {
  const { send, captured, port } = await fixture(t);
  for (const options of [{ noOrigin: true }, { headers: { Origin: 'null' } }, { headers: { Origin: 'https://polkaswap.io' } }, { headers: { Origin: origin + '/' } }, { headers: { Host: `localhost:${port}` } }, { headers: { Host: `attacker.example:${port}` } }]) {
    const result = await send('/v1/catalog', options); assert.equal(result.status, 403); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(captured.length, 0);
});

test('operator, health, arbitrary URLs, queries and encoded route escapes never reach upstream', async (t) => {
  const { send, captured } = await fixture(t);
  for (const path of ['/healthz', '/v1/healthz', '/v1/operator', '/v1/operator/orders', '/v1/catalog?token=synthetic', 'http://127.0.0.1:39850/v1/catalog', '//127.0.0.1/v1/catalog', '/v1/%63atalog', '/v1/orders/../operator/orders', '/v1/catalog#fragment', '/v1/catalog/', '/v1/orders/not-a-uuid', `/v1/orders/${id}/refund`]) assert.equal((await send(path)).status, 404, path);
  assert.equal((await send('/v1/orders', { method: 'GET' })).status, 405); assert.equal(captured.length, 0);
});

test('preflight permits only the selected customer method and necessary headers', async (t) => {
  const { send, captured } = await fixture(t);
  const result = await send('/v1/orders', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' } });
  assert.equal(result.status, 204); assert.equal(result.body, ''); assert.equal(result.headers['access-control-allow-origin'], origin);
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-sora-pay-client-ip' }, {}]) assert.equal((await send('/v1/orders', { method: 'OPTIONS', headers })).status, 403);
  assert.equal((await send('/v1/operator/orders', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } })).status, 404); assert.equal(captured.length, 0);
});

test('customer creation, recovery and payment routes preserve exact private JSON and recovery authorization', async (t) => {
  const { send, captured } = await fixture(t);
  const body = '{"fixture":"synthetic private contact","amount":"1.759225"}';
  for (const path of ['/v1/orders', '/v1/orders/recover-create', `/v1/orders/${id}/transaction`, `/v1/orders/${id}/payment-attempt`, `/v1/orders/${id}/payment-attempt/cancel`]) {
    const result = await send(path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` }, body });
    assert.equal(result.status, 200); assert.equal(captured.at(-1)?.path, path); assert.equal(captured.at(-1)?.body, body);
    assert.equal(captured.at(-1)?.headers.authorization, path.includes(id) ? `Bearer ${token}` : undefined);
  }
  assert.equal((await send(`/v1/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal(captured.at(-1)?.headers.authorization, `Bearer ${token}`);
  const count = captured.length;
  assert.equal((await send(`/v1/orders/${id}`)).status, 401);
  assert.equal((await send(`/v1/orders/${id}`, { headers: { Authorization: 'Basic synthetic' } })).status, 401); assert.equal(captured.length, count);
});

test('JSON content type, object shape and 16 KiB limits fail closed including chunked requests', async (t) => {
  const { send, captured } = await fixture(t);
  assert.equal((await send('/v1/orders', { method: 'POST', body: '{}' })).status, 415);
  for (const body of ['[]', 'null', '{invalid', '"primitive"']) assert.equal((await send('/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
  const exact = JSON.stringify({ x: 'a'.repeat(16_376) }); assert.equal(Buffer.byteLength(exact), 16_384);
  assert.equal((await send('/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exact })).status, 200);
  assert.equal(captured.length, 1);
  assert.equal((await send('/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' }, body: exact + ' ' })).status, 413);
  assert.equal((await send('/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, chunks: [exact.slice(0, 8_000), exact.slice(8_000), ' '] })).status, 413);
  assert.equal((await send('/v1/catalog', { headers: { 'Content-Length': '2' }, body: '{}' })).status, 400); assert.equal(captured.length, 1);
});

test('redirect responses are never followed and upstream diagnostics are not exposed', async (t) => {
  const { send, captured } = await fixture(t, { status: 302, headers: { Location: 'http://127.0.0.1:39848/v1/operator/orders' }, body: '{"private":"must not escape"}' });
  const result = await send('/v1/catalog'); assert.equal(result.status, 502); assert.equal(captured.length, 1); assert.equal(result.headers.location, undefined); assert.doesNotMatch(result.body, /private|escape|39848/);
});

test('an unsolicited upstream protocol upgrade is rejected without leaving a pending request', { timeout: 3_000 }, async (t) => {
  const { send, captured } = await fixture(t, { status: 101, headers: { Connection: 'Upgrade', Upgrade: 'websocket' }, body: '' });
  const result = await send('/v1/catalog'); assert.equal(result.status, 502); assert.equal(captured.length, 1); assert.equal(result.headers.upgrade, undefined);
});

test('unexpected upstream content and oversized JSON are rejected', async (t) => {
  for (const reply of [{ headers: { 'Content-Type': 'text/html' }, body: '<html>unexpected</html>' }, { body: '{invalid' }, { body: JSON.stringify({ large: 'a'.repeat(1_048_576) }) }]) {
    await t.test('invalid upstream reply', async (child) => { const { send } = await fixture(child, reply); assert.equal((await send('/v1/catalog')).status, 502); });
  }
});

test('an unavailable SSH forward fails once without exposing an error or retrying', async (t) => {
  const { send, upstream, captured } = await fixture(t); await close(upstream);
  const result = await send('/v1/catalog'); assert.equal(result.status, 502); assert.deepEqual(JSON.parse(result.body), { error: 'Relay unavailable' }); assert.equal(captured.length, 0);
});

test('a stalled upstream has a finite deadline and no retry', { timeout: 20_000 }, async (t) => {
  const { send, captured } = await fixture(t, { hang: true });
  const result = await send('/v1/catalog'); assert.equal(result.status, 504); assert.equal(captured.length, 1);
});

test('duplicate browser boundary headers and alternate tunnel protocols are rejected', async (t) => {
  const { port, captured } = await fixture(t);
  for (const raw of [
    `GET /v1/catalog HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nOrigin: ${origin}\r\n\r\n`,
    `CONNECT 127.0.0.1:39848 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\n\r\n`,
    `GET /v1/catalog HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  ]) {
    const socket = connect(port, '127.0.0.1'); const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk)); socket.on('error', () => {}); socket.end(raw); await once(socket, 'close');
    if (raw.includes('Origin: '+origin+'\r\nOrigin')) assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 400/);
  }
  assert.equal(captured.length, 0);
});
