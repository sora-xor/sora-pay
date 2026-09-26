import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPaymentJournal, PaymentController, WalletNotSubmittedError } from '../../dist/widget/index.js';
import type { PaymentJournal, SubmissionRecord } from '../../dist/widget/index.js';
import type { WalletAdapter, WalletState } from '../../dist/core/index.js';
import { evidence, request, state } from '../core/fixtures.ts';

/** Process-local atomic journal used only by offline tests. */
class MemoryJournal implements PaymentJournal {
  rows = new Map<string, SubmissionRecord>();
  read(reference: string) { return this.rows.get(reference) ?? null; }
  write(record: SubmissionRecord) { this.rows.set(record.reference, record); }
  async claim(record: SubmissionRecord) { if (this.rows.has(record.reference)) return false; this.write(record); return true; }
  remove(reference: string) { this.rows.delete(reference); }
}

/** Controllable host adapter never touches a wallet extension or the network. */
function setup(overrides: Partial<WalletAdapter> = {}, journal = new MemoryJournal()) {
  let callback: (state: WalletState) => void = () => {};
  let current = { ...state };
  let submissions = 0;
  const adapter: WalletAdapter = {
    connect: async () => current, getState: async () => current,
    subscribe: (listener) => { callback = listener; return () => { callback = () => {}; }; },
    estimateFee: async () => ({ amountCodec: '1000' }),
    submit: async () => { submissions++; return { transactionHash: evidence.transactionHash }; }, ...overrides,
  };
  const controller = new PaymentController({ request, adapter, journal, now: () => Date.parse('2030-01-01T00:00:00.000Z'), reconcile: async () => evidence });
  return { controller, adapter, journal, submitted: () => submissions, change: (change: Partial<WalletState>) => { current = { ...current, ...change }; callback(current); } };
}

test('explicit prepare/pay distinguishes submission from finalization and persists before signing', async () => {
  const test = setup();
  assert.equal(test.controller.getSnapshot().state, 'idle');
  await test.controller.pay(); assert.equal(test.submitted(), 0);
  await test.controller.prepare(); assert.equal(test.controller.getSnapshot().state, 'ready');
  await Promise.all([test.controller.pay(), test.controller.pay()]);
  assert.equal(test.submitted(), 1);
  assert.equal(test.controller.getSnapshot().state, 'submitted');
  assert.equal(test.journal.read(request.reference)?.status, 'submitted');
  await test.controller.reconcile(); assert.equal(test.controller.getSnapshot().state, 'finalized');
  await test.controller.pay(); assert.equal(test.submitted(), 1);
  test.controller.dispose();
});

test('unknown broadcast failure blocks retry across a reconstructed controller', async () => {
  let calls = 0;
  const adapter = { submit: async () => { calls++; throw new Error('transport interrupted'); } };
  const first = setup(adapter);
  await first.controller.prepare(); await first.controller.pay();
  assert.equal(first.controller.getSnapshot().state, 'uncertain');
  const restored = setup(adapter, first.journal);
  await restored.controller.prepare(); await restored.controller.pay();
  assert.equal(calls, 1);
  await restored.controller.reconcile(); assert.equal(restored.controller.getSnapshot().state, 'finalized');
  first.controller.dispose(); restored.controller.dispose();
});

test('proven cancellation permits retry; arbitrary errors do not claim rejection', async () => {
  let calls = 0;
  const test = setup({ submit: async () => { calls++; throw new WalletNotSubmittedError(); } });
  await test.controller.prepare(); await test.controller.pay();
  assert.equal(test.controller.getSnapshot().state, 'error');
  assert.equal(test.journal.read(request.reference), null);
  await test.controller.prepare(); await test.controller.pay(); assert.equal(calls, 2);
  test.controller.dispose();
});

test('wallet/account changes invalidate intent and insufficient fees prevent signing', async () => {
  const test = setup();
  await test.controller.prepare(); test.change({ account: request.recipient });
  assert.equal(test.controller.getSnapshot().state, 'idle');
  await test.controller.pay(); assert.equal(test.submitted(), 0);
  await test.controller.prepare(); assert.equal(test.controller.getSnapshot().errorCode, 'wallet_account_changed');
  test.change({ account: request.payer, balanceCodec: request.amountCodec });
  await test.controller.prepare(); assert.equal(test.controller.getSnapshot().errorCode, 'insufficient_balance');
  test.controller.dispose();
});

