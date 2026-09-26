import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const REQUEST_LIMIT = 16_384;
const RESPONSE_LIMIT = 1_048_576;
const TIMEOUT_MS = 15_000;
const UPSTREAM_ORIGIN = 'https://polkaswap.io';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ORDER_PATH = new RegExp(`^/v1/orders/${UUID}(?:/(transaction|payment-attempt|payment-attempt/cancel))?$`);

/** Local development endpoints only; the upstream is a separately established SSH forward. */
export interface RehearsalProxyOptions { listenPort: number; upstream: string; frontendOrigin: string }
interface Configuration extends RehearsalProxyOptions { upstreamPort: number; expectedHost: string }
interface Route { method: 'GET' | 'POST'; recovery: boolean }

/** Errors expose fixed status messages only, never a request, credential, or upstream diagnostic. */
class ProxyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Require a literal IPv4 loopback origin with an explicit canonical non-default port. */
function loopbackPort(value: string): number {
  if (typeof value !== 'string') throw new Error('Expected a literal loopback HTTP origin');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  const port = Number(match?.[1]);
  if (!match || port > 65_535 || port === 80) throw new Error('Expected a literal loopback HTTP origin');
  return port;
}

/** Reject aliases, credentials, URL paths, port collisions, and externally bound configurations. */
function configuration(options: RehearsalProxyOptions): Configuration {
  const { listenPort, upstream, frontendOrigin } = options;
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535 || listenPort === 80) throw new Error('Invalid proxy listen port');
  const upstreamPort = loopbackPort(upstream); const frontendPort = loopbackPort(frontendOrigin);
  if (new Set([listenPort, upstreamPort, frontendPort]).size !== 3) throw new Error('Rehearsal ports must be distinct');
  return { listenPort, upstream, frontendOrigin, upstreamPort, expectedHost: `127.0.0.1:${listenPort}` };
}

/** Parse exactly three explicit flags; importing this module never opens a listener. */
export function parseRehearsalProxyArguments(args: readonly string[]): RehearsalProxyOptions {
  const values = new Map<string, string>(); const allowed = ['--listen-port', '--upstream', '--frontend-origin'];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !allowed.includes(name) || !value || values.has(name)) throw new Error('Expected explicit rehearsal proxy flags');
    values.set(name, value);
  }
  if (values.size !== 3 || !/^[1-9][0-9]{0,4}$/.test(values.get('--listen-port') ?? '')) throw new Error('Expected explicit rehearsal proxy flags');
  const options = { listenPort: Number(values.get('--listen-port')), upstream: values.get('--upstream')!, frontendOrigin: values.get('--frontend-origin')! };
  configuration(options); return options;
}

/** Match raw origin-form paths only, without decoding or normalizing potential route escapes. */
function customerRoute(path: string | undefined): Route {
  if (path === '/v1/catalog') return { method: 'GET', recovery: false };
  if (path === '/v1/orders' || path === '/v1/orders/recover-create') return { method: 'POST', recovery: false };
  const order = path ? ORDER_PATH.exec(path) : null;
  if (order) return { method: order[1] ? 'POST' : 'GET', recovery: true };
  throw new ProxyError(404, 'Customer route not available');
}

/** Exact origin, Host, peer and single-valued sensitive headers prevent browser-origin confusion. */
function browserBoundary(request: IncomingMessage, config: Configuration): void {
  const peer = request.socket.remoteAddress;
  if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') throw new ProxyError(403, 'Loopback browser required');
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (['host', 'origin', 'authorization', 'content-type', 'content-length', 'access-control-request-method', 'access-control-request-headers'].includes(name)) {
      if (seen.has(name)) throw new ProxyError(400, 'Duplicate request header');
      seen.add(name);
    }
  }
  if (request.headers.host !== config.expectedHost || request.headers.origin !== config.frontendOrigin) throw new ProxyError(403, 'Browser origin not allowed');
}

/** Read at most 16 KiB within a fixed deadline, including chunked bodies. */
function requestBody(request: IncomingMessage, method: Route['method']): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (contentLength && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > REQUEST_LIMIT)) throw new ProxyError(413, 'Request too large');
  if (method === 'GET') {
    if (request.headers['transfer-encoding'] || (contentLength && Number(contentLength) !== 0)) throw new ProxyError(400, 'GET body not allowed');
    return Promise.resolve(Buffer.alloc(0));
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ProxyError(415, 'Expected JSON');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    const cleanup = (): void => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', failure); request.off('aborted', failure); };
    const failure = (): void => { cleanup(); reject(new ProxyError(400, 'Request interrupted')); };
    const data = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > REQUEST_LIMIT) { cleanup(); request.resume(); reject(new ProxyError(413, 'Request too large')); } else chunks.push(chunk);
    };
    const end = (): void => {
      cleanup(); const body = Buffer.concat(chunks);
      try { const value: unknown = JSON.parse(body.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
      catch { reject(new ProxyError(400, 'Expected JSON object')); return; }
      resolve(body);
    };
    const timer = setTimeout(() => { cleanup(); request.resume(); reject(new ProxyError(408, 'Request timed out')); }, TIMEOUT_MS);
    request.on('data', data); request.once('end', end); request.once('error', failure); request.once('aborted', failure);
  });
}

