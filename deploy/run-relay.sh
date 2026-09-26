#!/bin/sh
# Run as a dedicated unprivileged service account with the pinned isolated runtime.
set -eu
umask 077
SORA_PAY_APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SORA_PAY_NODE="$SORA_PAY_APP_ROOT/runtime/node-v26.9.0-darwin-arm64/bin/node"
if [ ! -x "$SORA_PAY_NODE" ]; then
  echo 'Sora Pay isolated Node 26.9.0 runtime is missing; no shared-runtime fallback.' >&2
  exit 1
fi
cd "$SORA_PAY_APP_ROOT"
exec "$SORA_PAY_NODE" --env-file="$SORA_PAY_APP_ROOT/private/relay.env" dist/relay/cli.js serve
