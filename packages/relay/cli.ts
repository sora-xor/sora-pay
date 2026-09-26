import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChainReader } from './chain.js';
import type { NotificationDelivery } from './notifications.js';
import { encryptedBackup, restoreBackup } from './backup.js';

/** Load secrets exclusively from the service environment, without logging their values. */
function secret(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
function key(name: string): Buffer { const value = secret(name); if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`Invalid ${name}`); return Buffer.from(value, 'hex'); }

/** Start one relay process per database; launchd supervises restarts and persisted cursor recovery. */
async function main(): Promise<void> {
  process.umask(0o077);
  const command = process.argv[2] ?? 'serve';
  if (command === 'restore') { await restoreBackup(secret('SORA_PAY_BACKUP_PATH'), secret('SORA_PAY_DB'), key('SORA_PAY_BACKUP_KEY')); return; }
  const [{ loadConfig }, { OrderStore }] = await Promise.all([import('./config.js'), import('./store.js')]);
  const config = loadConfig(secret('SORA_PAY_CONFIG'));
  const dbPath = secret('SORA_PAY_DB'); mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 }); chmodSync(dirname(dbPath), 0o700);
  const store = new OrderStore(dbPath, config, key('SORA_PAY_ENCRYPTION_KEY'));
  if (command === 'backup') { try { await encryptedBackup(store, secret('SORA_PAY_BACKUP_PATH'), key('SORA_PAY_BACKUP_KEY')); } finally { store.close(); } return; }
  if (command !== 'serve') throw new Error('Unknown command');
  // Backup and restore must not initialize RPC, HTTP, provider or notification dependencies.
  const [{ createRelayServer }, { ArchiveRequiredError, connectChain, scanFinalized }, { deliverNext, emailDelivery, telegramDelivery }, { createCatalogRefresher }, { awaitWithAbort, createRelayLifecycle }] = await Promise.all([
    import('./server.js'), import('./chain.js'), import('./notifications.js'), import('./catalog-refresh.js'), import('./lifecycle.js'),
  ]);
  const catalog = createCatalogRefresher(config);
  let lastReconciledAt = 0;
  let ready = false; let chain: ChainReader | undefined; let delivery: NotificationDelivery | undefined; let stopping = false;
  if (config.enabled) {
    if (process.env.SORA_PAY_NOTIFY === 'telegram') delivery = telegramDelivery(secret('SORA_PAY_TELEGRAM_TOKEN'), secret('SORA_PAY_TELEGRAM_CHAT_ID'));
    else if (process.env.SORA_PAY_NOTIFY === 'email') delivery = emailDelivery({ host: secret('SORA_PAY_SMTP_HOST'), port: Number(process.env.SORA_PAY_SMTP_PORT ?? 465), user: secret('SORA_PAY_SMTP_USER'), password: secret('SORA_PAY_SMTP_PASSWORD'), from: secret('SORA_PAY_EMAIL_FROM'), to: secret('SORA_PAY_EMAIL_TO') });
    else throw new Error('Choose a private notification destination before enabling checkout');
  }
  const lifecycle = createRelayLifecycle({
    async reconcile(signal) {
      if (config.enabled) {
        chain ??= await connectChain(config, signal);
        signal.throwIfAborted();
        const result = await scanFinalized(store, chain, 100, signal);
        await awaitWithAbort(chain.assertConfiguration(), signal);
        await awaitWithAbort(catalog.refresh(), signal);
        signal.throwIfAborted(); ready = result.caughtUp; lastReconciledAt = Date.now();
      }
    },
    purge: () => store.purgePersonalData(),
    ...(delivery ? { notify: () => deliverNext(store, delivery!) } : {}),
  }, (stage, error) => {
    ready = false;
    console.error(stage === 'reconcile' && error instanceof ArchiveRequiredError ? 'Relay archive_required: approved historical event source required; checkout paused and scan cursor preserved.' : `Relay ${stage} unavailable; checkout paused.`);
  });
  const server = createRelayServer(store, { operatorToken: secret('SORA_PAY_OPERATOR_TOKEN'), trustLoopbackProxy: process.env.SORA_PAY_TRUST_LOOPBACK_PROXY === '1', ready: () => ready && Date.now() - lastReconciledAt < 30_000, quoteRefund: async (request, gross) => { if (!chain) throw new Error('Refund chain unavailable'); return chain.quoteRefund(request, gross); } });
  server.listen(Number(process.env.SORA_PAY_PORT ?? 39848), '127.0.0.1');
  let wake: (() => void) | undefined;
  let serverClosed: Promise<void> | undefined;
  const stop = (): void => {
    stopping = true; ready = false;
    serverClosed ??= new Promise<void>((resolve) => { server.close(() => resolve()); });
    wake?.(); void lifecycle.stop();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopping) {
      await lifecycle.tick();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); wake = () => { clearTimeout(timer); resolve(); }; if (stopping) wake(); }).finally(() => { wake = undefined; });
    }
  } finally { stop(); await lifecycle.stop(); await serverClosed; await chain?.close(); store.close(); }
}
main().catch(() => { console.error('Sora Pay relay failed to start. Check private configuration and service health.'); process.exitCode = 1; });
