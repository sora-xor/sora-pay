/** Independent service work preserves retention and delivery during reconciliation outages. */
export interface RelayCycleWork {
  /** Cooperate with shutdown cancellation before writing any result to durable storage. */
  reconcile(signal: AbortSignal): Promise<void>;
  purge(): unknown;
  notify?(): Promise<unknown>;
}

export type RelayCycleStage = 'reconcile' | 'retention' | 'notification';

/** Cancel a read on shutdown without scheduling a retry or letting its late result advance a scan. */
export function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener('abort', cancel);
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Keep at most one scan and one maintenance pass active, even when connection setup never settles. */
export function createRelayLifecycle(work: RelayCycleWork, onError: (stage: RelayCycleStage, error: unknown) => void): { tick(): Promise<void>; stop(): Promise<void> } {
  const controller = new AbortController();
  let stopped = false;
  let reconcile: Promise<void> | undefined;
  let maintenance: Promise<void> | undefined;
  return {
    async tick() {
      if (stopped) return;
      if (!reconcile) {
        reconcile = Promise.resolve().then(() => work.reconcile(controller.signal)).catch((error: unknown) => {
          if (!controller.signal.aborted) onError('reconcile', error);
        }).finally(() => { reconcile = undefined; });
      }
      if (!maintenance) {
        maintenance = (async () => {
          try { work.purge(); } catch (error) { onError('retention', error); }
          if (work.notify) {
            try { await work.notify(); } catch (error) { onError('notification', error); }
          }
        })().finally(() => { maintenance = undefined; });
      }
      await maintenance;
    },
    async stop() {
      stopped = true;
      controller.abort(new Error('Relay stopping'));
      // Reconciliation cooperates with cancellation; drain current writes/delivery before closing DB.
      await Promise.allSettled([reconcile, maintenance]);
    },
  };
}
