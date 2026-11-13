#!/usr/bin/env bash
#
# The whole life of a watchman, on NEAR testnet, in about three minutes.
#
#   ./scripts/demo.sh
#
# Act I  — an agent that runs out of money dies, and a dead agent cannot touch
#          the estate even though the owner is provably silent.
# Act II — a funded agent watches, notices the silence, commits an immutable
#          plan, and gets the MPC network to sign a real Ethereum transaction
#          that it never held a key for.
#
# Everything below is a real transaction against a real contract on testnet.
# Nothing is mocked except the clock, which is shortened from months to
# seconds so the thing can be watched rather than described.

set -euo pipefail
cd "$(dirname "$0")/.."

SFX="${VIGIL_SUFFIX:-$(cat .demo-suffix 2>/dev/null || true)}"
if [[ -z "$SFX" ]]; then
  echo "No deployment found. Run ./scripts/deploy.sh first, or set VIGIL_SUFFIX." >&2
  exit 1
fi

export PATH="$HOME/.npm-global/bin:$PATH"
VIGIL="vigil-$SFX.testnet"
OWNER="owner-$SFX.testnet"
AGENT="agent-$SFX.testnet"
# The default public RPC rate-limits a demo this chatty. near-cli needs a
# network named $NET in its config; see the README for the one-line setup.
NET="${NEAR_NETWORK:-testnet-fastnear}"
RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
EVM_RPC="${EVM_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
CHAIN_ID=11155111

