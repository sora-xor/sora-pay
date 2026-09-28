/** Framework-independent payment contracts and exact native-XOR amount helpers. */
export const NATIVE_XOR_ASSET_ID = '0x0200000000000000000000000000000000000000000000000000000000000000';
export const MAX_CODEC_AMOUNT = (1n << 128n) - 1n;
const HASH = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,38})$/;
const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{47,50}$/;

/** Immutable merchant intent. Addresses must be checksum-validated and normalized by the host. */
export interface PaymentRequest {
  version: 1;
  merchant: { id: string; name: string };
  chainGenesisHash: string;
  assetId: string;
  recipient: string;
  payer: string;
  amountCodec: string;
  decimals: number;
  /** Chain-provided denomination snapshot; a change requires a new quote. */
  denomination: string;
  /** Public random reference only. Never place customer information here. */
  reference: string;
  expiresAt: string;
}

/** Wallet state uses the same canonical SS58 prefix as the merchant request. */
export interface WalletState {
  account: string | null;
  chainGenesisHash: string | null;
  assetId: string | null;
  decimals: number | null;
  denomination: string | null;
  /** Spendable native XOR after any chain locks/existential reserve. */
  balanceCodec?: string;
}

/** A host supplies only constrained XOR payment operations, never an arbitrary signing API. */
export interface WalletAdapter {
  connect(): Promise<WalletState>;
  getState(): Promise<WalletState>;
  subscribe(listener: (state: WalletState) => void): () => void;
  estimateFee(request: Readonly<PaymentRequest>): Promise<{ amountCodec: string }>;
  /** Must revalidate intent and current wallet state immediately before invoking the signer. */
  submit(request: Readonly<PaymentRequest>): Promise<{ transactionHash: string }>;
}

/** Evidence must come from a trusted finalized-chain reader, never a browser-supplied assertion. */
export interface FinalizedNetworkFee {
  payer: string;
  assetId: string;
  amountCodec: string;
  /** Fee event in the same finalized extrinsic as the transfer. */
  eventIndex: number;
}

/** Evidence must come from a trusted finalized-chain reader, never a browser-supplied assertion. */
export interface FinalizedTransferEvidence {
  chainGenesisHash: string;
  assetId: string;
  payer: string;
  recipient: string;
  amountCodec: string;
  reference: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  eventIndex: number;
  successful: boolean;
  finalized: boolean;
  finalizedAt: string;
  /** Absent when the reader cannot unambiguously establish the actual native fee. */
  networkFee?: FinalizedNetworkFee;
}

/** A receipt is constructed only after matching trusted finalized transfer evidence. */
export interface PaymentReceipt {
  status: 'finalized';
  request: PaymentRequest;
  evidence: FinalizedTransferEvidence;
}

/** A direct assets.transfer has no on-chain store reference; preserve that fact in its evidence. */
export interface FinalizedManualRefundEvidence extends Omit<FinalizedTransferEvidence, 'reference'> {
  reference: null;
  transferKind: 'assets-transfer';
}

/** The authenticated relay binds trusted chain evidence to an existing refund obligation. */
export interface ManualRefundReceipt {
  status: 'finalized';
  request: PaymentRequest;
  evidence: FinalizedManualRefundEvidence;
  reconciliation: {
    version: 1;
    kind: 'operator-bound';
    expectedReference: string;
    recordedAt: string;
  };
}

/** Automatic referenced refunds and explicitly reconciled direct transfers remain distinguishable. */
export type RefundReceipt = PaymentReceipt | ManualRefundReceipt;

/** Small stable error codes are safe for translated UI; errors contain no private order information. */
export class PaymentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PaymentError';
    this.code = code;
  }
}

/** Assert a condition without embedding untrusted fields or wallet errors in the message. */
function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PaymentError(code);
}

/** Parse a bounded canonical uint128 amount; reject exponent notation and leading zeros. */
export function codecAmount(value: string, allowZero = true): bigint {
  ensure(typeof value === 'string' && UINT.test(value), 'invalid_amount');
  const result = BigInt(value);
  ensure(result <= MAX_CODEC_AMOUNT && (allowZero || result > 0n), 'invalid_amount');
  return result;
}

/** Validate chain precision before constructing a power of ten. */
function checkDecimals(decimals: number): void {
  ensure(Number.isInteger(decimals) && decimals >= 0 && decimals <= 38, 'invalid_decimals');
}

