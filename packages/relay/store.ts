import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { PaymentRequest, PaymentReceipt, FinalizedTransferEvidence } from '../core/index.js';
import { verifyFinalizedPayment, validatePaymentRequest } from '../core/index.js';
import { accountAddress, merchantPrice, type MerchantConfig } from './config.js';
import { decrypt, digest, encrypt, tokenMatches } from './crypto.js';
import { xorToCodec } from './pricing.js';

export type OrderStatus = 'unpaid' | 'expired' | 'paid' | 'shipping_review' | 'shipped' | 'refund_pending' | 'refunded';
/** Postal code may be omitted at checkout; stored orders normalize it to an empty string. */
export interface Address { name: string; line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string }
export interface Contact { type: 'email' | 'telegram'; value: string }
export interface CreateOrder { productId: string; quantity: number; shippingRateId: string; payer: string; address: Address; contact: Contact; idempotencyKey: string }
export interface RefundObligation { reference: string; recipient: string; amountCodec: string; status: 'pending' | 'finalized'; receipt?: PaymentReceipt; attempt?: { token: string; submitted: boolean; transactionHash?: string } }
interface PrivateOrder {
  input: CreateOrder; paymentRequest: PaymentRequest; recoveryToken: string; receivedCodec: string; refundedCodec: string;
  completedAt?: number;
  pricingSnapshot?: MerchantConfig['pricing']; shippingSnapshot?: MerchantConfig['shipping'][number]; fulfilledCodec?: string;
  receipt?: PaymentReceipt; tracking?: string; reviewReason?: string; refund?: RefundObligation;
  attempt?: { token: string; submitted: boolean }; transactionHint?: string;
}
interface Row { id: string; public_reference: string; token_hash: string; idem_hash: string; fingerprint: string; data: string; status: OrderStatus; quantity: number; reserved: number; expires: number; created: number; updated: number; owner: string | null; notification: string }
export interface OrderView { orderId: string; paymentRequest: PaymentRequest; status: Exclude<OrderStatus, 'unpaid'> | 'awaiting_payment'; notificationStatus: string; paymentPending: boolean; receipt?: PaymentReceipt; tracking?: string; refund?: RefundObligation; reviewReason?: string }
export class RelayError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Validate private checkout input without ever reflecting rejected PII into errors. */
function validateInput(input: CreateOrder): CreateOrder {
  if (!input || typeof input !== 'object' || !input.address || !input.contact) throw new RelayError(400, 'Invalid order');
  if (!/^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[a-f0-9]{64})$/i.test(input.idempotencyKey)) throw new RelayError(400, 'A random idempotency key is required');
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000) throw new RelayError(400, 'Invalid quantity');
  const address: Record<string, string> = {};
  for (const field of ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const) {
    const value = input.address[field];
    if (field === 'postalCode' && value === undefined) { address[field] = ''; continue; }
    if (value == null && (field === 'line2' || field === 'region')) continue;
    if (typeof value !== 'string' || (field !== 'postalCode' && !value.trim()) || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new RelayError(400, 'Invalid delivery address');
    address[field] = value.trim();
  }
  if (!/^[A-Z]{2}$/.test(address.country!)) throw new RelayError(400, 'Invalid destination');
  if (!['email', 'telegram'].includes(input.contact.type) || typeof input.contact.value !== 'string' || input.contact.value.length > 254 || /[\x00-\x20\x7f]/.test(input.contact.value)) throw new RelayError(400, 'Invalid contact');
  if (input.contact.type === 'email' && !/^[^@]+@[^@]+\.[^@]+$/.test(input.contact.value)) throw new RelayError(400, 'Invalid email');
  if (input.contact.type === 'telegram' && !/^@[A-Za-z0-9_]{5,32}$/.test(input.contact.value)) throw new RelayError(400, 'Invalid Telegram handle');
  let payer: string;
  try { payer = accountAddress(input.payer); } catch { throw new RelayError(400, 'Invalid paying wallet'); }
  return { productId: String(input.productId), quantity: input.quantity, shippingRateId: String(input.shippingRateId), payer, address: address as unknown as Address, contact: { type: input.contact.type, value: input.contact.value }, idempotencyKey: input.idempotencyKey };
}

