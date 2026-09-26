import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { isIP } from 'node:net';
import { digest, tokenMatches } from './crypto.js';
import { RelayError, type CreateOrder, type OrderStore, type RefundFeeQuote, type RefundObligation } from './store.js';
import type { PaymentRequest } from '../core/index.js';

/** Bounded JSON parser protects the public relay from oversized private payloads. */
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RelayError(415, 'Expected JSON');
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 16_384) throw new RelayError(413, 'Request too large'); chunks.push(chunk); }
  try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed as Record<string, unknown>; } catch { throw new RelayError(400, 'Invalid JSON'); }
}

/** Private endpoints require bearer tokens in headers, never URL/query parameters. */
function bearer(request: IncomingMessage): string { const value = request.headers.authorization; if (!value?.startsWith('Bearer ') || value.length > 200) throw new RelayError(401, 'Authentication required'); return value.slice(7); }

/** Normalize IP spelling so equivalent IPv6 and IPv4-mapped addresses share a rate bucket. */
function canonicalIp(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%') || !isIP(value)) throw new RelayError(400, 'Invalid client address');
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const upper = Number.parseInt(mapped[1]!, 16); const lower = Number.parseInt(mapped[2]!, 16);
  return `${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`;
}

/** Trust an overwritten proxy header only after explicit opt-in and a loopback socket peer. */
export function relayClientAddress(peer: string | undefined, header: string | string[] | undefined, trustLoopbackProxy = false): string {
  const address = canonicalIp(peer);
  const loopback = address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
  if (!trustLoopbackProxy || !loopback) return address;
  if (typeof header !== 'string') throw new RelayError(400, 'Trusted proxy client address is required');
  return canonicalIp(header);
}