AMINA="0x1111111111111111111111111111111111111111"
TUNDE="0x2222222222222222222222222222222222222222"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m%s\033[0m\n" "$*"; }
bad()  { printf "  \033[31m%s\033[0m\n" "$*"; }
act()  { printf "\n\033[1;4m%s\033[0m\n\n" "$*"; }

view() { # view <method> <json-args>
  local args; args=$(printf '%s' "$2" | base64)
  curl -sS -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VIGIL\",\"method_name\":\"$1\",\"args_base64\":\"$args\"}}" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
if 'result' in r: sys.stdout.write(''.join(map(chr,r['result'])))
else: sys.stderr.write(json.dumps(r.get('error','unknown'))); sys.exit(1)
"
}

call() { # call <signer> <method> <json-args> <deposit> [gas]
  near contract call-function as-transaction "$VIGIL" "$2" \
    json-args "$3" prepaid-gas "${5:-100.0} Tgas" attached-deposit "$4" \
    sign-as "$1" network-config "$NET" sign-with-legacy-keychain send 2>&1
}

status_line() {
  view get_status "{\"owner\":\"$OWNER\"}" | python3 -c "
import sys,json
s=json.load(sys.stdin)
n=lambda y: f'{int(y)/1e24:.4f} N'
print(f\"  status={s['status']:<9} agent={s['agent_state']:<9} \"
      f\"balance={n(s['agent_balance']):>12}  runway={s['runway_ms']/1000:6.1f}s  \"
      f\"silent={str(s['is_silent']):<5} legs={s['legs_signed']}/{s['legs_total']}\")
"
}

ESTATE_ADDR=$(cd agent && npx --yes tsx src/derive.ts "$VIGIL" ethereum-1 testnet | tail -1)
if [[ ! "$ESTATE_ADDR" =~ ^0x[0-9a-f]{40}$ ]]; then
  echo "Could not derive the estate address (got: '$ESTATE_ADDR')." >&2
  echo "Run 'npm install' in agent/ first." >&2
  exit 1
fi

bold "VIGIL — a watchman that is paid by what it guards, and dies when you do"
dim  "contract $VIGIL"
dim  "owner    $OWNER"
dim  "estate   $ESTATE_ADDR on Sepolia (chain $CHAIN_ID)"
echo
dim  "No private key exists for that address. It is the MPC network's root key"
dim  "tweaked by (contract account, derivation path). Only $VIGIL"
dim  "can ask for a signature over it, and only under the rules in the contract."

# A previous run leaves a vigil behind; clear it so the story starts fresh.
if [[ "$(view get_estate "{\"owner\":\"$OWNER\"}" 2>/dev/null)" != "null" ]]; then
  REVOKE=$(call "$OWNER" revoke "{}" "0 NEAR" || true)
  if grep -qi "already been settled" <<<"$REVOKE"; then
    echo "The owner's previous vigil was fully settled and cannot be revoked." >&2
    echo "Redeploy with a new suffix: ./scripts/deploy.sh" >&2
    exit 1
  fi
  dim "(cleared the vigil left over from a previous run)"
fi

# ---------------------------------------------------------------- Act I

act "ACT I — the agent that starves"

echo "Opening a vigil with 0.4 N against rent of 864 N/day."
echo "That is 40 seconds of life. Check-in every 20s, 10s grace."
echo

call "$OWNER" open_vigil "{
  \"heirs\": [
    {\"label\":\"Amina\",\"near_account\":null,\"evm_address\":\"$AMINA\",\"basis_points\":6000},
    {\"label\":\"Tunde\",\"near_account\":null,\"evm_address\":\"$TUNDE\",\"basis_points\":4000}
  ],
  \"slots\": [
    {\"chain\":{\"Evm\":{\"chain_id\":$CHAIN_ID}},\"derivation_path\":\"ethereum-1\",\"address\":\"$ESTATE_ADDR\"}
  ],
  \"check_in_interval_ms\": 20000,
  \"grace_period_ms\": 10000,
  \"rent_per_day\": \"864000000000000000000000000\",
  \"max_fee_per_gas_cap\": \"100000000000\",
  \"yield_source\": null
}" "0.4 NEAR" >/dev/null
ok "vigil opened"
status_line

echo
echo "Now we do nothing for 45 seconds. The owner does not check in — and,"
echo "crucially, nobody tops the agent up either."
for i in $(seq 45 -5 5); do printf "\r  %2ds remaining..." "$i"; sleep 5; done
printf "\r                      \r"

echo
echo "Anyone may charge the rent. The agent's mortality does not depend on"
echo "the agent's own cooperation:"
call "$AGENT" tick "{\"owner\":\"$OWNER\"}" "0 NEAR" >/dev/null
status_line
bad "the agent has starved"

echo
echo "The owner is unambiguously silent — well past the 30s deadline."
echo "A naive dead-man's switch would now pay out. Watch what happens:"
echo
REFUSAL=$(call "$AGENT" declare_silence "{\"owner\":\"$OWNER\",\"reported_balances\":[\"1000000000000000000\"]}" "0 NEAR" || true)
if grep -qi "dead agent cannot settle" <<<"$REFUSAL"; then
  ok "REFUSED — \"a dead agent cannot settle an estate\""
  echo
  echo "  The estate is untouched and still entirely the owner's. The lapse is"
  echo "  public, so the heirs learn the watch stopped instead of discovering"
  echo "  years later that it silently had."
else
  bad "expected the settlement to be refused — investigate"
  exit 1
fi

# ---------------------------------------------------------------- Act II

act "ACT II — the agent that fulfils its purpose"

echo "Only the owner can revive a lapsed vigil. That is what makes starvation"
echo "safe: a dead watchman cannot be restarted by whoever benefits from it."
echo
call "$OWNER" reopen_vigil "{\"rent_per_day\":null}" "3 NEAR" >/dev/null
ok "reopened with 3 N — about 5 minutes of life"
status_line

echo
echo "The owner checks in once, proving they are alive:"
call "$OWNER" check_in "{}" "0 NEAR" >/dev/null
ok "checked in"
status_line

echo
echo "Then they stop. Waiting out the 30 second window..."
for i in $(seq 35 -5 5); do printf "\r  %2ds remaining..." "$i"; sleep 5; done
printf "\r                      \r"
status_line

BALANCE=$(curl -sS -X POST "$EVM_RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$ESTATE_ADDR\",\"latest\"]}" \
  | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null || echo 0)

SIMULATED=0
if [[ "$BALANCE" -lt 1000000000000000 ]]; then
  SIMULATED=1
  BALANCE=1000000000000000000   # 1 ETH, notional
fi

echo
echo "The agent reads the estate's balance on Sepolia and commits the plan."
if [[ "$SIMULATED" == "1" ]]; then
  dim "  (the estate address is unfunded, so this run uses a notional 1 ETH."
  dim "   the signature below is real regardless; only the broadcast needs funds.)"
fi
echo
call "$AGENT" declare_silence "{\"owner\":\"$OWNER\",\"reported_balances\":[\"$BALANCE\"]}" "0 NEAR" >/dev/null
ok "silence declared — plan committed and now immutable"
status_line

view get_estate "{\"owner\":\"$OWNER\"}" | python3 -c "
import sys,json
e=json.load(sys.stdin)
print()
print('  the committed plan:')
for p in e['plans']:
    for i,l in enumerate(p['legs']):
        print(f\"    leg {i}  {l['heir_label']:<6} {l['to']}  {int(l['value'])/1e18:.6f} ETH  ({l['basis_points']/100:.0f}%)\")
"

echo
echo "Now the agent asks for a signature. It supplies the transaction FIELDS;"
echo "the contract re-encodes them itself and signs the hash it computed."
echo "A compromised agent cannot redirect this — the recipient and amount are"
echo "checked against the plan above before anything reaches the MPC network."
echo

LEG_VALUE=$(view get_estate "{\"owner\":\"$OWNER\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['plans'][0]['legs'][0]['value'])")

echo "  requesting signature from v1.signer-prod.testnet (this takes a moment)..."
call "$AGENT" sign_settlement_leg "{
  \"owner\":\"$OWNER\",
  \"plan_index\":0,
  \"leg_index\":0,
  \"fields\":{
    \"chain_id\":$CHAIN_ID,
    \"nonce\":0,
    \"max_priority_fee_per_gas\":\"1000000000\",
    \"max_fee_per_gas\":\"30000000000\",
    \"gas_limit\":21000,
    \"to\":\"$AMINA\",
    \"value\":\"$LEG_VALUE\"
  }
}" "1 yoctoNEAR" "300.0" >/dev/null || true

SIG=$(view get_estate "{\"owner\":\"$OWNER\"}" | python3 -c "
import sys,json
print(json.load(sys.stdin)['plans'][0]['legs'][0]['signature'] or '')
")

if [[ -n "$SIG" ]]; then
  ok "signed by the MPC network"
  echo "    $SIG"
  status_line
  echo
  echo "  That is a real secp256k1 signature over a real Ethereum transaction,"
  echo "  produced by a threshold of NEAR validators for an address whose"
  echo "  private key has never existed in one piece anywhere."
  if [[ "$SIMULATED" == "1" ]]; then
    echo
    dim "  Fund $ESTATE_ADDR with Sepolia ETH and re-run"
    dim "  to see the agent broadcast it and record the transaction hash."
  fi
else
  bad "no signature recorded — the MPC request may have timed out; re-run to retry"
fi

act "WHAT JUST HAPPENED"
cat <<'TXT'
  An agent died twice, for two different reasons, and the difference is the
  entire point:

    starved    — ran out of money first. Nothing distributed. Estate untouched,
                 still the owner's, and the lapse announced publicly.
    fulfilled  — the owner went silent, the estate was settled to the people
                 they named, and the watchman's last act was its purpose.

  No seed phrase was mailed to a lawyer. No guardian committee voted on whether
  someone is dead. No key for the estate's Ethereum address exists, anywhere.
TXT
echo
dim "  explorer: https://testnet.nearblocks.io/address/$VIGIL"
echo
