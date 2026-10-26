#!/bin/bash
# The checks the portal must pass before a staging deploy.
#
# Three layers, cheapest first, because each one fails differently:
#   typecheck   — the build is about to be baked into an image; a type error is
#                 a broken container, and it costs seconds to know.
#   tests       — the send path, the store, the OIDC verifier. No network.
#   signin:e2e  — a real browser through Authentik against the stack that is
#                 live *now*. This is the only one that can prove the redirect
#                 chain, and it is the check whose absence let a sign-in outage
#                 ship. It runs before the build, so a failure here stops the
#                 deploy instead of replacing a working portal with a broken one.
#
#   ./preflight.sh              # all three
#   SKIP_SIGNIN=1 ./preflight.sh   # when Authentik is unreachable and only the
#                                  # build is being validated (says so, loudly)
#
# `up.sh` runs this first; `SKIP_PREFLIGHT=1 ./up.sh` deploys without it.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The e2e reads the Authentik API credentials the same way provision-sso.py does.
# On the host that owns staging they live in this file; elsewhere, set the
# variable or run where the `cerulean` container is reachable.
if [ -z "${AUTHENTIK_ENV_FILE:-}" ] && [ -f /root/.cerulean-env ]; then
  export AUTHENTIK_ENV_FILE=/root/.cerulean-env
fi

echo "preflight: typecheck"
npm run --silent typecheck

echo "preflight: tests"
npm test --silent 2>&1 | tail -n 12

if [ "${SKIP_SIGNIN:-0}" = "1" ]; then
  echo "preflight: SKIPPING the browser sign-in check (SKIP_SIGNIN=1)" >&2
else
  echo "preflight: browser sign-in against the live stack"
  npm run --silent signin:e2e
fi

echo "preflight: ok"