/** Parse a plain decimal into an exact rational, with bounded input and precision. */
export function parseDecimal(value: string): { numerator: bigint; denominator: bigint } {
  ensure(typeof value === 'string' && value.length <= 80 && /^(0|[1-9][0-9]*)(\.[0-9]{1,38})?$/.test(value), 'invalid_decimal');
  const [whole = '0', fraction = ''] = value.split('.');
  const numerator = BigInt(whole + fraction);
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/** Convert human XOR to exact codec units. Refuse precision loss instead of rounding signed amounts. */
export function toCodec(amount: string, decimals = 18): string {
  checkDecimals(decimals);
  const { numerator, denominator } = parseDecimal(amount);
  const scaled = numerator * 10n ** BigInt(decimals);
  ensure(scaled % denominator === 0n, 'amount_precision_loss');
  const result = (scaled / denominator).toString();
  codecAmount(result);
  return result;
}

/** Convert exact codec units to human XOR without locale formatting or exponent notation. */
export function fromCodec(amountCodec: string, decimals = 18): string {
  checkDecimals(decimals);
  const value = codecAmount(amountCodec);
  if (decimals === 0) return value.toString();
  const text = value.toString().padStart(decimals + 1, '0');
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}

/** Freeze a JPY price using a merchant-selected USD/JPY snapshot and fixed USD-per-XOR credit. */
export function convertJpyToXor(jpy: string, jpyPerUsd: string, usdPerXor: string, precision = 6): string {
  checkDecimals(precision);
  const price = parseDecimal(jpy);
  const fx = parseDecimal(jpyPerUsd);
  const credit = parseDecimal(usdPerXor);
  ensure(price.numerator > 0n && fx.numerator > 0n && credit.numerator > 0n, 'invalid_price');
  const scale = 10n ** BigInt(precision);
  const top = price.numerator * fx.denominator * credit.denominator * scale;
  const bottom = price.denominator * fx.numerator * credit.numerator;
  const roundedUp = (top + bottom - 1n) / bottom;
  return fromCodec(roundedUp.toString(), precision);
}

/** Validate normalized request syntax, bounded amounts, and the native XOR asset. */
export function validatePaymentRequest(request: PaymentRequest): void {
  ensure(request != null && typeof request === 'object' && request.version === 1, 'invalid_request');
  ensure(typeof request.merchant?.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(request.merchant.id), 'invalid_merchant');
  ensure(typeof request.merchant.name === 'string' && request.merchant.name.trim().length > 0 && request.merchant.name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(request.merchant.name), 'invalid_merchant');
  ensure(typeof request.chainGenesisHash === 'string' && HASH.test(request.chainGenesisHash), 'invalid_chain');
  ensure(request.assetId === NATIVE_XOR_ASSET_ID, 'invalid_asset');
  ensure(typeof request.recipient === 'string' && ACCOUNT.test(request.recipient), 'invalid_recipient');
  ensure(typeof request.payer === 'string' && ACCOUNT.test(request.payer), 'invalid_payer');
  ensure(request.payer !== request.recipient, 'self_payment');
  codecAmount(request.amountCodec, false);
  codecAmount(request.denomination, false);
  checkDecimals(request.decimals);
  ensure(typeof request.reference === 'string' && /^sp_[a-f0-9]{32}$/.test(request.reference), 'invalid_reference');
  ensure(isTimestamp(request.expiresAt), 'invalid_expiry');
}

/** Accept canonical ISO timestamps only, preventing locale-dependent parsing. */
function isTimestamp(value: string): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Check connected wallet, denomination, balance and expiry before fee estimation and signing. */
export function assertWalletMatches(request: PaymentRequest, state: WalletState, now = Date.now(), feeCodec = '0'): void {
  validatePaymentRequest(request);
  ensure(Number.isFinite(now) && now < Date.parse(request.expiresAt), 'request_expired');
  ensure(state.account === request.payer, 'wallet_account_changed');
  ensure(state.chainGenesisHash === request.chainGenesisHash, 'wallet_network_changed');
  ensure(state.assetId === request.assetId, 'wallet_asset_changed');
  ensure(state.decimals === request.decimals, 'wallet_precision_changed');
  ensure(state.denomination === request.denomination, 'wallet_denomination_changed');
  const fee = codecAmount(feeCodec);
  ensure(state.balanceCodec != null, 'wallet_balance_unavailable');
  ensure(codecAmount(state.balanceCodec) >= codecAmount(request.amountCodec) + fee, 'insufficient_balance');
}

/** Verify a successful finalized transfer. Expired quotes remain verifiable for manual refund review. */
export function verifyFinalizedPayment(request: PaymentRequest, evidence: FinalizedTransferEvidence): PaymentReceipt {
  validatePaymentRequest(request);
  ensure(evidence != null && typeof evidence === 'object', 'invalid_evidence');
  ensure(evidence.finalized === true && evidence.successful === true, 'payment_not_finalized');
  ensure(HASH.test(evidence.transactionHash) && HASH.test(evidence.blockHash), 'invalid_transaction');
  ensure(typeof evidence.blockNumber === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(evidence.blockNumber), 'invalid_block');
  ensure(Number.isSafeInteger(evidence.eventIndex) && evidence.eventIndex >= 0, 'invalid_event');
  ensure(isTimestamp(evidence.finalizedAt), 'invalid_finalized_at');
  codecAmount(evidence.amountCodec, false);
  if (evidence.networkFee !== undefined) {
    const fee = evidence.networkFee;
    ensure(fee != null && typeof fee === 'object' && typeof fee.payer === 'string' && ACCOUNT.test(fee.payer) && fee.assetId === NATIVE_XOR_ASSET_ID, 'invalid_network_fee');
    codecAmount(fee.amountCodec);
    ensure(Number.isSafeInteger(fee.eventIndex) && fee.eventIndex >= 0 && fee.eventIndex !== evidence.eventIndex, 'invalid_network_fee');
  }
  for (const key of ['chainGenesisHash', 'assetId', 'payer', 'recipient', 'amountCodec', 'reference'] as const) {
    ensure(evidence[key] === request[key], `payment_mismatch_${key}`);
  }
  return { status: 'finalized', request: structuredClone(request), evidence: structuredClone(evidence) };
}

/** Narrow parsed receipt objects without accepting arrays or reflecting their fields in errors. */
function receiptRecord(value: unknown, code: string): Record<string, unknown> {
  ensure(value != null && typeof value === 'object' && !Array.isArray(value), code);
  return value as Record<string, unknown>;
}

/**
 * Verify a refund receipt against independently expected intent from the saved order.
 * An operator binding is an assertion by the trusted merchant relay, not a chain reference
 * or cryptographic proof of authorization. Never use browser-supplied evidence to create it.
 */
export function verifyFinalizedRefund(request: PaymentRequest, value: unknown): RefundReceipt {
  validatePaymentRequest(request);
  const receipt = receiptRecord(value, 'invalid_refund_receipt');
  ensure(receipt.status === 'finalized', 'payment_not_finalized');
  const embedded = receiptRecord(receipt.request, 'invalid_request');
  validatePaymentRequest(embedded as unknown as PaymentRequest);
  const merchant = receiptRecord(embedded.merchant, 'invalid_merchant');
  ensure(merchant.id === request.merchant.id && merchant.name === request.merchant.name, 'refund_mismatch_merchant');
  for (const key of ['version', 'chainGenesisHash', 'assetId', 'payer', 'recipient', 'amountCodec', 'decimals', 'denomination', 'reference', 'expiresAt'] as const) {
    ensure(embedded[key] === request[key], `refund_mismatch_${key}`);
  }
  const evidence = receiptRecord(receipt.evidence, 'invalid_evidence');
  if (!('reconciliation' in receipt)) {
    ensure(!('transferKind' in evidence), 'invalid_refund_binding');
    return verifyFinalizedPayment(request, evidence as unknown as FinalizedTransferEvidence);
  }
  const binding = receiptRecord(receipt.reconciliation, 'invalid_refund_binding');
  ensure(binding.version === 1 && binding.kind === 'operator-bound' && binding.expectedReference === request.reference, 'invalid_refund_binding');
  ensure(isTimestamp(binding.recordedAt as string), 'invalid_reconciliation_at');
  ensure(evidence.reference === null && evidence.transferKind === 'assets-transfer', 'invalid_refund_binding');
  ensure(evidence.finalized === true && evidence.successful === true, 'payment_not_finalized');
  ensure(typeof evidence.transactionHash === 'string' && HASH.test(evidence.transactionHash) && typeof evidence.blockHash === 'string' && HASH.test(evidence.blockHash), 'invalid_transaction');
  ensure(typeof evidence.blockNumber === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(evidence.blockNumber), 'invalid_block');
  ensure(Number.isSafeInteger(evidence.eventIndex) && (evidence.eventIndex as number) >= 0, 'invalid_event');
  ensure(isTimestamp(evidence.finalizedAt as string), 'invalid_finalized_at');
  ensure(Date.parse(binding.recordedAt as string) >= Date.parse(evidence.finalizedAt as string), 'invalid_reconciliation_at');
  codecAmount(evidence.amountCodec as string, false);
  for (const key of ['chainGenesisHash', 'assetId', 'payer', 'recipient', 'amountCodec'] as const) {
    ensure(evidence[key] === request[key], `payment_mismatch_${key}`);
  }
  if (evidence.networkFee !== undefined) {
    const fee = receiptRecord(evidence.networkFee, 'invalid_network_fee');
    ensure(fee.payer === request.payer && fee.assetId === NATIVE_XOR_ASSET_ID, 'invalid_network_fee');
    codecAmount(fee.amountCodec as string);
    ensure(Number.isSafeInteger(fee.eventIndex) && (fee.eventIndex as number) >= 0 && fee.eventIndex !== evidence.eventIndex, 'invalid_network_fee');
  }
  return {
    status: 'finalized', request: structuredClone(request),
    evidence: structuredClone(evidence) as unknown as FinalizedManualRefundEvidence,
    reconciliation: { version: 1, kind: 'operator-bound', expectedReference: request.reference, recordedAt: binding.recordedAt as string },
  };
}

/** Stable payment-event identity for durable database uniqueness constraints. */
export function paymentEventId(evidence: FinalizedTransferEvidence | FinalizedManualRefundEvidence): string {
  ensure(HASH.test(evidence.chainGenesisHash) && HASH.test(evidence.blockHash), 'invalid_event');
  ensure(Number.isSafeInteger(evidence.eventIndex) && evidence.eventIndex >= 0, 'invalid_event');
  return `${evidence.chainGenesisHash}:${evidence.blockHash}:${evidence.eventIndex}`;
}
