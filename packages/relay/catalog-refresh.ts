import { createMufgDailyProvider, assertMufgFresh, fetchJapanPostEms, buildAvailableEmsRates, jstDate } from '../providers/index.js';
import type { MufgUsdJpySnapshot, JapanPostEmsSnapshot } from '../providers/index.js';
import { validateConfig, type MerchantConfig } from './config.js';

/** Injectable official-source reads keep routine tests independent of network services. */
export interface CatalogSources {
  fx(): Promise<MufgUsdJpySnapshot>;
  shipping(): Promise<JapanPostEmsSnapshot>;
  clock(): Date;
}

/** Consult the bank provider on each loop and cache shipping daily; publish both atomically; previous orders retain their saved quote snapshots. */
export function createCatalogRefresher(config: MerchantConfig, sources?: Partial<CatalogSources>): { refresh(): Promise<void> } {
  const clock = sources?.clock ?? (() => new Date());
  const fx = createMufgDailyProvider({ clock });
  // Keep the launch catalog even if a destination temporarily becomes unavailable.
  const fixedShippingPrices = structuredClone(config.shipping);
  let shippingCache: { day: string; snapshot: JapanPostEmsSnapshot } | undefined;
  let shippingPending: { day: string; promise: Promise<JapanPostEmsSnapshot> } | undefined;
  /** Cache carrier reads independently; the bank may publish a new quote later in the same day. */
  async function dailyShipping(day: string): Promise<JapanPostEmsSnapshot> {
    if (shippingCache?.day === day) return shippingCache.snapshot;
    if (shippingPending?.day === day) return shippingPending.promise;
    const promise = (sources?.shipping?.() ?? fetchJapanPostEms({ now: clock() })).then((snapshot) => {
      shippingCache = { day, snapshot }; return snapshot;
    }).finally(() => { if (shippingPending?.promise === promise) shippingPending = undefined; });
    shippingPending = { day, promise };
    return promise;
  }
  return { async refresh() {
    if (!config.enabled || (!config.providers?.fx && !config.providers?.shipping)) return;
    const today = jstDate(clock());
    const next = structuredClone(config);
    const [fxSnapshot, shipping] = await Promise.all([
      config.providers.fx === 'mufg-daily' && config.pricing.mode === 'daily' && config.pricing.kind !== 'exact-xor' ? (sources?.fx?.() ?? fx.getSnapshot()) : undefined,
      config.providers.shipping === 'japan-post-ems' ? dailyShipping(today) : undefined,
    ]);
    if (fxSnapshot) {
      assertMufgFresh(fxSnapshot, clock());
      next.pricing = { ...next.pricing, version: `mufg-${fxSnapshot.publicationDate}-${fxSnapshot.jpyPerUsd}`, jpyPerUsd: fxSnapshot.jpyPerUsd, fxSource: fxSnapshot.sourceUrl, fxDate: fxSnapshot.publicationDate };
      next.sourceMetadata = { ...next.sourceMetadata, fx: fxSnapshot };
    }
    if (shipping) {
      // Every complete carrier-supported destination is considered automatically. No per-country
      // operator allowlist is required; volunteers check food/import legality before dispatch.
      const available = buildAvailableEmsRates(shipping, next.blockedCountries ?? []).map((rate) => ({ ...rate, reviewedAt: rate.reviewedAt.slice(0, 10) }));
      if (next.pricing.kind === 'exact-xor') {
        const byId = new Map(available.map((rate) => [rate.id, rate]));
        next.shipping = fixedShippingPrices.flatMap((frozen) => {
          const current = byId.get(frozen.id);
          if (!current || current.maxGrams !== frozen.maxGrams) return [];
          // Carrier tariffs may change; an exact-XOR merchant keeps its published amount until
          // explicitly repriced. Only supported destinations/weight bands are refreshed here.
          return [{ ...frozen, countries: current.countries, reviewedAt: current.reviewedAt }];
        });
      } else next.shipping = available;
      next.sourceMetadata = { ...next.sourceMetadata, shipping: { version: shipping.version, fetchedAt: shipping.fetchedAt, availabilityUpdatedLabel: shipping.availabilityUpdatedLabel, sources: shipping.sources } };
    }
    validateConfig(next);
    // Do not yield between validation and publishing the new catalog.
    config.pricing = next.pricing; config.shipping = next.shipping; config.sourceMetadata = next.sourceMetadata;
  } };
}
