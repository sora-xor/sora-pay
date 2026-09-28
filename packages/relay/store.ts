import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { PaymentRequest, PaymentReceipt, FinalizedTransferEvidence, FinalizedManualRefundEvidence, RefundReceipt } from '../core/index.js';
import { codecAmount, verifyFinalizedPayment, verifyFinalizedRefund, validatePaymentRequest } from '../core/index.js';
import { accountAddress, merchantPrice, resolveRefundPolicy, type MerchantConfig, type RefundPolicy } from './config.js';
import { decrypt, digest, encrypt, tokenMatches } from './crypto.js';
import { xorToCodec } from './pricing.js';
import type { FinalizedRefundLocator } from './chain.js';

export type OrderStatus = 'unpaid' | 'expired' | 'paid' | 'shipping_review' | 'shipped' | 'refund_pending' | 'refunded';
/** Postal code may be omitted at checkout; stored orders normalize it to an empty string. */
export interface Address { name: string; line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string }
export interface Contact { type: 'email' | 'telegram'; value: string }
export interface CreateOrder { productId: string; quantity: number; shippingRateId: string; payer: string; address: Address; contact: Contact; idempotencyKey: string }
/** Trusted chain quote for one exact refund call, never a browser-provided fee assertion. */
export interface RefundFeeQuote { amountCodec: string; feeCodec: string; blockHash: string; blockNumber: string; expiresAt: string }
/** A customer-agreed amount, distinct from any estimated or proven network fee. */
export interface AgreedRefundDeduction { version: 1; amountCodec: string; consentId: string; recordedAt: string }
/** Exact unsigned-obligation comparison and the operator's private record of explicit customer consent. */
export interface RefundDeductionConsent { owner: string; expectedReference: string; expectedGrossAmountCodec: string; agreedDeductionCodec: string; consentId: string; consentNote: string }
export interface RefundObligation {
  reference: string; recipient: string; grossAmountCodec: string; amountCodec?: string; feeExempt: boolean;
  agreedDeduction?: AgreedRefundDeduction;
  /** Retained after a proven cancellation so consent can never amend an already offered signature. */
  signingStartedAt?: string;
  feeQuote?: RefundFeeQuote; actualFeeCodec?: string; deductedFeeCodec?: string; feeCorrectionCodec?: string;
  status: 'pending' | 'finalized'; receipt?: RefundReceipt; attempt?: { token: string; submitted: boolean; transactionHash?: string };
}
/** Encrypted original terms and obligation remain available only through authenticated operator access. */
export interface RefundAmendmentAudit extends RefundDeductionConsent { version: 1; recordedAt: string; originalPolicy: RefundPolicy; previousRefund: RefundObligation }
/** Operator CAS and existing signing lease; no caller-supplied chain evidence is permitted. */
export interface RefundReconciliation extends FinalizedRefundLocator { owner: string; attemptToken: string; expectedReference: string; expectedGrossAmountCodec: string; expectedAmountCodec: string }
interface RefundReconciliationAudit extends Omit<RefundReconciliation, 'attemptToken'> { version: 1; recordedAt: string; attemptTokenHash: string }
interface PrivateOrder {
  input: CreateOrder; paymentRequest: PaymentRequest; recoveryToken: string; receivedCodec: string; refundedCodec: string;
  refundPolicySnapshot?: RefundPolicy; refundFeesCodec?: string; refundFeeCorrectionCodec?: string;
  refundAgreedDeductionsCodec?: string; refundAmendment?: RefundAmendmentAudit;
  refundReconciliations?: RefundReconciliationAudit[];
  completedAt?: number;
  pricingSnapshot?: MerchantConfig['pricing']; shippingSnapshot?: MerchantConfig['shipping'][number]; fulfilledCodec?: string;
  receipt?: PaymentReceipt; tracking?: string; reviewReason?: string; refund?: RefundObligation;
  /** Prior finalized quotes remain available for audit after a make-good or additional refund. */
  refundHistory?: RefundObligation[];
  attempt?: { token: string; submitted: boolean }; transactionHint?: string;
}
interface Row { id: string; public_reference: string; token_hash: string; idem_hash: string; fingerprint: string; data: string; status: OrderStatus; quantity: number; reserved: number; expires: number; created: number; updated: number; owner: string | null; notification: string }
export interface OrderView { orderId: string; paymentRequest: PaymentRequest; refundPolicy: RefundPolicy; refundFeeCorrectionCodec: string; refundAgreedDeductionsCodec: string; status: Exclude<OrderStatus, 'unpaid'> | 'awaiting_payment'; notificationStatus: string; paymentPending: boolean; receipt?: PaymentReceipt; tracking?: string; refund?: RefundObligation; reviewReason?: string }
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
  private decode(row: Row): PrivateOrder {
    const data = decrypt<PrivateOrder>(row.data, this.key, row.id);
    // Historical obligations predate fee deductions and remain full, even after a policy change.
    if (data.refund && data.refund.grossAmountCodec === undefined) {
      data.refund.grossAmountCodec = data.refund.amountCodec!; data.refund.feeExempt = true;
    }
    return data;
  }
  private outstanding(data: PrivateOrder): bigint { return BigInt(data.receivedCodec) - BigInt(data.refundedCodec) - BigInt(data.refundFeesCodec ?? '0') - BigInt(data.refundAgreedDeductionsCodec ?? '0') - BigInt(data.fulfilledCodec ?? '0'); }
  private save(row: Row, data: PrivateOrder): void { this.db.prepare('UPDATE orders SET data=?,status=?,reserved=?,updated=?,owner=?,notification=? WHERE id=?').run(encrypt(data, this.key, row.id), row.status, row.reserved, this.now(), row.owner, row.notification, row.id); }
  private enqueue(row: Row, kind: string): void { this.db.prepare('INSERT INTO outbox(id,order_id,kind,next_attempt) VALUES(?,?,?,?)').run(randomUUID(), row.id, kind, this.now()); row.notification = 'pending'; }
  private expire(): void { this.db.prepare("UPDATE orders SET status='expired',reserved=0,updated=expires WHERE status='unpaid' AND expires<=?").run(this.now()); }
  /** Apply current destination restrictions only to catalog offers and newly created orders. */
  private shippingCountryAllowed(country: string): boolean {
    return !this.config.blockedCountries?.includes(country) && (this.config.approvedShippingCountries === undefined || this.config.approvedShippingCountries.includes(country));
  }
  /** Public catalog exposes only publishable merchant policy and current available stock. */
  catalog(): Record<string, unknown> {
    this.expire();
    if (!this.config.enabled) return { enabled: false, version: this.config.version ?? 'unconfigured' };
    const c = this.config;
    return { enabled: true, version: c.version, merchant: c.merchant, refundPolicy: resolveRefundPolicy(c.refundPolicy), pricing: c.pricing.kind === 'exact-xor' ? { kind: 'exact-xor', version: c.pricing.version } : c.pricing, sourceMetadata: c.pricing.kind === 'exact-xor' ? (c.sourceMetadata?.shipping ? { shipping: c.sourceMetadata.shipping } : undefined) : c.sourceMetadata, product: { id: c.product.id, name: c.product.name, grams: c.product.grams, packedGrams: c.product.packedGrams, packagingGrams: c.product.packagingGrams ?? 0, fulfillmentMode: c.fulfillmentMode ?? 'stocked', priceXor: merchantPrice(c, c.product), stockAvailable: this.available() }, shipping: c.shipping.filter((rate) => rate.countries.some((country) => this.shippingCountryAllowed(country))).map((rate) => ({ id: rate.id, label: rate.label, maxGrams: rate.maxGrams, reviewedAt: rate.reviewedAt, countries: rate.countries.filter((country) => this.shippingCountryAllowed(country)), priceXor: merchantPrice(c, rate, true) })), chain: { genesisHash: c.chain.genesisHash, assetId: c.chain.assetId, decimals: c.chain.decimals, denomination: c.chain.denomination, recipient: c.chain.recipient } };
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
      if (input.productId !== c.product.id || !rate || !this.shippingCountryAllowed(input.address.country)) throw new RelayError(400, 'Shipping inquiry required for this order');
      if (this.available() !== null && this.available()! < input.quantity) throw new RelayError(409, 'Insufficient stock');
      const price = BigInt(xorToCodec(merchantPrice(c, c.product), c.chain.decimals, c.chain.denomination));
      const shipping = BigInt(xorToCodec(merchantPrice(c, rate, true), c.chain.decimals, c.chain.denomination));
      const id = randomUUID(); const token = randomBytes(32).toString('hex'); const expires = this.now() + 30 * 60_000;
      const request: PaymentRequest = { version: 1, merchant: { id: c.merchant.id, name: c.merchant.name }, chainGenesisHash: c.chain.genesisHash, assetId: c.chain.assetId, recipient: c.chain.recipient, payer: input.payer, amountCodec: (price * BigInt(input.quantity) + shipping).toString(), decimals: c.chain.decimals, denomination: c.chain.denomination, reference: `sp_${randomBytes(16).toString('hex')}`, expiresAt: new Date(expires).toISOString() };
      validatePaymentRequest(request);
      const data: PrivateOrder = { input, paymentRequest: request, recoveryToken: token, receivedCodec: '0', refundedCodec: '0', refundPolicySnapshot: resolveRefundPolicy(c.refundPolicy), pricingSnapshot: structuredClone(c.pricing), shippingSnapshot: structuredClone(rate) };
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
  private view(row: Row, data: PrivateOrder): OrderView {
    const refund = data.refund ? structuredClone(data.refund) : undefined;
    if (refund) delete refund.attempt;
    return { orderId: row.id, paymentRequest: data.paymentRequest, refundPolicy: resolveRefundPolicy(data.refundPolicySnapshot), refundFeeCorrectionCodec: data.refundFeeCorrectionCodec ?? '0', refundAgreedDeductionsCodec: data.refundAgreedDeductionsCodec ?? '0', status: row.status === 'unpaid' ? 'awaiting_payment' : row.status, notificationStatus: row.notification, paymentPending: Boolean(data.attempt), receipt: data.receipt, tracking: data.tracking, refund, reviewReason: data.reviewReason };
  }
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
      if (!refund || refund.reference !== evidence.reference || refund.amountCodec === undefined) continue;
      const request = { ...data.paymentRequest, payer: data.paymentRequest.recipient, recipient: data.paymentRequest.payer, amountCodec: refund.amountCodec, reference: refund.reference };
      let receipt: PaymentReceipt;
      try { receipt = verifyFinalizedPayment(request, { ...evidence, payer: accountAddress(evidence.payer), recipient: accountAddress(evidence.recipient) }); } catch { return false; }
      return this.settleRefund(row, data, refund, receipt, eventId, evidence);
    }
    return false;
  }
  /** Both automatic and explicitly bound refunds use the same atomic liability/outbox accounting. */
  private settleRefund(row: Row, data: PrivateOrder, refund: RefundObligation, receipt: RefundReceipt, eventId: string, evidence: FinalizedTransferEvidence | FinalizedManualRefundEvidence): boolean {
    const request = receipt.request; const amount = refund.amountCodec;
    if (amount === undefined) return false;
    let deducted = 0n; let correction = 0n; let agreed = 0n;
    if (refund.agreedDeduction) {
      const amendment = data.refundAmendment;
      if (!amendment || amendment.expectedReference !== refund.reference || amendment.consentId !== refund.agreedDeduction.consentId || amendment.agreedDeductionCodec !== refund.agreedDeduction.amountCodec || !refund.feeExempt || refund.feeQuote) return false;
      agreed = codecAmount(refund.agreedDeduction.amountCodec, false);
      if (BigInt(amount) + agreed !== BigInt(refund.grossAmountCodec)) return false;
      // The agreed waiver settles only on an exact finalized transfer. Actual fees are evidence,
      // never substituted for the agreed amount or charged again to the customer.
      const fee = evidence.networkFee;
      if (fee && accountAddress(fee.payer) === request.payer && fee.assetId === request.assetId) refund.actualFeeCodec = codecAmount(fee.amountCodec).toString();
    } else if (!refund.feeExempt) {
      if (!refund.feeQuote) return false;
      const quoted = BigInt(refund.feeQuote.feeCodec);
      const fee = evidence.networkFee;
      if (fee && accountAddress(fee.payer) === request.payer && fee.assetId === request.assetId) {
        const actual = codecAmount(fee.amountCodec); refund.actualFeeCodec = actual.toString();
        deducted = actual < quoted ? actual : quoted;
      }
      // An unproven fee is not charged to the customer. Preserve the observed transfer
      // and make the undeducted remainder a separate, fee-exempt liability.
      correction = quoted - deducted;
      data.refundFeeCorrectionCodec = (BigInt(data.refundFeeCorrectionCodec ?? '0') + correction).toString();
      if (correction > 0n) data.reviewReason = refund.actualFeeCodec === undefined ? 'refund_fee_evidence_missing' : 'refund_fee_correction';
    } else if (resolveRefundPolicy(data.refundPolicySnapshot).mode === 'net-network-fee') {
      const remaining = BigInt(data.refundFeeCorrectionCodec ?? '0') - BigInt(refund.grossAmountCodec);
      if (remaining < 0n) throw new Error('Invalid refund correction accounting');
      data.refundFeeCorrectionCodec = remaining.toString();
    }
    refund.status = 'finalized'; refund.receipt = receipt; refund.deductedFeeCodec = deducted.toString(); refund.feeCorrectionCodec = correction.toString();
    data.refundedCodec = (BigInt(data.refundedCodec) + BigInt(amount)).toString();
    data.refundFeesCodec = (BigInt(data.refundFeesCodec ?? '0') + deducted).toString();
    if (agreed > 0n) data.refundAgreedDeductionsCodec = (BigInt(data.refundAgreedDeductionsCodec ?? '0') + agreed).toString();
    row.status = this.outstanding(data) > 0n ? 'shipping_review' : 'refunded';
    if (row.status === 'refunded') { data.completedAt = this.now(); delete data.reviewReason; }
    if (!data.tracking) row.reserved = 0;
    this.db.prepare('INSERT INTO payments VALUES(?,?,?,?)').run(eventId, row.id, 'refund', encrypt(evidence, this.key, eventId)); this.enqueue(row, row.status === 'refunded' ? 'refunded' : 'shipping_review'); this.save(row, data); return true;
  }

  /** Strict owner/lease/CAS validation happens before RPC work and again inside the settlement transaction. */
  checkRefundReconciliation(id: string, input: RefundReconciliation): RefundObligation | undefined {
    const fields = ['owner', 'attemptToken', 'expectedReference', 'expectedGrossAmountCodec', 'expectedAmountCodec', 'blockNumber', 'blockHash', 'transactionHash', 'eventIndex'];
    if (!input || typeof input !== 'object' || Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field)) || typeof input.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.owner) || typeof input.attemptToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.attemptToken) || typeof input.expectedReference !== 'string' || !/^sp_[a-f0-9]{32}$/.test(input.expectedReference) || typeof input.blockNumber !== 'string' || !/^[1-9][0-9]{0,15}$/.test(input.blockNumber) || !Number.isSafeInteger(Number(input.blockNumber)) || typeof input.blockHash !== 'string' || !/^0x[a-f0-9]{64}$/.test(input.blockHash) || typeof input.transactionHash !== 'string' || !/^0x[a-f0-9]{64}$/.test(input.transactionHash) || !Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) throw new RelayError(400, 'Invalid refund reconciliation');
    try { codecAmount(input.expectedGrossAmountCodec, false); codecAmount(input.expectedAmountCodec, false); } catch { throw new RelayError(400, 'Invalid refund reconciliation amount'); }
    const row = this.row(id); const data = this.decode(row);
    if (row.owner !== input.owner) throw new RelayError(409, 'Refund is not assigned to this operator');
    const { attemptToken, ...binding } = input;
    const prior = data.refundReconciliations?.find((audit) => audit.blockHash === input.blockHash && audit.eventIndex === input.eventIndex);
    if (prior) {
      if (prior.attemptTokenHash !== digest(attemptToken) || Object.entries(binding).some(([name, value]) => prior[name as keyof RefundReconciliationAudit] !== value)) throw new RelayError(409, 'Refund reconciliation already recorded');
      const saved = [data.refund, ...(data.refundHistory ?? [])].find((refund) => refund?.reference === input.expectedReference && refund.receipt && 'reconciliation' in refund.receipt && refund.receipt.evidence.blockHash === input.blockHash && refund.receipt.evidence.eventIndex === input.eventIndex);
      if (!saved || saved.status !== 'finalized') throw new RelayError(409, 'Reconciled refund is unavailable');
      const result = structuredClone(saved); delete result.attempt; return result;
    }
    const refund = data.refund;
    if (row.status !== 'refund_pending' || !refund || refund.status !== 'pending' || refund.receipt || refund.reference !== input.expectedReference || refund.grossAmountCodec !== input.expectedGrossAmountCodec || refund.amountCodec !== input.expectedAmountCodec || !refund.attempt || refund.attempt.token !== attemptToken || !refund.signingStartedAt || (refund.attempt.transactionHash !== undefined && refund.attempt.transactionHash.toLowerCase() !== input.transactionHash)) throw new RelayError(409, 'Pending refund no longer matches reconciliation');
    return undefined;
  }

  /** Bind a trusted finalized direct transfer without inventing an on-chain reference or moving the scanner. */
  reconcileRefund(id: string, input: RefundReconciliation, evidence: FinalizedManualRefundEvidence): RefundObligation {
    return this.atomic(() => {
      const already = this.checkRefundReconciliation(id, input); if (already) return already;
      const row = this.row(id); const data = this.decode(row); const refund = data.refund!;
      for (const field of ['blockNumber', 'blockHash', 'transactionHash', 'eventIndex'] as const) if (evidence[field] !== input[field]) throw new RelayError(409, 'Refund evidence does not match locator');
      // The convenience customer receipt can be absent for a mismatched payment or replaced by
      // a later exact payment; the original funding event remains immutable in the evidence table.
      const funding = (this.db.prepare("SELECT event_id,evidence FROM payments WHERE order_id=? AND kind='payment' AND evidence IS NOT NULL").all(id) as { event_id: string; evidence: string }[])
        .map((entry) => decrypt<FinalizedTransferEvidence>(entry.evidence, this.key, entry.event_id))
        .sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.eventIndex - b.eventIndex)[0];
      const originalTime = Date.parse(funding?.finalizedAt ?? ''); const signingTime = Date.parse(refund.signingStartedAt!); const transferTime = Date.parse(evidence.finalizedAt);
      if (!funding || !Number.isFinite(originalTime) || !Number.isFinite(signingTime) || !Number.isFinite(transferTime) || transferTime < originalTime || transferTime < signingTime || BigInt(evidence.blockNumber) < BigInt(funding.blockNumber)) throw new RelayError(409, 'Refund evidence predates this obligation');
      const request = { ...data.paymentRequest, payer: data.paymentRequest.recipient, recipient: data.paymentRequest.payer, amountCodec: refund.amountCodec!, reference: refund.reference };
      const recordedAt = new Date(this.now()).toISOString(); let receipt: RefundReceipt;
      try { receipt = verifyFinalizedRefund(request, { status: 'finalized', request, evidence, reconciliation: { version: 1, kind: 'operator-bound', expectedReference: refund.reference, recordedAt } }); }
      catch { throw new RelayError(409, 'Finalized refund evidence does not match obligation'); }
      const eventId = `${evidence.blockHash}:${evidence.eventIndex}`;
      if (this.db.prepare('SELECT event_id FROM payments WHERE event_id=?').get(eventId)) throw new RelayError(409, 'Transfer evidence already consumed');
      // Direct transfers have one physical movement even if multiple pallets report its mirror events.
      const consumed = this.db.prepare('SELECT event_id,evidence FROM payments WHERE evidence IS NOT NULL').all() as { event_id: string; evidence: string }[];
      if (consumed.some((entry) => { const prior = decrypt<FinalizedTransferEvidence | FinalizedManualRefundEvidence>(entry.evidence, this.key, entry.event_id); return prior.blockHash === evidence.blockHash && prior.transactionHash === evidence.transactionHash; })) throw new RelayError(409, 'Physical transfer already consumed');
      const { attemptToken, ...binding } = input;
      (data.refundReconciliations ??= []).push({ ...binding, version: 1, recordedAt, attemptTokenHash: digest(attemptToken) });
      refund.attempt!.submitted = true; refund.attempt!.transactionHash = evidence.transactionHash;
      if (!this.settleRefund(row, data, refund, receipt, eventId, evidence)) throw new RelayError(409, 'Refund accounting does not match obligation');
      const result = structuredClone(refund); delete result.attempt; return result;
    });
  }

  /** Read a private operator queue; HTTP authentication is enforced by the server. */
  list(): Array<OrderView & { owner: string | null; address: Address; contact: Contact; quantity: number; receivedCodec: string; refundedCodec: string; refundFeesCodec: string }> {
    this.expire(); return (this.db.prepare("SELECT * FROM orders ORDER BY CASE WHEN status IN ('paid','shipping_review','refund_pending') THEN 0 ELSE 1 END, created ASC LIMIT 500").all() as unknown as Row[]).map((row) => { const data = this.decode(row); return { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec, refundFeesCodec: data.refundFeesCodec ?? '0' }; });
  }
  /** Fetch one operator record directly even when a large queue is paginated by the caller. */
  operatorOrder(id: string): ReturnType<OrderStore['list']>[number] & { refundHistory: RefundObligation[]; refundAmendment?: RefundAmendmentAudit; refundReconciliations: RefundReconciliationAudit[] } {
    const row = this.row(id); const data = this.decode(row);
    return { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec, refundFeesCodec: data.refundFeesCodec ?? '0', refundHistory: structuredClone(data.refundHistory ?? []), refundReconciliations: structuredClone(data.refundReconciliations ?? []), ...(data.refundAmendment ? { refundAmendment: structuredClone(data.refundAmendment) } : {}) };
  }
  /** Return private chain evidence for payment mismatch/refund reconciliation. */
  paymentEvidence(id: string): Array<FinalizedTransferEvidence | FinalizedManualRefundEvidence> {
    this.row(id);
    const rows = this.db.prepare('SELECT event_id,evidence FROM payments WHERE order_id=?').all(id) as { event_id: string; evidence: string | null }[];
    return rows.filter((row) => row.evidence).map((row) => decrypt<FinalizedTransferEvidence | FinalizedManualRefundEvidence>(row.evidence!, this.key, row.event_id));
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
      if (row.owner !== owner || row.status !== 'shipping_review' || data.tracking || data.refund?.status === 'pending' || this.outstanding(data) !== BigInt(data.paymentRequest.amountCodec) || BigInt(data.refundFeeCorrectionCodec ?? '0') > 0n) throw new RelayError(409, 'Order requires refund or reconciliation');
      if (!row.reserved && this.available() !== null && this.available()! < row.quantity) throw new RelayError(409, 'Insufficient stock');
      row.reserved = 1; row.status = 'paid'; delete data.reviewReason; this.enqueue(row, 'paid'); this.save(row, data);
    });
  }
  /** Reserve an immutable reference; net-policy drafts require a trusted quote before signing. */
  refund(id: string, owner: string): RefundObligation {
    return this.atomic(() => {
      const row = this.row(id); const data = this.decode(row);
      if (row.owner !== owner || !['paid', 'shipping_review', 'refund_pending'].includes(row.status)) throw new RelayError(409, 'Order is not refundable by this operator');
      if (data.refund?.status === 'pending') return data.refund;
      const outstanding = this.outstanding(data); const correction = BigInt(data.refundFeeCorrectionCodec ?? '0');
      if (outstanding <= 0n || correction > outstanding) throw new RelayError(409, 'No outstanding payment');
      const amount = correction > 0n ? correction : outstanding;
      const feeExempt = correction > 0n || resolveRefundPolicy(data.refundPolicySnapshot).mode === 'full';
      if (data.refund?.status === 'finalized') {
        const previous = structuredClone(data.refund); delete previous.attempt;
        (data.refundHistory ??= []).push(previous);
      }
      data.refund = { reference: `sp_${randomBytes(16).toString('hex')}`, recipient: data.paymentRequest.payer, grossAmountCodec: amount.toString(), ...(feeExempt ? { amountCodec: amount.toString() } : {}), feeExempt, status: 'pending' };
      row.status = 'refund_pending'; this.enqueue(row, 'refund_pending'); this.save(row, data); return data.refund;
    });
  }
  /** Apply one explicitly consented fixed deduction to an unsigned legacy refund, preserving its original policy. */
  agreeRefundDeduction(id: string, consent: RefundDeductionConsent): RefundObligation {
    const fields = ['owner', 'expectedReference', 'expectedGrossAmountCodec', 'agreedDeductionCodec', 'consentId', 'consentNote'];
    if (!consent || typeof consent !== 'object' || Object.keys(consent).length !== fields.length || fields.some((field) => !Object.hasOwn(consent, field)) ||
      typeof consent.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(consent.owner) || typeof consent.expectedReference !== 'string' || !/^sp_[a-f0-9]{32}$/.test(consent.expectedReference) ||
      typeof consent.consentId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(consent.consentId) ||
      typeof consent.consentNote !== 'string' || !consent.consentNote.trim() || consent.consentNote.length > 2000 || /[\x00-\x1f\x7f]/.test(consent.consentNote)) throw new RelayError(400, 'Invalid refund deduction consent');
    let gross: bigint; let deduction: bigint;
    try { gross = codecAmount(consent.expectedGrossAmountCodec, false); deduction = codecAmount(consent.agreedDeductionCodec, false); }
    catch { throw new RelayError(400, 'Invalid refund deduction amount'); }
    if (deduction >= gross) throw new RelayError(400, 'Agreed deduction must leave a positive refund');
    return this.atomic(() => {
      const row = this.row(id); const data = this.decode(row);
      if (row.owner !== consent.owner) throw new RelayError(409, 'Order is not assigned to this operator');
      if (data.refundAmendment) {
        if (fields.some((field) => data.refundAmendment![field as keyof RefundDeductionConsent] !== consent[field as keyof RefundDeductionConsent])) throw new RelayError(409, 'Refund consent already recorded');
        const prior = [data.refund, ...(data.refundHistory ?? [])].find((refund) => refund?.reference === consent.expectedReference && refund.agreedDeduction?.consentId === consent.consentId);
        if (!prior) throw new RelayError(409, 'Amended refund is unavailable');
        const result = structuredClone(prior); delete result.attempt; return result;
      }
      const refund = data.refund;
      if (row.status !== 'refund_pending' || !refund || refund.status !== 'pending' || refund.reference !== consent.expectedReference || refund.grossAmountCodec !== consent.expectedGrossAmountCodec ||
        refund.amountCodec !== refund.grossAmountCodec || !refund.feeExempt || refund.attempt || refund.signingStartedAt || refund.receipt || refund.feeQuote || refund.agreedDeduction || refund.actualFeeCodec !== undefined || refund.deductedFeeCodec !== undefined ||
        resolveRefundPolicy(data.refundPolicySnapshot).mode !== 'full' || refund.recipient !== data.paymentRequest.payer || this.outstanding(data) !== gross || BigInt(data.refundFeeCorrectionCodec ?? '0') !== 0n || data.tracking) throw new RelayError(409, 'Unsigned full refund no longer matches consent');
      const recordedAt = new Date(this.now()).toISOString();
      data.refundAmendment = { ...consent, version: 1, recordedAt, originalPolicy: resolveRefundPolicy(data.refundPolicySnapshot), previousRefund: structuredClone(refund) };
      refund.agreedDeduction = { version: 1, amountCodec: deduction.toString(), consentId: consent.consentId, recordedAt };
      refund.amountCodec = (gross - deduction).toString();
      this.enqueue(row, 'refund_amended'); this.save(row, data);
      return structuredClone(refund);
    });
  }
  /** Save a short-lived authoritative quote only while no refund signing attempt exists. */
  quoteRefund(id: string, owner: string, quote: RefundFeeQuote): RefundObligation {
    return this.atomic(() => {
      const row = this.row(id); const data = this.decode(row); const refund = data.refund;
      if (row.owner !== owner || row.status !== 'refund_pending' || !refund || refund.status !== 'pending' || refund.feeExempt || refund.attempt) throw new RelayError(409, 'Refund quote is unavailable');
      let amount: bigint; let fee: bigint;
      try { amount = codecAmount(quote.amountCodec, false); fee = codecAmount(quote.feeCodec); } catch { throw new RelayError(400, 'Invalid refund fee quote'); }
      const expiry = Date.parse(quote.expiresAt);
      if (!/^0x[a-f0-9]{64}$/.test(quote.blockHash) || !/^(0|[1-9][0-9]{0,19})$/.test(quote.blockNumber) || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== quote.expiresAt || expiry <= this.now() || expiry > this.now() + 300_000 || fee >= BigInt(refund.grossAmountCodec) || amount + fee !== BigInt(refund.grossAmountCodec)) throw new RelayError(400, 'Invalid refund fee quote');
      refund.feeQuote = structuredClone(quote); refund.amountCodec = amount.toString(); this.save(row, data); return refund;
    });
  }
  /** Reserve one refund signing attempt; an uncertain transaction must be reconciled, not resent. */
  refundAttempt(id: string, owner: string): { attemptToken: string } {
    return this.atomic(() => {
      const row = this.row(id); const data = this.decode(row); const refund = data.refund;
      if (row.owner !== owner || row.status !== 'refund_pending' || !refund || refund.status !== 'pending' || refund.attempt) throw new RelayError(409, 'Refund signing is already pending or unavailable');
      if (refund.amountCodec === undefined || (!refund.feeExempt && (!refund.feeQuote || Date.parse(refund.feeQuote.expiresAt) <= this.now()))) throw new RelayError(409, 'A current refund fee quote is required');
      const attemptToken = randomBytes(32).toString('hex'); refund.signingStartedAt ??= new Date(this.now()).toISOString(); refund.attempt = { token: attemptToken, submitted: false }; this.save(row, data); return { attemptToken };
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
      return { id: job.id, claimToken, orderId: row.id, kind: job.kind, attempts: job.attempts, order: { ...this.view(row, data), owner: row.owner, address: data.input.address, contact: data.input.contact, quantity: row.quantity, receivedCodec: data.receivedCodec, refundedCodec: data.refundedCodec, refundFeesCodec: data.refundFeesCodec ?? '0' } };
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
  /** Preserve a storage pause across restarts and encrypted backups; only the admission guard writes it. */
  storageAdmissionPaused(paused?: boolean): boolean | undefined {
    if (paused !== undefined) this.db.prepare("INSERT INTO meta(key,value) VALUES('storage-admission',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ version: 1, paused }));
    const found = this.db.prepare("SELECT value FROM meta WHERE key='storage-admission'").get() as { value: string } | undefined;
    if (!found) return undefined;
    const saved: unknown = JSON.parse(found.value);
    if (!saved || typeof saved !== 'object' || (saved as { version?: unknown }).version !== 1 || typeof (saved as { paused?: unknown }).paused !== 'boolean') throw new Error('Invalid saved storage admission state');
    return (saved as { paused: boolean }).paused;
  }
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
