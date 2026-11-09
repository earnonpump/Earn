#!/usr/bin/env bash
# Upgrades the EARN program on MAINNET to target/deploy/earn.so. Run by the operator:
#   ! CONFIRM=UPGRADE ~/earn/deploy/mainnet-upgrade.sh
# The deployer (upgrade authority) must hold what the script prints as "Needs": the new bytes go through a buffer
# account whose rent comes back when the upgrade lands, plus a permanent top-up if the program grew.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/releases/4.0.0/solana-release/bin:$PATH"
PROGRAM_ID=4dn6ugZwwCfCCxMbivZ2ZqiycQfc6GQ3nVkyb2wMearn
K="${EARN_KEYS:-keys/mainnet}"
if [[ -n "${EARN_RPC:-}" ]]; then RPC="$EARN_RPC"
else HELIUS=$(grep -E '^HELIUS_API_KEY=' keys/mainnet/secrets.env | cut -d= -f2- | tr -d '[:space:]'); RPC="https://mainnet.helius-rpc.com/?api-key=$HELIUS"; fi
EXPECTED_SHA=$(grep -E '^EXPECTED_SHA=' deploy/mainnet-program.sh | cut -d= -f2)
actual=$(shasum -a 256 target/deploy/earn.so | cut -d' ' -f1)
[[ "$actual" == "$EXPECTED_SHA" ]] || { echo "✗ target/deploy/earn.so ($actual) is not the pinned tested build"; exit 1; }
DEPLOYER=$(solana-keygen pubkey $K/deployer.json)
size=$(stat -f%z target/deploy/earn.so)
current=$(solana program show "$PROGRAM_ID" --keypair $K/deployer.json --url "$RPC" | awk '/Data Length/ {print $3}')
echo "Program   $PROGRAM_ID"
echo "Deployer  $DEPLOYER  ($(solana balance "$DEPLOYER" --url "$RPC"))"
echo "New build $size bytes (sha $EXPECTED_SHA); on-chain data length $current bytes"
have=$(solana balance "$DEPLOYER" --url "$RPC" --lamports | cut -d' ' -f1)
# Peak = the buffer for the whole new program (refunded when the upgrade lands) + rent for the extra program bytes
# (stays) + 0.05 SOL of fees. Computed from the sizes, not guessed.
rent() { solana rent "$1" --url "$RPC" --lamports | awk '/Rent-exempt minimum/ {print $3}'; }
buffer=$(rent $((size + 45)))
grow=0; (( size > current )) && grow=$(( $(rent $((size + 45))) - $(rent $((current + 45))) ))
need=$(( buffer + grow + 50000000 ))
echo "Needs     $(LC_ALL=C awk -v n=$need 'BEGIN{printf "%.3f", n/1e9}') SOL at peak: buffer $(LC_ALL=C awk -v n=$buffer 'BEGIN{printf "%.3f", n/1e9}') (comes back) + bigger program $(LC_ALL=C awk -v n=$grow 'BEGIN{printf "%.3f", n/1e9}') (stays) + fees"
(( have >= need )) || { echo "✗ the deployer holds $(LC_ALL=C awk -v n=$have 'BEGIN{printf "%.3f", n/1e9}') SOL; send it $(LC_ALL=C awk -v n=$((need - have)) 'BEGIN{printf "%.3f", n/1e9}') more first"; exit 1; }
ok="${CONFIRM:-}"; [[ "$ok" == UPGRADE ]] || read -r -p "Type UPGRADE to continue: " ok || true
[[ "$ok" == UPGRADE ]] || { echo "stopped, nothing sent (run with CONFIRM=UPGRADE)"; exit 1; }
if (( size > current )); then
  echo "==> extending the program account by $((size - current)) bytes"
  solana program extend "$PROGRAM_ID" $((size - current)) --keypair $K/deployer.json --url "$RPC"
fi
echo "==> upgrade"
# Own buffer key: a stalled upgrade resumes on re-run; direct (TPU) sends + a priority fee (memory: solana-program-deploy-rpc-path).
[[ -f $K/buffer-upgrade.json ]] || solana-keygen new --no-bip39-passphrase --silent -o $K/buffer-upgrade.json
solana program deploy target/deploy/earn.so --program-id "$PROGRAM_ID" --buffer $K/buffer-upgrade.json --keypair $K/deployer.json --upgrade-authority $K/deployer.json \
  --url "$RPC" --with-compute-unit-price 50000 --max-sign-attempts 100
echo "==> verify"
tmp=$(mktemp); solana program dump "$PROGRAM_ID" "$tmp" --keypair $K/deployer.json --url "$RPC" >/dev/null
onchain=$(head -c "$size" "$tmp" | shasum -a 256 | cut -d' ' -f1); rm -f "$tmp"
[[ "$onchain" == "$EXPECTED_SHA" ]] && echo "   ✓ on chain == tested build" || { echo "   ✗ MISMATCH $onchain"; exit 1; }
echo "✓ done. Deployer left: $(solana balance "$DEPLOYER" --url "$RPC")"
