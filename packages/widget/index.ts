import { fromCodec } from '../core/index.js';
import { BrowserPaymentJournal, PaymentController } from './controller.js';
import type { PaymentControllerOptions, PaymentJournal, PaymentSnapshot } from './controller.js';
export * from './controller.js';

/** All visible widget text can be translated by its host application. */
export interface WidgetMessages {
  title: string; merchant: string; amount: string; recipient: string; payer: string; chain: string;
  reference: string; expires: string; fee: string; prepare: string; pay: string; check: string;
  idle: string; estimating: string; ready: string; signing: string; submitted: string;
  uncertain: string; finalized: string; error: string; feeChanged: string;
}

/** English defaults for standalone installations; Polkaswap supplies its locale catalog. */
export const DEFAULT_MESSAGES: WidgetMessages = {
  title: 'Pay with XOR', merchant: 'Merchant', amount: 'Payment', recipient: 'Recipient', payer: 'Paying account',
  chain: 'Network genesis', reference: 'Payment reference', expires: 'Quote expires', fee: 'Estimated network fee',
  prepare: 'Connect and estimate fee', pay: 'Send XOR', check: 'Check payment status', idle: 'Connect your wallet to review the fee.',
  estimating: 'Checking wallet and network fee…', ready: 'Review the payment details before sending.', signing: 'Confirm in your wallet. Keep this page open.',
  submitted: 'Transfer submitted. Waiting for finalized payment verification.',
  uncertain: 'Payment status is uncertain. Check the saved order before taking any further payment action.',
  finalized: 'Payment verified in a finalized block.', error: 'Payment unavailable. Check your wallet, network, balance and quote expiry.',
  feeChanged: 'The network fee changed. Review it and press Send XOR again.',
};

/** Widget options keep private customer records outside the reusable payment component. */
export interface SoraPayOptions extends Omit<PaymentControllerOptions, 'journal'> {
  journal?: PaymentJournal;
  messages?: Partial<WidgetMessages>;
}

/** Public custom-element surface; set configure before attaching or after assigning a fresh quote. */
export interface SoraPayElement extends HTMLElement {
  configure(options: SoraPayOptions): void;
  readonly controller: PaymentController | undefined;
}

