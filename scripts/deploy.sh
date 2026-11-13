#!/usr/bin/env bash
#
# Build both contracts and deploy a fresh, self-contained Vigil to NEAR testnet.
#
#   ./scripts/deploy.sh            # new random suffix
#   VIGIL_SUFFIX=abc123 ./scripts/deploy.sh   # reuse / pick a suffix
#
# Creates four faucet-funded accounts — vigil-, owner-, agent-, pool-<suffix>.testnet —
# with keys in the legacy keychain (~/.near-credentials), deploys and initialises
# the contracts, and writes the suffix to .demo-suffix for scripts/demo.sh.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"

command -v near >/dev/null || { echo "near-cli-rs is required: npm i -g near-cli-rs" >&2; exit 1; }

SFX="${VIGIL_SUFFIX:-$(openssl rand -hex 3)}"
VIGIL="vigil-$SFX.testnet"
MPC_SIGNER="${MPC_SIGNER:-v1.signer-prod.testnet}"
NET="${NEAR_NETWORK:-testnet-fastnear}"
RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"

echo "building contracts..."
# `--cfg near` is what makes near-sdk call the host's panic_utf8 / sha256 /
# keccak256. Without it every require! traps as a bare `unreachable` with no
# message. (Recent cargo-near sets it automatically; plain cargo does not.)
RUSTFLAGS="--cfg near" cargo build --release --target wasm32-unknown-unknown \
  -p vigil -p mock-pool >/dev/null 2>&1
mkdir -p res
cp target/wasm32-unknown-unknown/release/{vigil,mock_pool}.wasm res/

exists() {
  curl -sS -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"amount"'
}

for role in vigil owner agent pool; do
  acc="$role-$SFX.testnet"
  if exists "$acc"; then
    echo "  $acc exists"
  else
    near account create-account sponsor-by-faucet-service "$acc" \
      autogenerate-new-keypair save-to-legacy-keychain network-config "$NET" create >/dev/null 2>&1
    echo "  created $acc"
  fi
done
sleep 3

deploy() { # deploy <account> <wasm> <init-json>
  near contract deploy "$1" use-file "$2" with-init-call new json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NET" sign-with-legacy-keychain send >/dev/null 2>&1 \
  || near contract deploy "$1" use-file "$2" without-init-call \
    network-config "$NET" sign-with-legacy-keychain send >/dev/null 2>&1
}

deploy "pool-$SFX.testnet" res/mock_pool.wasm '{"bps_per_second":1}'
echo "  deployed mock pool"
deploy "$VIGIL" res/vigil.wasm "{\"mpc_signer\":\"$MPC_SIGNER\",\"min_rent_per_day\":null}"
echo "  deployed vigil (signer: $MPC_SIGNER)"

echo "$SFX" > .demo-suffix
echo
echo "done. contract: https://testnet.nearblocks.io/address/$VIGIL"
echo "next: ./scripts/demo.sh"