/** One bounded request to the fixed SSH forward: no redirects, cookies, arbitrary headers or retries. */
function forward(config: Configuration, path: string, route: Route, body: Buffer, authorization: string | undefined, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: ProxyError): void => { clearTimeout(timer); reject(error); };
    const headers: Record<string, string> = { Accept: 'application/json', Origin: UPSTREAM_ORIGIN, 'X-Sora-Pay-Client-IP': '127.0.0.1', Connection: 'close' };
    if (route.method === 'POST') { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(body.length); }
    if (route.recovery) headers.Authorization = authorization!;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: config.upstreamPort, path, method: route.method, headers, agent: false, signal }, (response) => {
      const status = response.statusCode ?? 502;
      if (status < 200 || (status >= 300 && status < 400) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) { upstream.destroy(); fail(new ProxyError(502, 'Unexpected relay response')); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > RESPONSE_LIMIT) { upstream.destroy(); fail(new ProxyError(502, 'Relay response too large')); } else chunks.push(chunk); });
      response.once('error', () => fail(new ProxyError(502, 'Relay unavailable')));
      response.once('end', () => {
        const result = Buffer.concat(chunks);
        try { const value: unknown = JSON.parse(result.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
        catch { fail(new ProxyError(502, 'Unexpected relay response')); return; }
        clearTimeout(timer); resolve({ status, body: result });
      });
    });
    timer = setTimeout(() => { upstream.destroy(); fail(new ProxyError(504, 'Relay timed out')); }, TIMEOUT_MS);
    // A protocol switch bypasses the normal response callback; never hand its socket to the browser.
    upstream.once('upgrade', (_response, socket) => { socket.destroy(); fail(new ProxyError(502, 'Unexpected relay response')); });
    upstream.once('error', () => fail(new ProxyError(502, 'Relay unavailable')));
    upstream.end(body);
  });
}

/** Emit no upstream headers: only the exact local CORS origin and private JSON response policy. */
function send(response: ServerResponse, status: number, body: Buffer | Record<string, unknown>): void {
  response.statusCode = status; response.setHeader('Content-Type', 'application/json');
  response.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** Start a customer-only rehearsal transport on IPv4 loopback; no relay or wallet secrets are loaded. */
export async function startRehearsalProxy(options: RehearsalProxyOptions): Promise<Server> {
  const config = configuration(options);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Connection', 'close');
    const controller = new AbortController(); response.once('close', () => controller.abort());
    try {
      browserBoundary(request, config);
      response.setHeader('Access-Control-Allow-Origin', config.frontendOrigin); response.setHeader('Vary', 'Origin');
      const route = customerRoute(request.url);
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const headers = request.headers['access-control-request-headers'];
        if (method !== route.method || (headers && (typeof headers !== 'string' || headers.split(',').some((value) => !['authorization', 'content-type'].includes(value.trim().toLowerCase()))))) throw new ProxyError(403, 'Preflight not allowed');
        response.setHeader('Access-Control-Allow-Methods', route.method); response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.statusCode = 204; response.end(); return;
      }
      if (request.method !== route.method) throw new ProxyError(405, 'Method not allowed');
      const authorization = request.headers.authorization;
      if (route.recovery && !/^Bearer [a-f0-9]{64}$/.test(authorization ?? '')) throw new ProxyError(401, 'Recovery token required');
      const body = await requestBody(request, route.method);
      const result = await forward(config, request.url!, route, body, authorization, controller.signal);
      send(response, result.status, result.body);
    } catch (error) {
      request.resume();
      if (!response.destroyed) send(response, error instanceof ProxyError ? error.status : 502, { error: error instanceof ProxyError ? error.message : 'Rehearsal proxy unavailable' });
    }
  });
  server.requestTimeout = TIMEOUT_MS; server.headersTimeout = 5_000; server.maxHeadersCount = 30; server.keepAliveTimeout = 1_000;
  // HTTP Upgrade/CONNECT can never become an alternate tunnel around the customer route allowlist.
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.listenPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return server;
}
