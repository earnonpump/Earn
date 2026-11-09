#!/usr/bin/env bash
# $EARN buyback + burn, run by the operator:
#   ~/earn/deploy/buyback.sh 0.5                  dry run: quote + mainnet simulation, nothing sent
#   CONFIRM=BUY ~/earn/deploy/buyback.sh 0.5      buy $EARN with 0.5 SOL from the buyback wallet, burn what it received
#   CONFIRM=BUY ~/earn/deploy/buyback.sh --burn-only <buy signature>   finish a buy whose burn did not land
# Wallet: keys/mainnet/buyback.key. Details: scripts/buyback.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
HELIUS=$(grep -E '^HELIUS_API_KEY=' keys/mainnet/secrets.env | cut -d= -f2- | tr -d '[:space:]"')
export RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS"
if [[ "${CONFIRM:-}" == BUY ]]; then exec node scripts/buyback.mjs "$@" --send; fi
exec node scripts/buyback.mjs "$@"
