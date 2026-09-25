import nodemailer from 'nodemailer';
import type { OrderStore } from './store.js';
export type NotificationJob = NonNullable<ReturnType<OrderStore['pendingNotification']>>;
export interface NotificationDelivery { send(job: NotificationJob): Promise<void> }

/** Limit volunteer alerts to private destinations; no customer information enters URL parameters. */
function message(job: NotificationJob): string {
  const { order } = job;
  return [`Sora Pay ${job.kind}`, `Order: ${job.orderId}`, `Quantity: ${order.quantity}`, `Status: ${order.status}`, `Owner: ${order.owner ?? 'unassigned'}`, `Payment: ${order.receivedCodec} codec XOR`, `Address: ${JSON.stringify(order.address)}`, `Contact: ${order.contact.type} ${order.contact.value}`, `Tracking: ${order.tracking ?? '-'}`, 'Claim the order in the private operator queue before fulfillment.'].join('\n');
}

/** Telegram bot credentials are server-only; destination must be an approved private chat. */
export function telegramDelivery(token: string, chatId: string, fetcher: typeof fetch = fetch): NotificationDelivery {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) throw new Error('Invalid Telegram configuration');
  return { async send(job) {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message(job), protect_content: true, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { ok?: boolean };
    if (!response.ok || !body.ok) throw new Error('Telegram delivery failed');
  } };
}

/** SMTP uses certificate-verified implicit TLS; no browser ever receives mail credentials. */
export function emailDelivery(options: { host: string; port: number; user: string; password: string; from: string; to: string }): NotificationDelivery {
  for (const address of [options.from, options.to]) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('Invalid notification email');
  const transport = nodemailer.createTransport({ host: options.host, port: options.port, secure: true, auth: { user: options.user, pass: options.password }, tls: { rejectUnauthorized: true }, connectionTimeout: 15_000, socketTimeout: 15_000 });
  return { async send(job) { await transport.sendMail({ from: options.from, to: options.to, subject: `Sora Pay ${job.kind}: ${job.orderId}`, text: message(job), messageId: `<${job.id}@sora-pay.local>` }); } };
}

/** At-least-once delivery retains failures and stable order IDs for volunteer deduplication. */
export async function deliverNext(store: OrderStore, delivery: NotificationDelivery): Promise<boolean> {
  const job = store.pendingNotification(); if (!job) return false;
  try { await delivery.send(job); store.finishNotification(job.id, job.claimToken, true); } catch { store.finishNotification(job.id, job.claimToken, false); }
  return true;
}
