# Disabled relay staging with an isolated Node runtime

The MOF shared Homebrew Node is version 24. The relay requires Node 26, so its runner uses **only** `runtime/node-v26.9.0-darwin-arm64/bin/node` beneath its application directory. It does not install, upgrade, or fall back to the host's shared runtime. The runtime version, official archive URL and SHA-256 are pinned in `deploy/runtime.json`.

The approved Node archive is [Node 26.9.0 for macOS ARM64](https://nodejs.org/dist/v26.9.0/node-v26.9.0-darwin-arm64.tar.xz), authenticated against the [official checksums](https://nodejs.org/dist/v26.9.0/SHASUMS256.txt). Download it separately with HTTPS; the staging script performs no downloads and verifies the complete archive before extracting anything. Updating the pin requires reviewing a new exact runtime/checksum and regenerating the bundle.

## Prepare locally

Use Node 26 in the development workspace and follow the [standalone Corepack setup](../README.md#develop-and-package) if needed. Install the locked dependencies, and build/test first:

```sh
corepack yarn install --immutable
corepack yarn build
corepack yarn test
node deploy/stage-relay.mjs \
  --runtime-archive /tmp/sora-pay-node-v26.9.0-darwin-arm64.tar.xz \
  --output /absolute/new/staging-directory \
  --installation-root /Users/administrator/apps/sora-pay
```

The output must not already exist. The script copies only the built `dist`, installed dependencies, lockfile/package/license, deployment templates and selected operator docs. It includes installed development dependencies in the disabled staging snapshot to preserve the exact verified local dependency tree; no install or package lifecycle script runs on MOF. It forces `private/merchant.json` to `enabled:false`, creates an owner-only private directory, and writes **only an environment example**, not real encryption/authentication/notification credentials. No database is created.

The launchd template is inactive: `Disabled:true`, `RunAtLoad:false`, and `KeepAlive:false`. Staging does not load that template, create a launchd job, change nginx, contact the chain, send notifications, or start the relay. Installing files by itself cannot enable checkout.

The result includes a deterministic `staging-manifest.json` with every immutable file's SHA-256, size and mode and every relative symlink target. Escaping/absolute symlinks are refused. The same build, installed dependency bytes, pinned runtime and installation root produce the same manifest digest; wall-clock timestamps and generated secrets are excluded. Record the printed manifest digest independently before transfer. To create a deterministic transport archive, run `python3 deploy/archive-stage.py /absolute/new/staging-directory /absolute/new/sora-pay-staging.tgz`. This standard-library helper fixes archive timestamps and ownership and refuses unmanifested files or a real `private/relay.env`; it does not modify the staged files. The archive expands under `sora-pay/`. Run the read-only integrity check before and after transfer. The staged application is a separate artifact from the versioned frontend dependency archive; this workflow never overwrites that archive.

## Read-only preflight

On macOS ARM64, use the isolated runtime to verify the staged tree:

```sh
/absolute/staging-directory/runtime/node-v26.9.0-darwin-arm64/bin/node \
  /absolute/staging-directory/deploy/check-readiness.mjs \
  /absolute/staging-directory \
  RECORDED_MANIFEST_SHA256
```

The checker verifies the manifest, pinned runtime version, Node-only imports and an **in-memory** SQLite open/close. It reads private-directory permissions, reports whether configured credentials exist without printing their values, and reports disk, memory and CPU/load observations. It performs no network requests, database creation, service installation or messaging. `stagingReady:true` means the disabled payload is intact and runnable on this host, **not** that public checkout is ready. `liveReadinessVerified` is always false; the report lists the remaining launch checks.

The manifest intentionally covers the initial disabled merchant configuration. Changing that config for activation or explicit repricing is a new reviewed deployment state and requires a new manifest. A later private `relay.env` is not part of the public staging manifest and must remain mode 0600. Never put actual secrets in the example or in a source/bundle archive.

For an inactive MOF copy, preserve the original manifest bytes and file modes. The root must be owned by the intended operator and `private/` remain 0700. Confirm free storage before transfer; the deployment must not remove existing node databases, IPFS pins, logs or unrelated application files to make room. An inactive bundle does not resolve the separate capacity review required before launching another continuous service.

The current Polkaswap template already selects the approved OVH archive `wss://mof2.sora.org` for historical reads and retains `wss://ws.mof.sora.org` as primary. The actual reader passed a read-only check beyond MOF's pruning window on September 25, 2026; [the relay runbook](relay.md) records the block evidence and required identity checks. For a staging artifact created before this archive binding, regenerate its manifest and transport archive from the current template before promoting that configuration; do not edit a verified staging artifact in place. Generic templates remain without an archive default.

Activation still requires secure notification configuration, durable restart/backup recovery and payment/refund rehearsals, a dedicated service identity, and the narrow HTTPS/operator routing described in the relay runbook. Only then should the operator prepare an enabled service configuration and deliberately enable launchd. The disabled example never silently becomes active.
