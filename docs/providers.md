# Official pricing and shipping providers

`@sora/sora-pay/providers` supplies Node-only source ingestion. Nothing executes downloaded scripts, and no network request occurs in tests. Fetches use fixed HTTPS sources, refuse redirects, time out after 15 seconds, and enforce a 2 MB streaming limit.

Polkaswap uses a fixed exact-XOR catalog calculated once at launch. It does **not** call the MUFG provider during normal operation. Its daily Japan Post refresh updates destination availability while retaining published XOR shipping amounts. The MUFG daily provider below remains reusable for other merchants that explicitly choose daily fiat conversion.

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

The complete rate table contains 42 weight bands through 30 kg for each of five zones. Published rates already include the stated tentative extra charges; do not add a second surcharge. JPY prices are integer strings. Parcel weight is separate from token arithmetic; a merchant can use its estimated 120 g per sealed bag plus 80 g per outer parcel until weighed packaging replaces those estimates.

`buildAvailableEmsRates` enables every mapped, fully covered, currently accepted carrier destination except an explicit merchant denylist. The optional `buildApprovedEmsRates` supports merchants that separately maintain a destination allowlist; it is not required. Both return the relay's shipping-table shape with `reviewedAt` as the retrieval date and a stable content-derived source version.

A carrier tick is not a claim that a particular product clears import/customs rules. Before dispatch, volunteers check the actual destination, product requirements, and current service. The store's refund policy covers unfulfillable orders.

`*` means restricted acceptance, not ordinary availability. Such countries, suspended/no-service entries, limited delivery regions, and countries without an explicit zone remain in the snapshot with `requiresReview: true` and reasons. They never silently become checkout destinations. The source currently restricts US EMS and has additional commercial-mail conditions; the generic importer does not assume that a tea sale qualifies as a personal gift. Shipping inquiries can handle exceptional destinations separately.

The availability heading omits its year. We preserve its exact update label and the explicitly dated previous-announcement text instead of inventing a publication timestamp. `fetchedAt`, HTTP `Last-Modified` when present, and SHA-256 hashes give retrieval provenance. Version identity is derived from rates/statuses, so fetching unchanged content does not create a new price version. Carrier changes must be rechecked before dispatch.

The checked-in `packages/providers/data/*.json` files are an audited launch snapshot, not an automatic permanently fresh fallback. Refresh official sources for daily operation. Tests use small constructed fixtures and the frozen launch snapshot; they perform no network calls.
