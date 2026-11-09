#!/usr/bin/env bash
# Closes or reopens launching without touching the $EARN listing.
#   deploy/set-launching.sh close | open
set -euo pipefail
cd "$(dirname "$0")/.."
SITE="${SITE:-https://earnrewards.fun}"
case "${1:-}" in close|open) ;; *) echo "usage: deploy/set-launching.sh close|open" >&2; exit 1 ;; esac
printf 'header = "Authorization: Bearer %s"\n' "$(cat keys/mainnet/admin.token)" |
  curl -sS -K - -X POST "$SITE/api/admin/platform" -H 'content-type: application/json' -d "{\"launching\":\"$1\"}" -w '\nHTTP %{http_code}\n'
echo "gate now: $(curl -s "$SITE/api/platform" | head -c 120)"