/** Register lazily so importing core/widget in server-side tooling never accesses the DOM. */
export function defineSoraPayElement(tagName = 'sora-pay'): void {
  if (customElements.get(tagName)) return;
  class SoraPay extends HTMLElement implements SoraPayElement {
    controller: PaymentController | undefined;
    private options?: SoraPayOptions;
    private stop?: () => void;
    private readonly root = this.attachShadow({ mode: 'open' });

    /** Replace the displayed intent; durable submission state still prevents repeated payment. */
    configure(options: SoraPayOptions): void {
      this.stop?.();
      this.controller?.dispose();
      this.options = options;
      this.controller = new PaymentController({ ...options, journal: options.journal ?? new BrowserPaymentJournal(localStorage) });
      this.stop = this.controller.subscribe((snapshot) => {
        this.render(snapshot);
        this.dispatchEvent(new CustomEvent('sora-pay:state', { detail: snapshot, bubbles: true, composed: true }));
        if (snapshot.state === 'submitted') this.dispatchEvent(new CustomEvent('sora-pay:submitted', { detail: { reference: options.request.reference, transactionHash: snapshot.transactionHash }, bubbles: true, composed: true }));
        if (snapshot.state === 'finalized') this.dispatchEvent(new CustomEvent('sora-pay:finalized', { detail: snapshot.receipt, bubbles: true, composed: true }));
      });
    }

    /** Restore observers if the same element is reattached after navigation. */
    connectedCallback(): void { if (this.options && !this.stop) this.configure(this.options); }

    /** Avoid retaining wallet listeners after the store view is destroyed. */
    disconnectedCallback(): void { this.stop?.(); this.stop = undefined; this.controller?.dispose(); }

    private render(snapshot: PaymentSnapshot): void {
      const request = this.controller?.request;
      if (!request || !this.options) return;
      const messages = { ...DEFAULT_MESSAGES, ...this.options.messages };
      const style = document.createElement('style');
      style.textContent = `
        :host{display:block;color:var(--s-color-base-content-primary,#2a171f);font:inherit}
        section{background:var(--s-color-utility-surface,#f6f1f3);border-radius:24px;padding:28px;box-shadow:var(--s-shadow-element,8px 8px 20px #dcd4d9,-8px -8px 20px #fff)}
        h3{margin:0 0 20px;font-size:20px;font-weight:600}
        dl{display:grid;grid-template-columns:1fr 2fr;gap:12px;margin:0;padding:18px;border-radius:16px;background:var(--s-color-base-background,#f5f0f2);box-shadow:var(--s-shadow-element-pressed,inset 3px 3px 7px #dfd6dc,inset -3px -3px 7px #fff)}
        dt{color:var(--s-color-base-content-secondary,#796971);font-size:13px}dd{margin:0;overflow-wrap:anywhere;font-size:13px}
        p{line-height:1.5;font-size:14px;margin:20px 0}
        button{font:inherit;font-weight:600;color:var(--s-color-on-action,#fff);background:var(--s-color-action-fill,#bf065f);border:0;border-radius:28px;min-height:48px;padding:12px 24px;cursor:pointer;box-shadow:var(--s-shadow-secondary,3px 3px 8px #d5c2cc,-3px -3px 8px #fff)}
        button:hover:not(:disabled){background:var(--s-color-action-fill-hover,#ab0555)}
        button:focus-visible{outline:3px solid var(--s-color-focus-ring,#ab0555);outline-offset:4px}
        button:disabled{color:var(--s-color-on-action-disabled,#796971);background:var(--s-color-action-disabled-fill,#ede4e7);box-shadow:none;cursor:default}
        @media(max-width:480px){section{padding:18px}dl{grid-template-columns:1fr;padding:14px;gap:6px}dd{margin-bottom:8px}button{width:100%}}
      `;
      const section = document.createElement('section');
      section.setAttribute('aria-label', messages.title);
      const title = document.createElement('h3'); title.textContent = messages.title; section.append(title);
      const details = document.createElement('dl');
      const rows = [
        [messages.merchant, request.merchant.name], [messages.amount, `${fromCodec(request.amountCodec, request.decimals)} XOR`],
        [messages.recipient, request.recipient], [messages.payer, request.payer], [messages.chain, request.chainGenesisHash],
        [messages.reference, request.reference], [messages.expires, new Date(request.expiresAt).toLocaleString()],
      ];
      if (snapshot.feeCodec != null) rows.push([messages.fee, `${fromCodec(snapshot.feeCodec, request.decimals)} XOR`]);
      for (const [label = '', value = ''] of rows) {
        const term = document.createElement('dt'); term.textContent = label;
        const description = document.createElement('dd'); description.textContent = value;
        details.append(term, description);
      }
      section.append(details);
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      status.textContent = snapshot.errorCode === 'fee_changed' ? messages.feeChanged : messages[snapshot.state]; section.append(status);
      const button = document.createElement('button'); button.type = 'button';
      if (snapshot.state === 'ready') { button.textContent = messages.pay; button.onclick = () => { void this.controller?.pay(); }; }
      else if (snapshot.state === 'submitted' || snapshot.state === 'uncertain') { button.textContent = messages.check; button.disabled = !this.options.reconcile; button.onclick = () => { void this.controller?.reconcile(); }; }
      else { button.textContent = messages.prepare; button.disabled = !['idle', 'error'].includes(snapshot.state); button.onclick = () => { void this.controller?.prepare(); }; }
      if (snapshot.state !== 'finalized') section.append(button);
      this.root.replaceChildren(style, section);
    }
  }
  customElements.define(tagName, SoraPay);
}

/** Mount imperatively, avoiding a host framework's custom-element compiler configuration. */
export function mountSoraPay(container: HTMLElement, options: SoraPayOptions): SoraPayElement {
  defineSoraPayElement();
  const element = document.createElement('sora-pay') as SoraPayElement;
  element.configure(options);
  container.replaceChildren(element);
  return element;
}
