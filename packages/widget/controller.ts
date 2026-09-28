import { assertWalletMatches, codecAmount, PaymentError, validatePaymentRequest, verifyFinalizedPayment } from '../core/index.js';
import type { FinalizedTransferEvidence, PaymentReceipt, PaymentRequest, WalletAdapter } from '../core/index.js';

/** Only public payment metadata is retained here; private order recovery belongs to the merchant. */
export interface SubmissionRecord {
  reference: string;
  status: 'signing' | 'submitted' | 'uncertain' | 'finalized';
  transactionHash?: string;
}

/** Synchronous durable writes must succeed before a wallet can be asked to sign. */
export interface PaymentJournal {
  read(reference: string): SubmissionRecord | null;
  write(record: SubmissionRecord): void;
  /** Atomically claim an unsubmitted reference across concurrent tabs/processes. */
  claim(record: SubmissionRecord): Promise<boolean>;
  /** May only clear a signing intent after explicit proof that submission never occurred. */
  remove(reference: string): void;
}

/** States deliberately distinguish accepted submission from independently verified settlement. */
export type PaymentState = 'idle' | 'estimating' | 'ready' | 'signing' | 'submitted' | 'uncertain' | 'finalized' | 'error';

/** Safe display state emitted to any framework. */
export interface PaymentSnapshot {
  state: PaymentState;
  feeCodec?: string;
  transactionHash?: string;
  errorCode?: string;
  receipt?: PaymentReceipt;
}

/** A rejection can enable retry only when the adapter proves that no broadcast occurred. */
export class WalletNotSubmittedError extends PaymentError {
  constructor(code = 'wallet_not_submitted') { super(/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'wallet_not_submitted'); }
}

/** Configuration for the independently testable controller. */
export interface PaymentControllerOptions {
  request: PaymentRequest;
  adapter: WalletAdapter;
  journal: PaymentJournal;
  /** Trusted merchant/chain-reader callback. This must not consume browser-supplied evidence. */
  reconcile?: (request: Readonly<PaymentRequest>) => Promise<FinalizedTransferEvidence | null>;
  now?: () => number;
  submissionTimeoutMs?: number;
}

/** Browser persistence contains no shipping data, authentication credentials or recovery token. */
export class BrowserPaymentJournal implements PaymentJournal {
  private readonly storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  /** Fail closed when a journal is corrupted; never turn uncertainty into another Pay button. */
  read(reference: string): SubmissionRecord | null {
    const raw = this.storage.getItem(`sora-pay:v1:${reference}`);
    if (raw == null) return null;
    try {
      const record: SubmissionRecord = JSON.parse(raw);
      if (record.reference !== reference || !['signing', 'submitted', 'uncertain', 'finalized'].includes(record.status)) throw new Error();
      if (record.transactionHash != null && !/^0x[a-f0-9]{64}$/.test(record.transactionHash)) throw new Error();
      return record;
    } catch { throw new PaymentError('journal_invalid'); }
  }
  /** Persist an intent before any wallet call that might broadcast. */
  write(record: SubmissionRecord): void { this.storage.setItem(`sora-pay:v1:${record.reference}`, JSON.stringify(record)); }
  /** Web Locks serializes the check/write across tabs; unavailable locking disables payment safely. */
  async claim(record: SubmissionRecord): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new PaymentError('journal_lock_unavailable');
    return navigator.locks.request(`sora-pay:${record.reference}`, () => {
      if (this.read(record.reference)) return false;
      this.write(record);
      return true;
    });
  }
  /** Used only following a proven rejection before submission. */
  remove(reference: string): void { this.storage.removeItem(`sora-pay:v1:${reference}`); }
}

/** Wallet orchestration without framework, DOM, HTTP or access to spending keys. */
export class PaymentController {
  readonly request: Readonly<PaymentRequest>;
  private readonly options: PaymentControllerOptions;
  private readonly listeners = new Set<(snapshot: PaymentSnapshot) => void>();
  private snapshot: PaymentSnapshot = { state: 'idle' };
  private walletRevision = 0;
  private readonly unsubscribe: () => void;
  private busy = false;
  private disposed = false;

  constructor(options: PaymentControllerOptions) {
    validatePaymentRequest(options.request);
    const request = structuredClone(options.request);
    Object.freeze(request.merchant);
    this.request = Object.freeze(request);
    this.options = options;
    if (options.submissionTimeoutMs != null && (!Number.isInteger(options.submissionTimeoutMs) || options.submissionTimeoutMs < 1 || options.submissionTimeoutMs > 120_000)) throw new PaymentError('invalid_timeout');
    const previous = options.journal.read(request.reference);
    if (previous) this.snapshot = { state: previous.status === 'signing' || previous.status === 'finalized' ? 'uncertain' : previous.status, transactionHash: previous.transactionHash };
    this.unsubscribe = options.adapter.subscribe(() => {
      this.walletRevision += 1;
      if (['idle', 'ready', 'error'].includes(this.snapshot.state)) this.update({ state: 'idle' });
    });
  }

  /** Return a copy so consumers cannot mutate the controller's receipt or state. */
  getSnapshot(): PaymentSnapshot { return structuredClone(this.snapshot); }

