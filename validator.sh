#!/usr/bin/env bash
# Local validator with pump.fun cloned from mainnet and the EARN program loaded.
# Account list taken from ~/pumpfamily/validator.sh (each checked to exist on mainnet there).
# ⛔ No comment lines between the continued lines below: a `\` followed by `#` ends the command.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/releases/4.0.0/solana-release/bin:$PATH"
RPC="${CLONE_RPC_URL:-https://api.mainnet-beta.solana.com}"
PORT="${LOCAL_RPC_PORT:-8997}"
PROGRAM_ID="$(solana-keygen pubkey keys/program/*.json)"
rm -rf test-ledger
# NO_EARN=1 starts without the EARN program, to rehearse deploy/mainnet-program.sh against it.
# ⚠ bash 3.2 (macOS) calls an EMPTY array unbound under set -u, hence the ${a[@]+…} form below.
# EARN_SO / EARN_AUTHORITY override the binary and upgrade authority (upgrade rehearsals load the OLD build).
EARN_PROGRAM=(--upgradeable-program "$PROGRAM_ID" "${EARN_SO:-target/deploy/earn.so}" "$(solana-keygen pubkey "${EARN_AUTHORITY:-tests/fixtures/upgrade-authority.json}")")
[[ -n "${NO_EARN:-}" ]] && EARN_PROGRAM=()
exec solana-test-validator \
  --url "$RPC" \
  --rpc-port "$PORT" \
  --faucet-port $((PORT + 3)) \
  --gossip-port $((PORT + 5)) \
  --dynamic-port-range $((PORT + 10))-$((PORT + 40)) \
  --ledger test-ledger \
  --reset \
  --quiet \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  --clone-upgradeable-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone-upgradeable-program MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e \
  --clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --clone Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 \
  --clone Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  --clone TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM \
  --clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --clone 62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV \
  --clone 5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD \
  --clone 13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ \
  --clone BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s \
  --clone 3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump \
  --clone 6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP \
  --clone C2wdNPgLc2vNP4eHKYvcebAHvg3Puy2nLXwYnbVFtiVN \
  --clone ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw \
  --clone 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx \
  --clone GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR \
  --clone HjQjngTDqoHE6aaGhUqfz9aQ7WZcBRjy5xB8PScLSr8i \
  --clone 1DhjStP2ohacDtdf9Kyk7ZJsDAid8WiFSBSU7FwELFL \
  --clone 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg \
  --clone Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump \
  --clone GqpDqQH11ieR4bNnWQa4yJKBWz7EUmiH7bJvve2hnKr1 \
  --clone D2pVedgHQkD2kWnrSFyZX19Tg9X2KJrEiAauMKRchGuz \
  --clone 2KBvcvkbSDDLtxtSXYBbv3uxdmqtNun7KxJprj67spcW \
  --clone 55Q8ycXATHVFw5abfJnVDDb8a9e2MhuPLyjVu1VEYbh1 \
  --clone pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn \
  --clone H2jHE8DpRadryv3rn2ycpa2jDnBDRFG4Lzw2DB2hKKTq \
  --clone 9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7 \
  --clone GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL \
  --clone 3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR \
  --clone 5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6 \
  --clone EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL \
  --clone 5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD \
  --clone A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW \
  --account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v tests/fixtures/usdc-mint.json \
  ${EARN_PROGRAM[@]+"${EARN_PROGRAM[@]}"}
