import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentError } from '../../dist/core/index.js';
import type { WalletAdapter } from '../../dist/core/index.js';
import { DEFAULT_MESSAGES, defineSoraPayElement } from '../../dist/widget/index.js';
import type { SoraPayElement, SoraPayOptions, SubmissionRecord } from '../../dist/widget/index.js';
import { request, state } from '../core/fixtures.ts';

/** Minimal DOM fixture exercises the actual rendered text and actions without browser dependencies. */
class ElementFixture {
  children: ElementFixture[] = [];
  attributes = new Map<string, string>();
  textContent = '';
  disabled = false;
  shadowRoot?: ElementFixture;
  readonly tag: string;
  constructor(tag = 'sora-pay') { this.tag = tag; }
  append(...nodes: ElementFixture[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: ElementFixture[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  attachShadow() { this.shadowRoot = new ElementFixture('shadow'); return this.shadowRoot; }
  dispatchEvent() { return true; }
}

test('widget maps insufficient native XOR safely and preserves uncertain-payment instructions', async (t) => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const registry = new Map<string, typeof ElementFixture>();
  const globals = {
    HTMLElement: ElementFixture,
    customElements: { get: (name: string) => registry.get(name), define: (name: string, element: typeof ElementFixture) => registry.set(name, element) },
    document: { createElement: (tag: string) => new ElementFixture(tag) },
    CustomEvent: class {},
  };
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true }); }
  t.after(() => { for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } });
  defineSoraPayElement('message-test');
  const Constructor = registry.get('message-test')!;

  async function render(overrides: Partial<WalletAdapter>, messages?: SoraPayOptions['messages'], pay = false) {
    let submissions = 0; const journal = new Map<string, SubmissionRecord>();
    const element = new Constructor() as unknown as SoraPayElement & ElementFixture;
    const adapter: WalletAdapter = {
      connect: async () => state, getState: async () => state, subscribe: () => () => {},
      estimateFee: async () => ({ amountCodec: '1000' }),
      submit: async () => { submissions++; throw new Error('Synthetic unknown signing result'); }, ...overrides,
    };
    element.configure({ request, adapter, messages, now: () => Date.parse('2030-01-01T00:00:00.000Z'), journal: {
      read: (reference) => journal.get(reference) ?? null,
      write: (record) => { journal.set(record.reference, record); },
      claim: async (record) => { if (journal.has(record.reference)) return false; journal.set(record.reference, record); return true; },
      remove: (reference) => { journal.delete(reference); },
    } });
    await element.controller!.prepare(); if (pay) await element.controller!.pay();
    const section = element.shadowRoot!.children.find((node) => node.tag === 'section')!;
    const status = section.children.find((node) => node.attributes.get('role') === 'status')!.textContent;
    const button = section.children.find((node) => node.tag === 'button')!;
    const snapshot = element.controller!.getSnapshot(); element.controller!.dispose();
    return { status, button, submissions, snapshot, journal };
  }

  const short = await render({ getState: async () => ({ ...state, balanceCodec: request.amountCodec }) }, undefined, true);
  assert.equal(short.snapshot.errorCode, 'insufficient_balance');
  assert.equal(short.status, 'Not enough native XOR in this wallet to cover the payment and network fee.');
  assert.equal(short.button.textContent, DEFAULT_MESSAGES.prepare);
  assert.equal(short.submissions, 0); assert.equal(short.journal.size, 0);

  const localized = await render({ estimateFee: async () => { throw new PaymentError('insufficient_balance'); } }, { insufficientBalance: 'Solde XOR insuffisant pour le paiement et les frais.' });
  assert.equal(localized.status, 'Solde XOR insuffisant pour le paiement et les frais.');

  for (const error of [new Error('insufficient_balance: synthetic private wallet context'), new PaymentError('synthetic private RPC details')]) {
    const unknown = await render({ estimateFee: async () => { throw error; } });
    assert.equal(unknown.status, DEFAULT_MESSAGES.error); assert.equal(unknown.submissions, 0);
    assert.doesNotMatch(unknown.status, /synthetic|private|insufficient_balance/);
  }

  const uncertain = await render({ submit: async () => { throw new PaymentError('insufficient_balance'); } }, undefined, true);
  assert.equal(uncertain.snapshot.state, 'uncertain'); assert.equal(uncertain.status, DEFAULT_MESSAGES.uncertain);
  assert.equal(uncertain.button.textContent, DEFAULT_MESSAGES.check); assert.equal(uncertain.journal.get(request.reference)?.status, 'uncertain');
});
