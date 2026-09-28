# Official pricing and shipping providers

`@sora/sora-pay/providers` supplies Node-only source ingestion. Nothing executes downloaded scripts, and no network request occurs in tests. Fetches use fixed HTTPS sources, refuse redirects, time out after 15 seconds, and enforce a 2 MB streaming limit.

Providers are optional server-side inputs. Choose an exact-XOR catalog to keep published amounts fixed, or explicitly configure fiat conversion and a merchant-selected USD/XOR rate. Carrier availability and merchant eligibility are separate: this library parses source data; the merchant owns product-specific route decisions and dispatch requirements.

## MUFG USD/JPY

```ts
import { createMufgDailyProvider } from '@sora/sora-pay/providers';
const provider = createMufgDailyProvider();
const snapshot = await provider.getSnapshot();
// snapshot.jpyPerUsd is an exact decimal string.
```

The [official MUFG source](https://www.bk.mufg.jp/gdocs/kinri/kinri_data_utf8.js) is a `var kinri_deta = { ... }` JSON assignment. Only the assigned JSON is parsed. `G001TTSZ` and `G001TTBZ` are averaged with integer arithmetic. We call this **derived midpoint of TTS and TTB**, rather than claiming that MUFG publishes a TTM in this source. See [MUFG's exchange-rate page](https://www.bk.mufg.jp/ippan/kinri/list_j/kinri/kawase.html).

The USD-specific `G001DATE` is interpreted in JST. The snapshot retains both the publication date/time and the separate retrieval time and source hash. Freshness uses the original publication date, permitting at most seven Japan calendar days for bank holidays. Refetching an old document never resets that age. Malformed, future, inverted, or implausible quotes fail closed.

The daily provider coalesces concurrent requests and refreshes on each new JST date. If a morning fetch still reports the previous bank day, it rechecks at most every 15 minutes until today's publication appears. It refuses new quotes if that day's required refresh fails; an already saved payment request remains immutable. `initial` snapshots are hints only: the first request still checks the official source. Persist the complete snapshot with the order price version, and never change saved order amounts when rates change.

## Japan Post EMS

```ts
import { fetchJapanPostEms, buildAvailableEmsRates } from '@sora/sora-pay/providers';
const snapshot = await fetchJapanPostEms();
const shipping = buildAvailableEmsRates(snapshot, merchantBlockedCountries);
```

The importer joins three official tables:

- [EMS rates for all five zones](https://www.post.japanpost.jp/send/oversea/charge/list-ems/all_en.html).
- [Countries, zones and delivery-area coverage](https://www.post.japanpost.jp/service/send/oversea/list/delivery/ems/country/all_en.html).
- [Current service availability](https://www.post.japanpost.jp/service/send/oversea/information/overview_en.html), retaining a link to the detailed [restriction chart](https://www.post.japanpost.jp/service/send/oversea/information/overview_en.pdf).

The complete rate table contains 42 weight bands through 30 kg for each of five zones. Published rates already include the stated tentative extra charges; do not add a second surcharge. JPY prices are integer strings. Parcel weight is separate from token arithmetic; configure product and packaging weights for the actual fulfillment method, and verify packing before dispatch.

`buildAvailableEmsRates` enables every mapped, fully covered, currently accepted carrier destination except an explicit merchant denylist. The optional `buildApprovedEmsRates` supports merchants that separately maintain a destination allowlist; it is not required. Both return the relay's shipping-table shape with `reviewedAt` as the retrieval date and a stable content-derived source version.

For an exact-XOR merchant, automatic refresh only retains countries present in the same configured launch band and currently accepted by the carrier. Suspended countries can return to their original band when service resumes, at the frozen XOR price. Empty bands are omitted; a different zone or weight band is never substituted. Newly supported countries remain shipping inquiries until an explicit merchant catalog update adds them. This destination boundary does not itself establish food-import or organic-label approval, and saved orders retain their original quotes.

Carrier acceptance does not establish product import or customs eligibility. Merchants can restrict their shipping arrays and optionally use `approvedShippingCountries`. Maintain the corresponding product, destination and documentation review in the merchant application's runbook; recheck it with current carrier service before dispatch.

`*` means restricted acceptance, not ordinary availability. Such countries, suspended/no-service entries, limited delivery regions, and countries without an explicit zone remain in the snapshot with `requiresReview: true` and reasons. They never silently become checkout destinations. The generic importer does not infer that a commercial shipment qualifies for a personal-use or gift exception. Shipping inquiries can handle exceptional destinations separately.

The availability heading omits its year. We preserve its exact update label and the explicitly dated previous-announcement text instead of inventing a publication timestamp. `fetchedAt`, HTTP `Last-Modified` when present, and SHA-256 hashes give retrieval provenance. Version identity is derived from rates/statuses, so fetching unchanged content does not create a new price version. Carrier changes must be rechecked before dispatch.

The checked-in `packages/providers/data/*.json` files are source snapshots captured for reproducibility, not an automatic permanently fresh fallback. Refresh official sources for daily operation. Tests use small constructed fixtures and the frozen source snapshots; they perform no network calls.

## Service-specific Japan Post routes

Use `providers.shipping: "japan-post"` with a `carrier` object on each configured rate. The services are `ems`, `parcel-air`, `parcel-surface`, `small-packet-air`, `small-packet-surface`, and domestic-only `letter-pack-plus`. The provider reads the corresponding columns of the official availability chart, once per JST date. It never applies the EMS column to a parcel or small packet. SAL is excluded because the carrier has suspended it.

`carrier.restrictedReviewVersion` can bind an explicitly reviewed restricted route to the exact semantic availability snapshot. A later status-table change invalidates that exception. `carrier.availabilityCountry` is only for documented territory coverage where no separate country row exists; a territory's own row takes precedence in catalog assembly. The original `japan-post-ems` importer remains available for existing deployments.

`parsePostalRates` validates all five published zones, separating goods-capable small packets from letters, printed matter and D-mail. It checks every weight boundary and keeps included air-parcel surcharges exactly once. Merchants build their own catalog from these tariffs and supply exact XOR shipping amounts. Daily availability checks never change those frozen amounts.

Keep catalog construction, packing rules, destination approvals, source records, quantity/value limits and dispatch documents in the integrating merchant's repository. The provider parses carrier tariffs and service availability; it does not select products, determine parcel packing or establish import permission.