test('fee changes require another explicit Pay action', async () => {
  let fee = '1';
  const test = setup({ estimateFee: async () => ({ amountCodec: fee }) });
  await test.controller.prepare(); fee = '2'; await test.controller.pay();
  assert.equal(test.submitted(), 0);
  assert.equal(test.controller.getSnapshot().errorCode, 'fee_changed');
  await test.controller.pay(); assert.equal(test.submitted(), 1);
  test.controller.dispose();
});

test('atomic journal claims prevent payment of the same request in two controllers', async () => {
  const journal = new MemoryJournal();
  const first = setup({}, journal); const second = setup({}, journal);
  await Promise.all([first.controller.prepare(), second.controller.prepare()]);
  await Promise.all([first.controller.pay(), second.controller.pay()]);
  assert.equal(first.submitted() + second.submitted(), 1);
  first.controller.dispose(); second.controller.dispose();
});

test('persisting intent is mandatory and callbacks cannot disrupt signing state', async () => {
  const test = setup();
  test.controller.subscribe(() => {});
  await test.controller.prepare();
  test.journal.write = () => { throw new Error('storage full'); };
  await test.controller.pay(); assert.equal(test.submitted(), 0);
  assert.equal(test.controller.getSnapshot().state, 'error');
  test.controller.dispose();
});

test('lost hash timeout is recoverable through trusted evidence and never re-signs', async () => {
  const journal = new MemoryJournal();
  const test = setup();
  const controller = new PaymentController({ request, journal, adapter: { ...test.adapter, submit: () => new Promise(() => {}) }, submissionTimeoutMs: 1, now: () => Date.parse('2030-01-01T00:00:00.000Z'), reconcile: async () => evidence });
  await controller.prepare(); await controller.pay(); assert.equal(controller.getSnapshot().state, 'uncertain');
  await controller.reconcile(); assert.equal(controller.getSnapshot().state, 'finalized');
  controller.dispose(); test.controller.dispose();
});

test('incorrect reconciliation evidence cannot mark a payment finalized', async () => {
  const test = setup();
  const controller = new PaymentController({ request, adapter: test.adapter, journal: new MemoryJournal(), reconcile: async () => ({ ...evidence, amountCodec: '1' }) });
  await controller.reconcile();
  assert.notEqual(controller.getSnapshot().state, 'finalized');
  assert.equal(controller.getSnapshot().errorCode, 'payment_mismatch_amountCodec');
  controller.dispose(); test.controller.dispose();
});

test('browser journal retains only public data and rejects corrupt state', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
  const journal = new BrowserPaymentJournal(storage);
  journal.write({ reference: request.reference, status: 'signing' });
  assert.deepEqual(journal.read(request.reference), { reference: request.reference, status: 'signing' });
  journal.remove(request.reference); assert.equal(journal.read(request.reference), null);
  values.set(`sora-pay:v1:${request.reference}`, '{broken');
  assert.throws(() => journal.read(request.reference), /journal_invalid/);
});

test('expired quote while waiting for a journal claim is released without signing', async () => {
  let now = Date.parse('2030-01-01T00:00:00.000Z');
  const test = setup();
  const journal = new MemoryJournal();
  const claim = journal.claim.bind(journal);
  journal.claim = async (record) => { now = Date.parse(request.expiresAt); return claim(record); };
  const controller = new PaymentController({ request, adapter: test.adapter, journal, now: () => now });
  await controller.prepare(); await controller.pay();
  assert.equal(test.submitted(), 0); assert.equal(journal.read(request.reference), null);
  assert.equal(controller.getSnapshot().errorCode, 'request_expired');
  controller.dispose(); test.controller.dispose();
});

test('unmounting while awaiting a journal claim cannot later open the signer', async () => {
  const test = setup();
  const journal = new MemoryJournal();
  let controller: PaymentController;
  journal.claim = async (record) => { journal.write(record); controller.dispose(); return true; };
  controller = new PaymentController({ request, adapter: test.adapter, journal, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
  await controller.prepare(); await controller.pay();
  assert.equal(test.submitted(), 0); assert.equal(journal.read(request.reference), null);
  test.controller.dispose();
});

test('host safe cancellation codes remain bounded and stable', () => {
  assert.equal(new WalletNotSubmittedError('fee_changed').code, 'fee_changed');
  assert.equal(new WalletNotSubmittedError('private wallet address in error').code, 'wallet_not_submitted');
});
