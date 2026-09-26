# MOF store pilot storage policy

This is an operator procedure for the separate Sora Pay service on the approved MOF host. It does not install monitoring or an automatic disk-space interlock. Keep public checkout closed until the launch operator can carry out these checks and responses. Never remove another service's data or change infrastructure providers to meet a threshold.

## Admission budget

Before importing a release or opening the public pilot, measure available bytes on the actual shared volume. Record sizes for the production and testnet CAR files, the relay release or rollback copy being added, and the live SQLite database including WAL. Use bytes in the calculation; one GiB is 1,073,741,824 bytes.

Allow twice the combined incoming CAR size for transfer/import staging and blockstore growth, the complete additional relay release size, and the backup exporter's existing reserve of 512 MiB plus three times the database size. These are conservative planning allowances, not claims about deduplication or compression. Keep the current release, rollback data, database and required pins in place.

The volume must retain **at least 10 GiB free after those allowances**. Check free space again after import and before opening checkout. The 10 GiB floor is an initial operating reserve chosen for this shared host, not a measured order capacity. Confirm the next scheduled encrypted backup still completes and restores successfully. A release that fits on disk is not sufficient evidence to open the store.

The September 26 observation of approximately 8.54 GB available was **below this admission floor even before release allowances**. The relay itself occupied about 427.5 MiB; that measurement does not identify the consumer of the remaining shared volume. More approved capacity or an explicit, scoped retention decision by the responsible service owner is required before public admission. Do not delete node databases, IPFS pins, unrelated logs or retained incident evidence.

## Pilot checks and response

Assign a volunteer to check volume free space, relay readiness and scan lag, undelivered notification age, and the most recent verified backup at pilot opening and at least hourly while public ordering is open. Record aggregate measurements only. The backup schedule currently depends on the operator Mac being awake and logged in; an absent or failed scheduled backup needs investigation before further expansion.

| Available storage | Operator response |
| --- | --- |
| At least 10 GiB after planned work | Storage admission criterion passes; payment, shipping, notification, refund and other launch checks still apply. |
| Below 10 GiB | Investigate growth and defer releases or expansion. Do not reopen a closed checkout at this level. |
| Below 5 GiB | Close new order creation and new payment attempts at the existing approved ingress. Preserve receipt recovery, transaction hints, finalized-chain reconciliation and notification retries for existing orders. |
| Below 2 GiB, a disk-full write error, or failed durable persistence | Treat as an incident. Keep new payments closed and restore writable capacity through the responsible host/service owner. Verify database integrity, saved cursor continuity and payment recovery before reopening. |

These thresholds are manual operating actions; `/healthz` currently reports relay readiness, not this storage policy. The existing 2 GiB provisioning check also does not enforce these runtime responses. Prepare and verify the scoped ingress change before public launch; do not substitute shutting down the scanner, blocking all receipt access, deleting the database/WAL, moving the cursor forward, or silently accepting payments without durable records.

Reopen only after the admission reserve is restored, the cause is understood, the scanner has reconciled the interruption, and a verified encrypted backup is current. Review the reserve after real pilot measurements. Buy-on-demand fulfillment remains uncapped by inventory; closing checkout during a storage incident protects order persistence and does not change product pricing or refund obligations.