/** Synchronous SQLite transactions make reservations and notification outbox durable together. */
export class OrderStore {
  readonly db: DatabaseSync;
  constructor(readonly path: string, readonly config: MerchantConfig, private key: Buffer, readonly now: () => number = Date.now) {
    if (key.length !== 32) throw new Error('Invalid encryption key');
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,public_reference TEXT UNIQUE,token_hash TEXT,idem_hash TEXT UNIQUE,fingerprint TEXT,data TEXT,status TEXT,quantity INTEGER,reserved INTEGER,expires INTEGER,created INTEGER,updated INTEGER,owner TEXT,notification TEXT);
      CREATE TABLE IF NOT EXISTS payments(event_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,evidence TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT,attempts INTEGER DEFAULT 0,next_attempt INTEGER,delivered INTEGER DEFAULT 0,claim_token TEXT,claim_until INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'claim_token')) this.db.exec('ALTER TABLE outbox ADD COLUMN claim_token TEXT; ALTER TABLE outbox ADD COLUMN claim_until INTEGER DEFAULT 0;');
    const paymentColumns = this.db.prepare('PRAGMA table_info(payments)').all() as { name: string }[];
    if (!paymentColumns.some((c) => c.name === 'evidence')) this.db.exec('ALTER TABLE payments ADD COLUMN evidence TEXT');
    const check = this.db.prepare('SELECT value FROM meta WHERE key=?').get('key-check') as { value: string } | undefined;
    if (check) decrypt(check.value, key, 'key-check');
    else this.db.prepare('INSERT INTO meta VALUES(?,?)').run('key-check', encrypt('sora-pay', key, 'key-check'));
    if (config.enabled) {
      const identity = digest(config.chain.genesisHash + ':' + config.chain.recipient);
      const savedIdentity = this.db.prepare("SELECT value FROM meta WHERE key='merchant-identity'").get() as { value: string } | undefined;
      if (savedIdentity && savedIdentity.value !== identity) throw new Error('Existing database chain/recipient cannot be changed');
      if (!savedIdentity) this.db.prepare('INSERT INTO meta VALUES(?,?)').run('merchant-identity', identity);
    }
  }
  /** Close the WAL-backed database cleanly. */
  close(): void { this.db.close(); }
  private atomic<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private row(id: string): Row { const row = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as unknown as Row | undefined; if (!row) throw new RelayError(404, 'Order not found'); return row; }
  private decode(row: Row): PrivateOrder { return decrypt(row.data, this.key, row.id); }
  private save(row: Row, data: PrivateOrder): void { this.db.prepare('UPDATE orders SET data=?,status=?,reserved=?,updated=?,owner=?,notification=? WHERE id=?').run(encrypt(data, this.key, row.id), row.status, row.reserved, this.now(), row.owner, row.notification, row.id); }
  private enqueue(row: Row, kind: string): void { this.db.prepare('INSERT INTO outbox(id,order_id,kind,next_attempt) VALUES(?,?,?,?)').run(randomUUID(), row.id, kind, this.now()); row.notification = 'pending'; }
  private expire(): void { this.db.prepare("UPDATE orders SET status='expired',reserved=0,updated=expires WHERE status='unpaid' AND expires<=?").run(this.now()); }
  /** Public catalog exposes only publishable merchant policy and current available stock. */
  catalog(): Record<string, unknown> {
    this.expire();
    if (!this.config.enabled) return { enabled: false, version: this.config.version ?? 'unconfigured' };
    const c = this.config;
    return { enabled: true, version: c.version, merchant: c.merchant, pricing: c.pricing.kind === 'exact-xor' ? { kind: 'exact-xor', version: c.pricing.version } : c.pricing, sourceMetadata: c.pricing.kind === 'exact-xor' ? (c.sourceMetadata?.shipping ? { shipping: c.sourceMetadata.shipping } : undefined) : c.sourceMetadata, product: { id: c.product.id, name: c.product.name, grams: c.product.grams, packedGrams: c.product.packedGrams, packagingGrams: c.product.packagingGrams ?? 0, fulfillmentMode: c.fulfillmentMode ?? 'stocked', priceXor: merchantPrice(c, c.product), stockAvailable: this.available() }, shipping: c.shipping.filter((rate) => rate.countries.some((country) => !c.blockedCountries?.includes(country))).map((rate) => ({ id: rate.id, label: rate.label, maxGrams: rate.maxGrams, reviewedAt: rate.reviewedAt, countries: rate.countries.filter((country) => !c.blockedCountries?.includes(country)), priceXor: merchantPrice(c, rate, true) })), chain: { genesisHash: c.chain.genesisHash, assetId: c.chain.assetId, decimals: c.chain.decimals, denomination: c.chain.denomination, recipient: c.chain.recipient } };
  }
  private available(): number | null { if (this.config.fulfillmentMode === 'on-demand') return null; const row = this.db.prepare('SELECT COALESCE(SUM(quantity),0) AS total FROM orders WHERE reserved=1').get() as { total: number }; return Math.max(0, this.config.product.stock! - row.total); }
  /** Save the private order before returning any signable payment request. */
  create(raw: CreateOrder): OrderView & { recoveryToken: string } {
    if (!this.config.enabled) throw new RelayError(503, 'Store checkout is unavailable');
    const input = validateInput(raw);
    const fingerprint = digest(JSON.stringify(input));
    return this.atomic(() => {
      this.expire();
      const existing = this.db.prepare('SELECT * FROM orders WHERE idem_hash=?').get(digest(input.idempotencyKey)) as unknown as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new RelayError(409, 'Idempotency key already used');
        const saved = this.decode(existing); return { ...this.view(existing, saved), recoveryToken: saved.recoveryToken };
      }
      const c = this.config;
      const rate = c.shipping.find((r) => r.id === input.shippingRateId && r.countries.includes(input.address.country) && r.maxGrams >= input.quantity * c.product.packedGrams + (c.product.packagingGrams ?? 0));
      if (input.productId !== c.product.id || !rate || c.blockedCountries?.includes(input.address.country)) throw new RelayError(400, 'Shipping inquiry required for this order');
      if (this.available() !== null && this.available()! < input.quantity) throw new RelayError(409, 'Insufficient stock');
      const price = BigInt(xorToCodec(merchantPrice(c, c.product), c.chain.decimals, c.chain.denomination));
      const shipping = BigInt(xorToCodec(merchantPrice(c, rate, true), c.chain.decimals, c.chain.denomination));
      const id = randomUUID(); const token = randomBytes(32).toString('hex'); const expires = this.now() + 30 * 60_000;
      const request: PaymentRequest = { version: 1, merchant: { id: c.merchant.id, name: c.merchant.name }, chainGenesisHash: c.chain.genesisHash, assetId: c.chain.assetId, recipient: c.chain.recipient, payer: input.payer, amountCodec: (price * BigInt(input.quantity) + shipping).toString(), decimals: c.chain.decimals, denomination: c.chain.denomination, reference: `sp_${randomBytes(16).toString('hex')}`, expiresAt: new Date(expires).toISOString() };
      validatePaymentRequest(request);
      const data: PrivateOrder = { input, paymentRequest: request, recoveryToken: token, receivedCodec: '0', refundedCodec: '0', pricingSnapshot: structuredClone(c.pricing), shippingSnapshot: structuredClone(rate) };
      this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, request.reference, digest(token), digest(input.idempotencyKey), fingerprint, encrypt(data, this.key, id), 'unpaid', input.quantity, 1, expires, this.now(), this.now(), null, 'not_ready');
      return { ...this.view(this.row(id), data), recoveryToken: token };
    });
  }
  /** Recover a lost create response using the original secret random idempotency capability. */
  recoverCreate(idempotencyKey: string): OrderView & { recoveryToken: string } {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 36 || idempotencyKey.length > 64) throw new RelayError(404, 'Order not found');
    this.expire();
    const row = this.db.prepare('SELECT * FROM orders WHERE idem_hash=?').get(digest(idempotencyKey)) as unknown as Row | undefined;
    if (!row) throw new RelayError(404, 'Order not found');
    const data = this.decode(row); return { ...this.view(row, data), recoveryToken: data.recoveryToken };
  }
  private view(row: Row, data: PrivateOrder): OrderView { return { orderId: row.id, paymentRequest: data.paymentRequest, status: row.status === 'unpaid' ? 'awaiting_payment' : row.status, notificationStatus: row.notification, paymentPending: Boolean(data.attempt), receipt: data.receipt, tracking: data.tracking, refund: data.refund ? { reference: data.refund.reference, recipient: data.refund.recipient, amountCodec: data.refund.amountCodec, status: data.refund.status, receipt: data.refund.receipt } : undefined, reviewReason: data.reviewReason }; }
  /** Recovery requires a high-entropy bearer token, never an identifier alone. */
  get(id: string, token: string): OrderView { this.expire(); const row = this.authorized(id, token); return this.view(row, this.decode(row)); }
  private authorized(id: string, token: string): Row { const row = this.row(id); if (!tokenMatches(token, row.token_hash)) throw new RelayError(404, 'Order not found'); return row; }
  /** Acquire one durable signing attempt so two browser tabs cannot both submit. */
  paymentAttempt(id: string, token: string): { attemptToken: string } {
    return this.atomic(() => { this.expire(); const row = this.authorized(id, token); const data = this.decode(row); if (row.status !== 'unpaid' || data.attempt) throw new RelayError(409, 'Payment already pending or order expired'); const attemptToken = randomBytes(32).toString('hex'); data.attempt = { token: attemptToken, submitted: false }; this.save(row, data); return { attemptToken }; });
  }
  /** Release only an explicitly canceled, unsubmitted wallet attempt. */
  cancelAttempt(id: string, token: string, attemptToken: string): void {
    this.atomic(() => { const row = this.authorized(id, token); const data = this.decode(row); if (!data.attempt || data.attempt.token !== attemptToken || data.attempt.submitted) throw new RelayError(409, 'Payment outcome requires reconciliation'); delete data.attempt; this.save(row, data); });
  }
  /** Client transaction hashes are hints and never establish payment. */
  transactionHint(id: string, token: string, transactionHash: string): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) throw new RelayError(400, 'Invalid transaction hash');
    const row = this.authorized(id, token); const data = this.decode(row); data.transactionHint = transactionHash; if (data.attempt) data.attempt.submitted = true; this.save(row, data);
  }
  /** Consume finalized transfer evidence exactly once and atomically queue notification. */
  accept(evidence: FinalizedTransferEvidence): boolean {
    return this.atomic(() => {
      const eventId = `${evidence.blockHash}:${evidence.eventIndex}`;
      if (this.db.prepare('SELECT 1 FROM payments WHERE event_id=?').get(eventId)) return false;
      const row = this.db.prepare('SELECT * FROM orders WHERE public_reference=?').get(evidence.reference) as unknown as Row | undefined;
      if (!row) return this.acceptRefund(evidence, eventId);
      const data = this.decode(row);
      evidence = { ...evidence, payer: accountAddress(evidence.payer), recipient: accountAddress(evidence.recipient) };
      let receipt: PaymentReceipt;
      try { receipt = verifyFinalizedPayment({ ...data.paymentRequest, amountCodec: evidence.amountCodec }, evidence); } catch { return false; }
      const exact = evidence.amountCodec === data.paymentRequest.amountCodec && data.receivedCodec === '0';
      const onTime = Date.parse(evidence.finalizedAt) <= row.expires && row.status === 'unpaid';
      const payable = exact && onTime;
      data.receivedCodec = (BigInt(data.receivedCodec) + BigInt(evidence.amountCodec)).toString();
      if (evidence.amountCodec === data.paymentRequest.amountCodec) data.receipt = receipt;
      if (row.status === 'shipped' || row.status === 'refunded') row.reserved = row.status === 'shipped' ? 1 : 0;
      row.status = data.refund?.status === 'pending' ? 'refund_pending' : (payable && !this.config.reviewEveryPaidOrder ? 'paid' : 'shipping_review');
      if (payable && this.config.reviewEveryPaidOrder) data.reviewReason = 'shipping_check_required';
      if (!payable) data.reviewReason = exact ? 'late_payment' : 'amount_or_additional_payment';
      this.db.prepare('INSERT INTO payments VALUES(?,?,?,?)').run(eventId, row.id, 'payment', encrypt(evidence, this.key, eventId));
      this.enqueue(row, payable ? 'paid' : 'shipping_review'); this.save(row, data); return true;
    });
  }
  private acceptRefund(evidence: FinalizedTransferEvidence, eventId: string): boolean {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status='refund_pending'").all() as unknown as Row[];
    for (const row of rows) {
      const data = this.decode(row); const refund = data.refund;
      if (!refund || refund.reference !== evidence.reference) continue;
      const request = { ...data.paymentRequest, payer: data.paymentRequest.recipient, recipient: data.paymentRequest.payer, amountCodec: refund.amountCodec, reference: refund.reference };
      let receipt: PaymentReceipt;
      try { receipt = verifyFinalizedPayment(request, { ...evidence, payer: accountAddress(evidence.payer), recipient: accountAddress(evidence.recipient) }); } catch { return false; }
      refund.status = 'finalized'; refund.receipt = receipt; data.refundedCodec = (BigInt(data.refundedCodec) + BigInt(refund.amountCodec)).toString();
      row.status = BigInt(data.receivedCodec) - BigInt(data.refundedCodec) - BigInt(data.fulfilledCodec ?? '0') > 0n ? 'shipping_review' : 'refunded'; if (row.status === 'refunded') data.completedAt = this.now(); if (!data.tracking) row.reserved = 0; this.db.prepare('INSERT INTO payments VALUES(?,?,?,?)').run(eventId, row.id, 'refund', encrypt(evidence, this.key, eventId)); this.enqueue(row, 'refunded'); this.save(row, data); return true;
    }
    return false;
  }
  /** Read a private operator queue; HTTP authentication is enforced by the server. */
  list(): Array<OrderView & { owner: string | null; address: Address; contact: Contact; quantity: number; receivedCodec: string; refundedCodec: string }> {
    this.expire(); return (this.db.prepare("SELECT * FROM orders ORDER BY CASE WHEN status IN ('paid','shipping_review','refund_pending') THEN 0 ELSE 1 END, created ASC LIMIT 500").all() as unknown as Row[]).map((row) => { const data = this.decode(row); return { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec }; });
  }
  /** Fetch one operator record directly even when a large queue is paginated by the caller. */
  operatorOrder(id: string): ReturnType<OrderStore['list']>[number] {
    const row = this.row(id); const data = this.decode(row);
    return { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec };
  }
  /** Return private chain evidence for payment mismatch/refund reconciliation. */
  paymentEvidence(id: string): FinalizedTransferEvidence[] {
    this.row(id);
    const rows = this.db.prepare('SELECT event_id,evidence FROM payments WHERE order_id=?').all(id) as { event_id: string; evidence: string | null }[];
    return rows.filter((row) => row.evidence).map((row) => decrypt<FinalizedTransferEvidence>(row.evidence!, this.key, row.event_id));
  }
  /** Assign once; another volunteer cannot silently take over an active order. */
  claim(id: string, owner: string): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner)) throw new RelayError(400, 'Invalid operator identifier');
    this.atomic(() => { const row = this.row(id); if (row.owner && row.owner !== owner) throw new RelayError(409, 'Order already assigned'); row.owner = owner; this.save(row, this.decode(row)); });
  }
  /** Mark dispatch only after the assigned volunteer completes a legal/carrier recheck. */
  ship(id: string, owner: string, tracking: string, reviewed: boolean): void {
    if (typeof tracking !== 'string' || !tracking.trim() || tracking.length > 500 || /[\x00-\x1f]/.test(tracking) || reviewed !== true) throw new RelayError(400, 'Tracking and shipping review are required');
    this.atomic(() => { const row = this.row(id); if (row.owner !== owner || row.status !== 'paid' || this.decode(row).tracking) throw new RelayError(409, 'Order is not assigned and ready to ship'); const data = this.decode(row); row.status = 'shipped'; data.completedAt = this.now(); data.tracking = tracking; data.fulfilledCodec = data.paymentRequest.amountCodec; this.enqueue(row, 'shipped'); this.save(row, data); });
  }
  /** Approve an exact late payment only after supply and shipping review. */
  approve(id: string, owner: string): void {
    this.atomic(() => {
      const row = this.row(id); const data = this.decode(row);
      if (row.owner !== owner || row.status !== 'shipping_review' || data.tracking || data.refund?.status === 'pending' || BigInt(data.receivedCodec) - BigInt(data.refundedCodec) !== BigInt(data.paymentRequest.amountCodec)) throw new RelayError(409, 'Order requires refund or reconciliation');
      if (!row.reserved && this.available() !== null && this.available()! < row.quantity) throw new RelayError(409, 'Insufficient stock');
      row.reserved = 1; row.status = 'paid'; delete data.reviewReason; this.enqueue(row, 'paid'); this.save(row, data);
    });
  }
  /** Create a full remaining-XOR obligation; only the group wallet signs the refund. */
  refund(id: string, owner: string): RefundObligation {
    return this.atomic(() => { const row = this.row(id); const data = this.decode(row); if (row.owner !== owner || !['paid', 'shipping_review', 'refund_pending'].includes(row.status)) throw new RelayError(409, 'Order is not refundable by this operator'); if (data.refund?.status === 'pending') return data.refund; const amount = BigInt(data.receivedCodec) - BigInt(data.refundedCodec) - BigInt(data.fulfilledCodec ?? '0'); if (amount <= 0n) throw new RelayError(409, 'No outstanding payment'); data.refund = { reference: `sp_${randomBytes(16).toString('hex')}`, recipient: data.paymentRequest.payer, amountCodec: amount.toString(), status: 'pending' }; row.status = 'refund_pending'; this.enqueue(row, 'refund_pending'); this.save(row, data); return data.refund; });
  }
  /** Reserve one refund signing attempt; an uncertain transaction must be reconciled, not resent. */
  refundAttempt(id: string, owner: string): { attemptToken: string } {
    return this.atomic(() => {
      const row = this.row(id); const data = this.decode(row); const refund = data.refund;
      if (row.owner !== owner || row.status !== 'refund_pending' || !refund || refund.status !== 'pending' || refund.attempt) throw new RelayError(409, 'Refund signing is already pending or unavailable');
      const attemptToken = randomBytes(32).toString('hex'); refund.attempt = { token: attemptToken, submitted: false }; this.save(row, data); return { attemptToken };
    });
  }
  /** Store outbound transaction hints without treating browser/operator assertions as finality. */
  refundTransactionHint(id: string, owner: string, attemptToken: string, transactionHash: string): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) throw new RelayError(400, 'Invalid transaction hash');
    this.atomic(() => { const row = this.row(id); const data = this.decode(row); const attempt = data.refund?.attempt;
      if (row.owner !== owner || !attempt || attempt.token !== attemptToken) throw new RelayError(409, 'Invalid refund attempt');
      attempt.submitted = true; attempt.transactionHash = transactionHash; this.save(row, data);
    });
  }
  /** Release a refund attempt only after an explicit wallet cancellation before broadcast. */
  cancelRefundAttempt(id: string, owner: string, attemptToken: string): void {
    this.atomic(() => { const row = this.row(id); const data = this.decode(row); const refund = data.refund;
      if (row.owner !== owner || !refund?.attempt || refund.attempt.token !== attemptToken || refund.attempt.submitted) throw new RelayError(409, 'Refund outcome requires reconciliation');
      delete refund.attempt; this.save(row, data);
    });
  }
  /** Atomically lease a durable delivery job so concurrent workers cannot send it together. */
  pendingNotification(): { id: string; claimToken: string; orderId: string; kind: string; attempts: number; order: ReturnType<OrderStore['list']>[number] } | undefined {
    return this.atomic(() => {
      const job = this.db.prepare('SELECT * FROM outbox WHERE delivered=0 AND next_attempt<=? AND claim_until<=? ORDER BY next_attempt LIMIT 1').get(this.now(), this.now()) as { id: string; order_id: string; kind: string; attempts: number } | undefined;
      if (!job) return undefined;
      const claimToken = randomBytes(16).toString('hex');
      this.db.prepare('UPDATE outbox SET claim_token=?,claim_until=? WHERE id=?').run(claimToken, this.now() + 60_000, job.id);
      const row = this.row(job.order_id); const data = this.decode(row);
      return { id: job.id, claimToken, orderId: row.id, kind: job.kind, attempts: job.attempts, order: { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec } };
    });
  }
  /** Persist retry delays only for the current lease; failures never alter accepted payments. */
  finishNotification(id: string, claimToken: string, delivered: boolean): void {
    this.atomic(() => {
      const job = this.db.prepare('SELECT * FROM outbox WHERE id=? AND claim_token=? AND delivered=0').get(id, claimToken) as { attempts: number; order_id: string } | undefined;
      if (!job) return;
      this.db.prepare('UPDATE outbox SET delivered=?,attempts=attempts+1,next_attempt=?,claim_token=NULL,claim_until=0 WHERE id=?').run(delivered ? 1 : 0, this.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7)), id);
      const pending = this.db.prepare('SELECT 1 FROM outbox WHERE order_id=? AND delivered=0').get(job.order_id);
      const row = this.row(job.order_id); row.notification = pending ? (delivered ? 'pending' : 'retrying') : 'delivered'; this.save(row, this.decode(row));
    });
  }
  /** Persist the next finalized block only after all its events were processed. */
  cursor(next?: number): number { if (next !== undefined) this.db.prepare("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next)); const found = this.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as { value: string } | undefined; return found ? Number(found.value) : this.config.chain.startBlock; }
  /** Delete encrypted PII after terminal retention; retain non-sensitive event deduplication. */
  purgePersonalData(): number {
    this.expire();
    const rows = this.db.prepare("SELECT * FROM orders WHERE status IN ('shipped','refunded','expired')").all() as unknown as Row[];
    let count = 0;
    for (const row of rows) { const data = this.decode(row);
      const deadline = row.status === 'expired' ? row.expires + 86_400_000 : (data.completedAt ?? row.updated) + this.config.retentionDays * 86_400_000;
      if (this.now() < deadline || !data.input.address.name) continue; data.input.address = { name: '', line1: '', city: '', postalCode: '', country: '' }; data.input.contact = { type: 'email', value: '' }; this.save(row, data); count++; }
    if (count) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return count;
  }
}
