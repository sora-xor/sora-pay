import { createMufgDailyProvider, assertMufgFresh, fetchJapanPostEms, buildAvailableEmsRates, fetchJapanPostAvailability, postalRouteAvailable, jstDate } from '../providers/index.js';
import type { MufgUsdJpySnapshot, JapanPostEmsSnapshot, JapanPostAvailabilitySnapshot } from '../providers/index.js';
import { validateConfig, type MerchantConfig } from './config.js';

/** Injectable official-source reads keep routine tests independent of network services. */
export interface CatalogSources {
  fx(): Promise<MufgUsdJpySnapshot>;
  shipping(): Promise<JapanPostEmsSnapshot>;
  postal(): Promise<JapanPostAvailabilitySnapshot>;
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
  let postalCache: { day: string; promise: Promise<JapanPostAvailabilitySnapshot> } | undefined;
  /** A single bounded official status request per JST day, retried after failures. */
  function dailyPostal(day: string): Promise<JapanPostAvailabilitySnapshot> {
    if (postalCache?.day === day) return postalCache.promise;
    const promise = (sources?.postal?.() ?? fetchJapanPostAvailability({ now: clock() })).catch((error) => {
      if (postalCache?.promise === promise) postalCache = undefined;
      throw error;
    });
    postalCache = { day, promise };
    return promise;
  }
  return { async refresh() {
    if (!config.enabled || (!config.providers?.fx && !config.providers?.shipping)) return;
    const today = jstDate(clock());
    const next = structuredClone(config);
    const [fxSnapshot, shipping, postal] = await Promise.all([
      config.providers.fx === 'mufg-daily' && config.pricing.mode === 'daily' && config.pricing.kind !== 'exact-xor' ? (sources?.fx?.() ?? fx.getSnapshot()) : undefined,
      config.providers.shipping === 'japan-post-ems' ? dailyShipping(today) : undefined,
      config.providers.shipping === 'japan-post' ? dailyPostal(today) : undefined,
    ]);
    if (fxSnapshot) {
      assertMufgFresh(fxSnapshot, clock());
      next.pricing = { ...next.pricing, version: `mufg-${fxSnapshot.publicationDate}-${fxSnapshot.jpyPerUsd}`, jpyPerUsd: fxSnapshot.jpyPerUsd, fxSource: fxSnapshot.sourceUrl, fxDate: fxSnapshot.publicationDate };
      next.sourceMetadata = { ...next.sourceMetadata, fx: fxSnapshot };
    }
    if (shipping) {
      // Carrier availability is separate from the merchant's configured destinations.
      const available = buildAvailableEmsRates(shipping, next.blockedCountries ?? []).map((rate) => ({ ...rate, reviewedAt: rate.reviewedAt.slice(0, 10) }));
      if (next.pricing.kind === 'exact-xor') {
        const byId = new Map(available.map((rate) => [rate.id, rate]));
        next.shipping = fixedShippingPrices.flatMap((frozen) => {
          const current = byId.get(frozen.id);
          if (!current || current.maxGrams !== frozen.maxGrams) return [];
          // Keep each launch band's destinations and amount; availability may remove or restore
          // them, but a carrier addition must not silently expand the merchant's checkout.
          const countries = current.countries.filter((country) => frozen.countries.includes(country));
          return countries.length ? [{ ...frozen, countries, reviewedAt: current.reviewedAt }] : [];
        });
      } else next.shipping = available;
      next.sourceMetadata = { ...next.sourceMetadata, shipping: { version: shipping.version, fetchedAt: shipping.fetchedAt, availabilityUpdatedLabel: shipping.availabilityUpdatedLabel, sources: shipping.sources } };
    }
    if (postal) {
      next.shipping = fixedShippingPrices.flatMap((rate) => {
        if (!rate.carrier) throw new Error('Missing postal service');
        const countries = rate.countries.filter((country) => !next.blockedCountries?.includes(country) && postalRouteAvailable(postal, country, rate.carrier!));
        return countries.length ? [{ ...rate, countries }] : [];
      });
      next.sourceMetadata = { ...next.sourceMetadata, shipping: { version: postal.version, fetchedAt: postal.fetchedAt, availabilityUpdatedLabel: postal.availabilityUpdatedLabel, sources: postal.sources } };
    }
    validateConfig(next);
    // Do not yield between validation and publishing the new catalog.
    config.pricing = next.pricing; config.shipping = next.shipping; config.sourceMetadata = next.sourceMetadata;
  } };
}
