#!/usr/bin/env bash
# Free localnet arcade-coverage runner: boots a fresh solana-test-validator with
# the program loaded, runs the vitest coverage suite, tears the validator down.
# Zero devnet cost. Usage: bash tests/localnet/run.sh [vitest args]
set -euo pipefail
cd "$(dirname "$0")/../.."
PROGRAM_ID=4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t
SO=target/deploy/gamerplex_arcade.so
ATTACKER_ID=ERTfswRtbajRGZsrpAJuJApfsVTnVJtKPobQD7JaB4M4
ATTACKER_SO=target/deploy/arcade_attacker.so
pkill -f solana-test-validator 2>/dev/null || true; sleep 2
rm -rf test-ledger
solana-test-validator --reset --quiet \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --bpf-program "$ATTACKER_ID" "$ATTACKER_SO" \
  --ledger test-ledger \
  > /tmp/arcade-localnet-validator.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break; sleep 1
done
npx vitest run tests/localnet/coverage.test.ts "$@"
