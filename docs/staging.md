# Disabled relay staging with an isolated Node runtime

Staging creates a self-contained, disabled relay artifact using the runtime pin in `deploy/runtime.json`. The current pin targets Node 26.9.0 on macOS ARM64. The runner uses only that runtime beneath the installation directory; it never installs, upgrades or falls back to a host's shared Node. This platform-specific staging helper is optional: deployments on other systems must supply their own reviewed Node 26 service packaging.

The runtime pin records the official archive URL and SHA-256. Download the archive separately over HTTPS and check it against the [official Node checksums](https://nodejs.org/dist/v26.9.0/SHASUMS256.txt). The staging script performs no download and validates the archive before extraction. Changing the runtime requires reviewing a new exact version/checksum and regenerating the artifact.

## Prepare locally

Use Node 26 and the [standalone Corepack setup](../README.md#develop-and-package). Start from `deploy/merchant.disabled.json.example` and prepare a merchant-owned configuration outside the toolkit. The staging command requires that configuration explicitly; no live merchant catalog or recipient is selected by default.

```sh
corepack yarn install --immutable
corepack yarn build
corepack yarn test
node deploy/stage-relay.mjs \
  --merchant-config /absolute/path/merchant.json \
  --runtime-archive /absolute/path/node-v26.9.0-darwin-arm64.tar.xz \
  --output /absolute/new/staging-directory \
  --installation-root /opt/sora-pay
```

The output must not already exist. The script copies the built `dist`, installed dependencies, lockfile/package/license, neutral deployment templates and selected toolkit operator docs. Installed development dependencies are included to preserve the verified local dependency tree; no install or package lifecycle script runs on the target. Merchant fulfillment documents and host-specific procedures remain in the merchant repository.

The script forces the staged `private/merchant.json` to `enabled:false`, creates an owner-only private directory, and writes **only an environment example**. It creates no database or encryption/authentication/notification credentials. Paths in the service/environment templates are rendered from the supplied installation root; account names and host-specific setup still require operator review.

The launchd template stays inactive: `Disabled:true`, `RunAtLoad:false`, and `KeepAlive:false`. Staging does not install a service, change proxy configuration, contact a chain, send a notification or start the relay. Installing staged files cannot enable checkout.

The deterministic `staging-manifest.json` records each immutable file's SHA-256, size and mode, plus relative symlink targets. Absolute or escaping symlinks are refused. Identical source/dependency bytes, runtime, merchant configuration and installation root produce the same manifest digest. Wall-clock timestamps and generated secrets are excluded. Record the digest independently before transfer.

Create a deterministic transport archive with `python3 deploy/archive-stage.py /absolute/new/staging-directory /absolute/new/sora-pay-staging.tgz`. It fixes archive timestamps/ownership and rejects unmanifested files or a real `private/relay.env`. The archive expands under `sora-pay/`; staged files are not modified. Check integrity before and after transfer. This server artifact is separate from the versioned browser dependency package.

## Read-only preflight

On the target macOS ARM64 host, use the staged runtime:

```sh
/absolute/staging-directory/runtime/node-v26.9.0-darwin-arm64/bin/node \
  /absolute/staging-directory/deploy/check-readiness.mjs \
  /absolute/staging-directory \
  RECORDED_MANIFEST_SHA256
```

The checker validates manifest/runtime/imports and opens an **in-memory** SQLite database. It checks private-directory permissions, reports credential-file presence without values, and observes disk, memory and CPU/load. It performs no network request, persistent database creation, service installation or messaging. `stagingReady:true` establishes payload integrity and local runtime support; `liveReadinessVerified` remains false.

The manifest covers the initial disabled merchant configuration. Activation or catalog changes require a newly reviewed manifest. A later private `relay.env` is deliberately outside the public manifest and must stay mode 0600. Never put actual secrets in an example, source repository or transport archive.

Preserve file ownership, modes and manifest bytes during transfer, with `private/` at 0700. Review space for the staged tree, retained rollback copies, database growth and encrypted backups. Do not remove unrelated service data to make a release fit. Configure primary/archive RPC endpoints explicitly and rehearse recovery beyond the primary's pruning horizon.

Before activation, complete private notification setup, backup/restore and payment/refund rehearsals, assign the service identity, and review TLS/customer/operator routing using the [relay runbook](relay.md). Enabling the service and merchant is a separate deliberate operator action; no example silently becomes active.