/** Bind behind the approved TLS proxy. It must disable request-body and authorization logging. */
export function createRelayServer(store: OrderStore, options: { operatorToken: string; ready: () => boolean; trustLoopbackProxy?: boolean; quoteRefund?: (request: PaymentRequest, grossAmountCodec: string) => Promise<RefundFeeQuote> }): Server {
  if (options.operatorToken.length < 32) throw new Error('A strong operator token is required');
  const operatorDigest = digest(options.operatorToken);
  const attempts = new Map<string, { count: number; until: number }>();
  const send = (response: ServerResponse, status: number, value: unknown): void => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  /** The server constructs refund intent from saved evidence; HTTP fee/amount fields have no authority. */
  const trustedRefundQuote = async (id: string, owner: string, refund: RefundObligation): Promise<RefundFeeQuote> => {
    const order = store.operatorOrder(id);
    if (order.owner !== owner || order.refund?.reference !== refund.reference) throw new RelayError(409, 'Refund changed during fee estimation');
    if (!options.ready() || !options.quoteRefund) throw new RelayError(503, 'Refund fee estimation temporarily unavailable');
    const payment: PaymentRequest = { ...order.paymentRequest, payer: order.paymentRequest.recipient, recipient: refund.recipient, amountCodec: refund.grossAmountCodec, reference: refund.reference, expiresAt: new Date(store.now() + 120_000).toISOString() };
    try { return await options.quoteRefund(payment, refund.grossAmountCodec); }
    catch { throw new RelayError(503, 'Refund fee estimation temporarily unavailable'); }
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.search) throw new RelayError(400, 'Query parameters are not supported');
      const origin = request.headers.origin;
      if (origin && !store.config.allowedOrigins?.includes(origin)) throw new RelayError(403, 'Origin not allowed');
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.statusCode = 204; response.end(); return; }
      const client = relayClientAddress(request.socket.remoteAddress, request.headers['x-sora-pay-client-ip'], options.trustLoopbackProxy); const now = Date.now();
      if (attempts.size > 10_000) for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
      const limit = attempts.get(client);
      if (!limit || limit.until < now) attempts.set(client, { count: 1, until: now + 60_000 });
      else if (++limit.count > 240) throw new RelayError(429, 'Request limit exceeded');
      if (url.pathname === '/healthz' && request.method === 'GET') { send(response, 200, { ready: options.ready(), configured: store.config.enabled }); return; }
      if (url.pathname === '/v1/catalog' && request.method === 'GET') { send(response, 200, { ...store.catalog(), enabled: store.config.enabled && options.ready() }); return; }
      if (url.pathname === '/v1/orders' && request.method === 'POST') { if (!options.ready()) throw new RelayError(503, 'Checkout temporarily unavailable'); send(response, 201, store.create(await body(request) as unknown as CreateOrder)); return; }
      if (url.pathname === '/v1/orders/recover-create' && request.method === 'POST') { const input = await body(request); send(response, 200, store.recoverCreate(input.idempotencyKey as string)); return; }
      const order = /^\/v1\/orders\/([a-f0-9-]{36})(?:\/(transaction|payment-attempt|payment-attempt\/cancel))?$/.exec(url.pathname);
      if (order) {
        const id = order[1]!; const token = bearer(request);
        if (!order[2] && request.method === 'GET') { send(response, 200, store.get(id, token)); return; }
        if (request.method === 'POST') {
          const input = await body(request);
          if (order[2] === 'transaction') { store.transactionHint(id, token, input.transactionHash as string); send(response, 202, { accepted: true }); return; }
          if (order[2] === 'payment-attempt') { if (!options.ready()) throw new RelayError(503, 'Checkout temporarily unavailable'); send(response, 200, store.paymentAttempt(id, token)); return; }
          if (order[2] === 'payment-attempt/cancel') { store.cancelAttempt(id, token, input.attemptToken as string); send(response, 200, { canceled: true }); return; }
        }
      }
      if (url.pathname.startsWith('/v1/operator/')) {
        if (!tokenMatches(bearer(request), operatorDigest)) throw new RelayError(401, 'Invalid operator credential');
        if (url.pathname === '/v1/operator/orders' && request.method === 'GET') { send(response, 200, { orders: store.list() }); return; }
        const detail = /^\/v1\/operator\/orders\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (detail && request.method === 'GET') { send(response, 200, store.operatorOrder(detail[1]!)); return; }
        const evidence = /^\/v1\/operator\/orders\/([a-f0-9-]{36})\/evidence$/.exec(url.pathname);
        if (evidence && request.method === 'GET') { send(response, 200, { payments: store.paymentEvidence(evidence[1]!) }); return; }
        const action = /^\/v1\/operator\/orders\/([a-f0-9-]{36})\/(claim|ship|refund|approve|refund-attempt|refund-transaction|refund-cancel)$/.exec(url.pathname);
        if (action && request.method === 'POST') {
          const input = await body(request); const id = action[1]!; const owner = input.owner as string;
          if (action[2] === 'claim') store.claim(id, owner);
          if (action[2] === 'ship') store.ship(id, owner, input.tracking as string, input.shippingReviewed as boolean);
          if (action[2] === 'refund') {
            let refund = store.refund(id, owner);
            if (!refund.feeExempt && !refund.attempt) {
              const quote = await trustedRefundQuote(id, owner, refund);
              if (store.operatorOrder(id).refund?.reference !== refund.reference) throw new RelayError(409, 'Refund changed during fee estimation');
              refund = store.quoteRefund(id, owner, quote);
            }
            send(response, 200, refund); return;
          }
          if (action[2] === 'refund-attempt') {
            const order = store.operatorOrder(id);
            if (order.owner !== owner || order.refund?.status !== 'pending') throw new RelayError(409, 'Refund signing is already pending or unavailable');
            // The public order view strips signing credentials; the existing pending obligation retains its lease.
            const refund = store.refund(id, owner);
            if (refund.reference !== order.refund.reference || refund.attempt) throw new RelayError(409, 'Refund signing is already pending or unavailable');
            if (!refund.feeExempt) {
              if (!refund.feeQuote || Date.parse(refund.feeQuote.expiresAt) <= store.now()) throw new RelayError(409, 'A current refund fee quote is required');
              const quote = await trustedRefundQuote(id, owner, refund);
              const current = store.operatorOrder(id).refund;
              if (current?.reference !== refund.reference || current.amountCodec !== refund.amountCodec || current.feeQuote?.feeCodec !== refund.feeQuote.feeCodec || quote.amountCodec !== refund.amountCodec || quote.feeCodec !== refund.feeQuote.feeCodec) throw new RelayError(409, 'Refund fee changed; request a new quote');
            }
            send(response, 200, store.refundAttempt(id, owner)); return;
          }
          if (action[2] === 'refund-transaction') store.refundTransactionHint(id, owner, input.attemptToken as string, input.transactionHash as string);
          if (action[2] === 'refund-cancel') store.cancelRefundAttempt(id, owner, input.attemptToken as string);
          if (action[2] === 'approve') store.approve(id, owner);
          send(response, 200, { accepted: true }); return;
        }
      }
      throw new RelayError(404, 'Not found');
    } catch (error) { send(response, error instanceof RelayError ? error.status : 500, { error: error instanceof RelayError ? error.message : 'Request could not be completed' }); }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  return server;
}