  /** Immediately deliver the current state, then subsequent changes. */
  subscribe(listener: (snapshot: PaymentSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /** Calculate a fee after connecting; checking the account never initiates a transfer. */
  async prepare(): Promise<void> {
    if (this.busy || this.disposed || this.hasSubmission()) return;
    this.busy = true;
    this.update({ state: 'estimating' });
    try {
      await this.options.adapter.connect();
      const revision = this.walletRevision;
      assertWalletMatches(this.request, await this.options.adapter.getState(), this.now());
      const fee = await this.options.adapter.estimateFee(this.request);
      codecAmount(fee.amountCodec);
      assertWalletMatches(this.request, await this.options.adapter.getState(), this.now(), fee.amountCodec);
      if (revision !== this.walletRevision) throw new PaymentError('wallet_changed');
      if (this.disposed) return;
      this.update({ state: 'ready', feeCodec: fee.amountCodec });
    } catch (error) { this.update({ state: 'error', errorCode: safeError(error) }); }
    finally { this.busy = false; }
  }

  /** Sign once after explicit user action; unknown failures require reconciliation instead of retry. */
  async pay(): Promise<void> {
    if (this.busy || this.disposed || this.snapshot.state !== 'ready' || this.hasSubmission()) return;
    this.busy = true;
    let intentWritten = false;
    let submitInvoked = false;
    try {
      const revision = this.walletRevision;
      const fee = await this.options.adapter.estimateFee(this.request);
      codecAmount(fee.amountCodec);
      assertWalletMatches(this.request, await this.options.adapter.getState(), this.now(), fee.amountCodec);
      if (revision !== this.walletRevision) throw new PaymentError('wallet_changed');
      if (this.disposed) return;
      if (fee.amountCodec !== this.snapshot.feeCodec) {
        this.update({ state: 'ready', feeCodec: fee.amountCodec, errorCode: 'fee_changed' });
        return;
      }
      if (!await this.options.journal.claim({ reference: this.request.reference, status: 'signing' })) {
        this.update({ ...this.snapshot, state: 'uncertain', errorCode: 'payment_already_started' });
        return;
      }
      intentWritten = true;
      assertWalletMatches(this.request, await this.options.adapter.getState(), this.now(), fee.amountCodec);
      if (revision !== this.walletRevision) throw new PaymentError('wallet_changed');
      if (this.disposed) throw new PaymentError('payment_disposed');
      this.update({ ...this.snapshot, state: 'signing', errorCode: undefined });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        submitInvoked = true;
        const result = await Promise.race([
          this.options.adapter.submit(this.request),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new PaymentError('submission_timeout')), this.options.submissionTimeoutMs ?? 60_000); }),
        ]);
        if (!/^0x[a-f0-9]{64}$/.test(result.transactionHash)) throw new PaymentError('invalid_transaction');
        this.options.journal.write({ reference: this.request.reference, status: 'submitted', transactionHash: result.transactionHash });
        this.update({ ...this.snapshot, state: 'submitted', transactionHash: result.transactionHash });
      } finally { if (timeout != null) clearTimeout(timeout); }
    } catch (error) {
      if (intentWritten && (!submitInvoked || error instanceof WalletNotSubmittedError)) {
        try {
          this.options.journal.remove(this.request.reference);
          this.update({ state: 'error', errorCode: safeError(error) });
        } catch { this.update({ ...this.snapshot, state: 'uncertain', errorCode: 'journal_unavailable' }); }
      } else if (intentWritten) {
        try { this.options.journal.write({ reference: this.request.reference, status: 'uncertain', transactionHash: this.snapshot.transactionHash }); } catch { /* The earlier durable signing record remains authoritative. */ }
        this.update({ ...this.snapshot, state: 'uncertain', errorCode: safeError(error) });
      } else this.update({ state: 'error', errorCode: safeError(error) });
    } finally { this.busy = false; }
  }

  /** Recover a finalized payment from the merchant, including after a lost transaction callback. */
  async reconcile(): Promise<void> {
    if (this.busy || this.disposed || this.snapshot.state === 'finalized' || !this.options.reconcile) return;
    this.busy = true;
    try {
      const evidence = await this.options.reconcile(this.request);
      if (!evidence) return;
      const receipt = verifyFinalizedPayment(this.request, evidence);
      this.options.journal.write({ reference: this.request.reference, status: 'finalized', transactionHash: evidence.transactionHash });
      this.update({ state: 'finalized', transactionHash: evidence.transactionHash, receipt });
    } catch (error) { this.update({ ...this.snapshot, errorCode: safeError(error) }); }
    finally { this.busy = false; }
  }

  /** Release wallet observers without removing durable submission history. */
  dispose(): void { this.disposed = true; this.unsubscribe(); this.listeners.clear(); }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private hasSubmission(): boolean {
    try { return this.options.journal.read(this.request.reference) != null; }
    catch { this.update({ ...this.snapshot, state: 'uncertain', errorCode: 'journal_unavailable' }); return true; }
  }
  private update(snapshot: PaymentSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try { listener(this.getSnapshot()); } catch { /* Host rendering callbacks cannot affect payment execution. */ }
    }
  }
}

/** Do not surface arbitrary wallet errors; they may contain private RPC or account context. */
function safeError(error: unknown): string { return error instanceof PaymentError ? error.code : 'payment_unavailable'; }
