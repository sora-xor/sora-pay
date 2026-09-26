# MOF store pilot storage policy

This is an operator procedure for the separate Sora Pay service on the approved MOF host. It does not install monitoring or an automatic disk-space interlock. Keep public checkout closed until the launch operator can carry out these checks and responses. Never remove another service's data or change infrastructure providers to meet a threshold.

## Admission budget

Before importing a release or opening the public pilot, measure available bytes on the actual shared volume. Record sizes for the production and testnet CAR files, the relay release or rollback copy being added, and the live SQLite database including WAL. Use bytes in the calculation; one GiB is 1,073,741,824 bytes.

Allow twice the combined incoming CAR size for transfer/import staging and blockstore growth, the complete additional relay release size, and the backup exporter's existing reserve of 512 MiB plus three times the database size. These are conservative planning allowances, not claims about deduplication or compression. Keep the current release, rollback data, database and required pins in place.

The volume must retain **at least 10 GiB free after those allowances** for full release imports or public admission. Check free space again after import and before opening checkout. The 10 GiB floor is an initial operating reserve chosen for this shared host, not a measured order capacity. Confirm the next scheduled encrypted backup still completes and restores successfully. A release that fits on disk is not sufficient evidence to open the store.

The September 26 observation of approximately 8.54 GB available was **below this admission floor even before release allowances**. The relay itself occupied about 427.5 MiB; that measurement does not identify the consumer of the remaining shared volume. More approved capacity or an explicit, scoped retention decision by the responsible service owner is required before public admission. Do not delete node databases, IPFS pins, unrelated logs or retained incident evidence.

## Maintenance while public admission is closed

A measured code or merchant-policy delta to the existing private relay does not require importing the full release or opening checkout. It may proceed below the public-admission floor only when all of these conditions are verified:

- Public customer routes remain closed, and the local private customer proxy is stopped during the update. No IPFS/CAR import or new public admission is part of the operation.
- The reviewed delta changes no runtime, dependencies, database schema, encryption keys or other service. Existing orders, their terms, payment evidence and scan cursor are preserved.
- The additional code/configuration, retained rollback copies, saved manifests, largest transient replacement file and a 1 MiB metadata cushion total at most **16 MiB per phase and 32 MiB across both phases**. Reserve the full 32 MiB at every check and re-measure the actual volume and database/WAL before each phase.
- At least **5 GiB remains after that complete allowance and the 512 MiB plus three-times-database backup allowance**. This reuses the existing threshold for closing new payments; it is a maintenance reserve, not permission to launch the public store. Check it again after the update.
- A verified pre-update backup, exact process/file ownership checks, forward-repair procedure and matching post-update manual and scheduled backup restores are available. After new code starts, do not restore an older database or automatically downgrade fee accounting.

The September 26 refund update replaces 320,304 bytes of active artifacts. Its two sequential phases conservatively allow about 23 MiB combined, dominated by preserved and transient manifests, rather than importing the 381 MB staging tree. The measured host retains about 7.10 GiB after those combined allowances and the backup reserve. This supports the bounded maintenance operation only; public launch still requires the 10 GiB admission reserve and the other launch checks. Checkpoint retention in the separate indexer remains an owner decision, not a store-maintenance cleanup action.

## Pilot checks and response

Assign a volunteer to check volume free space, relay readiness and scan lag, undelivered notification age, and the most recent verified backup at pilot opening and at least hourly while public ordering is open. Record aggregate measurements only. The backup schedule currently depends on the operator Mac being awake and logged in; an absent or failed scheduled backup needs investigation before further expansion.

| Available storage | Operator response |
| --- | --- |
| At least 10 GiB after planned work | Storage admission criterion passes; payment, shipping, notification, refund and other launch checks still apply. |
| Below 10 GiB | Investigate growth and defer full release imports or expansion. Only the bounded, closed-admission maintenance procedure above may proceed. Do not reopen public checkout at this level. |
| Below 5 GiB | Close new order creation and new payment attempts at the existing approved ingress. Preserve receipt recovery, transaction hints, finalized-chain reconciliation and notification retries for existing orders. |
| Below 2 GiB, a disk-full write error, or failed durable persistence | Treat as an incident. Keep new payments closed and restore writable capacity through the responsible host/service owner. Verify database integrity, saved cursor continuity and payment recovery before reopening. |

These thresholds are manual operating actions; `/healthz` currently reports relay readiness, not this storage policy. The existing 2 GiB provisioning check also does not enforce these runtime responses. Prepare and verify the scoped ingress change before public launch; do not substitute shutting down the scanner, blocking all receipt access, deleting the database/WAL, moving the cursor forward, or silently accepting payments without durable records.

Reopen only after the admission reserve is restored, the cause is understood, the scanner has reconciled the interruption, and a verified encrypted backup is current. Review the reserve after real pilot measurements. Buy-on-demand fulfillment remains uncapped by inventory; closing checkout during a storage incident protects order persistence and does not change product pricing or refund obligations.
