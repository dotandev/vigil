# Vigil

**A watchman that is paid by what it guards, and dies when you do.**

Built for the NEAR Hackathon (1–14 November 2026).
Tracks: **Open Innovation** (`open`) and **Agent Economy** (`agents`).

---

## The problem with crypto inheritance

Today it means mailing a seed phrase to a lawyer, or splitting it between
relatives, or trusting a service that holds your keys. Every one of those is
custody with extra steps: at some point a human being can read your secret,
and from that moment you are relying on their honesty and their filing system.

The usual on-chain answer is a dead-man's switch with a **guardian committee** —
a group who vote to release your assets if you stop checking in. That moves the
trust rather than removing it. The guardians can collude. They can lose their
keys. They can be socially engineered into declaring a living person dead.

Vigil has no guardians and no seed phrase.

## How it works

You open a vigil and endow an **agent**. The agent has exactly one job: watch
for your check-ins. Existing costs it money — it pays rent every day out of its
endowment, and when the endowment runs out it dies.

The estate itself lives at addresses derived through [NEAR Chain
Signatures](https://docs.near.org/chain-abstraction/chain-signatures). **No
private key for those addresses exists anywhere** — not with you, not with the
agent, not in this contract. The key is the MPC network's root key tweaked by
`(contract account, derivation path)`, and the only way to sign with it is to
ask a threshold of NEAR validators, who will only answer this contract.

Then one of two things happens, and the difference between them is the whole
design:

| | **Fulfilled** | **Starved** |
|---|---|---|
| Cause | You went silent past the grace period | The agent ran out of money first |
| Estate | Distributed to the heirs you named | **Untouched, still entirely yours** |
| Agent | Reclaims its storage and stops | Stops |
| Announced | Yes, with transaction hashes | Yes, publicly |
| Restartable | No, the work is done | Only by you |

The second row is the point. A vigil that quietly stopped working ten years ago
is worse than no vigil at all, because you believed you were protected. Here,
running out of money is a loud, public, on-chain event — and a dead agent
**cannot** distribute anything, even if you are provably, unambiguously silent.

## Why the agent has to earn

If somebody must remember to top up the watchman, the watchman will eventually
fail, because the person who cared most about it is the person it is waiting
for. So the estate pays for its own vigil out of what it earns. See
[`docs/yield-sources.md`](docs/yield-sources.md).

Funding is also **permissionless**: anyone may call `feed()` on anyone's agent.
That is deliberate. Your heirs have every reason to keep alive the watchman
that will one day pay them, which turns the running cost into something the
beneficiaries will carry.

## The security model

The dangerous move in any chain-signatures design is letting an agent hand the
contract a 32-byte hash and asking the MPC network to sign it. That is a key to
everything the estate owns, on every chain, handed to whatever process happens
to be running.

**This contract never signs a caller-supplied hash.** The agent submits the
transaction *fields*; the contract re-encodes them as EIP-1559 with its own RLP
implementation and signs the digest **it** computed, after checking:

- the recipient matches the committed settlement plan (`addresses_match`)
- the amount matches the committed plan exactly
- the chain id matches the slot being settled
- the gas price is under a cap the owner set
- `data` and `accessList` are empty — a settlement is a plain value transfer,
  so the contract refuses to encode calldata at all, which deletes the entire
  "sign this contract call" class of attack

The signed transaction the contract stores is built from those same checked
fields by the same encoder, pinned by a known-answer test against a
transaction signed independently with viem.

Every estate's derivation path must also start with its owner's account id
(`owner.testnet/ethereum-1`). The address depends only on `(contract, path)`,
so without that rule anyone could open a vigil over somebody else's path, name
themselves heir, go silent, and have the MPC network sign away an estate that
was never theirs. Account ids cannot contain `/`, so no two owners can collide.

### What an agent can still do

Be honest about the edges. A compromised or lazy agent can:

- **delay** a settlement, by not calling
- **strand** funds, by under-reporting the chain balance when silence is declared

Both are liveness failures, not theft. Stranded funds stay at an address only
the MPC network can sign for, and a replacement agent can settle them later.
What the agent cannot do is move one wei to an address the owner did not name.

### What this does not protect against

- **A compromised NEAR account.** Whoever holds the owner's full-access key can
  `revoke()` and take the endowment. Vigil protects against your absence, not
  against your keys being stolen while you are present.
- **An owner who is alive but unreachable** — in hospital, travelling, in a
  country that blocked the RPC. This is why `check_in()` works right up until
  the final signature: checking in after a trigger discards the committed plan
  and returns the estate to `Watching`. The grace period is the real safeguard,
  and it should be set in weeks, not minutes.
- **A wrong heir address.** The contract validates that an EVM address is
  well-formed, not that it belongs to a person you like. Addresses are checked
  at `open_vigil` time and frozen.
- **The MPC network itself.** If a threshold of NEAR validators collude, they
  can sign anything. That is the trust assumption you accept by using chain
  signatures at all, and it is the same one every chain-abstraction project on
  NEAR makes.

## Live on testnet

Deployed, and the whole lifecycle exercised end to end by `scripts/demo.sh`
on 13 November 2026:

| | |
|---|---|
| Contract | [`vigil-1268e2.testnet`](https://testnet.nearblocks.io/address/vigil-1268e2.testnet) |
| Yield source | [`pool-1268e2.testnet`](https://testnet.nearblocks.io/address/pool-1268e2.testnet) (mock, per-second accrual) |
| MPC signer | `v1.signer-prod.testnet` |
| Estate address | [`0xf314ec824b86445cb0a13ced9748b6aad5212c66`](https://sepolia.etherscan.io/address/0xf314ec824b86445cb0a13ced9748b6aad5212c66) on Sepolia, derived from `(vigil-1268e2.testnet, "owner-1268e2.testnet/ethereum-1")` |

The transactions from that run, in order:

| Step | Result | Transaction |
|---|---|---|
| `open_vigil` — 0.4 N, ~40 s of life | opened | [`Fcmi9aho…`](https://testnet.nearblocks.io/txns/Fcmi9ahod122aXa6csuuNkCk8tvKGehoSpArUQdv5shF) |
| `tick` — anyone charges rent | agent **starved** | [`By83BTgJ…`](https://testnet.nearblocks.io/txns/By83BTgJyXRZwjVx1uucthW49Ug7DM5gYLvrRupaCyz8) |
| `declare_silence` on a dead agent | **refused**: *a dead agent cannot settle an estate* | [`2Q2ows7v…`](https://testnet.nearblocks.io/txns/2Q2ows7v39kLh6oxajwHgrEURCFHZLuUCaAzGT3V32on) |
| `reopen_vigil` — owner only, 3 N | watching | [`3VhB8XBc…`](https://testnet.nearblocks.io/txns/3VhB8XBcx8hB5CRRAm4kV3ie24uWGPgq3kDDgvoGQUn8) |
| `check_in` | alive | [`G9NMJztg…`](https://testnet.nearblocks.io/txns/G9NMJztgk4SDQEAVu4CAKYmoweLCxk3XFQ1iG2ioTxbr) |
| `declare_silence` after the window | plan committed (60 / 40) | [`QgX93dMU…`](https://testnet.nearblocks.io/txns/QgX93dMUDqWt8fQZfCrJHtsKWRA9wBBPS6gxXXavYQs) |
| `sign_settlement_leg` → MPC network | **signed** | [`8azUSBtn…`](https://testnet.nearblocks.io/txns/8azUSBtnKtvztgXoYGNTyxuRtS7YMqGhE1cvXRw8HqLS) |

Don't take the signature on trust. This reads it back from the contract,
rebuilds the transaction from the committed plan, and recovers the signer:

```console
$ cd agent && npm run -s verify -- vigil-1268e2.testnet owner-1268e2.testnet 0
leg 0: Amina <- 0.6 ETH on chain 11155111
estate address (derived)   0xf314ec824b86445cb0a13ced9748b6aad5212c66
signer (recovered from sig) 0xf314ec824b86445cb0a13ced9748b6aad5212c66
MATCH: the MPC network signed this transfer for the estate
```

When the MPC network answers, the contract also assembles the complete signed
EIP-1559 transaction from the fields it checked and stores it on the leg
(`signed_tx`). Anyone can broadcast it; nobody can change it. Handed to a
Sepolia node, the demo's transaction is rejected for one reason only:

```
insufficient funds for gas * price + value: have 0 want 600630000000000000
```

The node decoded it, accepted the signature and identified the sender as the
empty estate address. Fund the estate and the same bytes pay the heir. The
frontend does exactly this: **Fund** with MetaMask, then **Broadcast**.

## Run it

Prerequisites: Rust (stable, with the `wasm32-unknown-unknown` target), Node 20+,
and [`near-cli-rs`](https://github.com/near/near-cli-rs).

```bash
cargo test --workspace          # 37 contract tests
cd agent && npm install && npm test   # derivation, checked against the live signer
```

The default public testnet RPC rate-limits a demo this chatty, so the scripts
use a near-cli network called `testnet-fastnear`. Add it once (it copies your
`testnet` entry with FastNEAR's RPC):

```bash
CFG="$HOME/Library/Application Support/near-cli/config.toml"   # Linux: ~/.config/near-cli/config.toml
python3 - "$CFG" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if "network_connection.testnet-fastnear" not in s:
    body = re.search(r"\[network_connection\.testnet\]\n(.*?)(?=\n\[|\Z)", s, re.S).group(1)
    body = re.sub(r'rpc_url = ".*?"', 'rpc_url = "https://test.rpc.fastnear.com/"', body)
    open(p, "w").write(s.rstrip() + "\n\n[network_connection.testnet-fastnear]\n" + body.rstrip() + "\n")
PY
```

Or set `NEAR_NETWORK=testnet` to use whatever network you already have.

Deploy your own and watch the whole lifecycle on testnet:

```bash
./scripts/deploy.sh             # creates four faucet accounts, deploys both contracts
./scripts/demo.sh               # ~3 minutes, both deaths, a real MPC signature
cd agent && npm run verify -- vigil-<suffix>.testnet owner-<suffix>.testnet 0
```

`demo.sh` is safe to re-run: it revokes the previous run's vigil first.

`demo.sh` is the fastest way to understand the project. It opens a vigil with
40 seconds of life, lets it starve, shows the contract **refusing** to settle a
genuinely silent estate because the watchman is dead, then revives it and runs
a real settlement through `v1.signer-prod.testnet`.

### The frontend

```bash
cd frontend && npm install && npm run dev
```

A Next.js app, exported statically (`npm run build` writes `out/`; set
`NEXT_PUBLIC_BASE_PATH` to host under a subpath).

| Page | What it does |
|---|---|
| `/` | What Vigil is, with live network stats |
| `/explore` | Every vigil on the contract, filterable by status |
| `/vigil?owner=…` | One vigil live: the agent's balance draining at the on-chain rent rate, the check-in countdown in chain time, every estate address with its real balance, and the vigil's history rebuilt from the contract's own events. The whole settlement runs from here: **Declare silence**, **Request MPC signature**, **Broadcast** the contract-assembled transaction, and watch the receipt confirm the heir was paid from the estate |
| `/new` | Four-step wizard: heirs, schedule, endowment, review. It mirrors every check the contract makes, lets the estate live on Ethereum, Base and Arbitrum Sepolia at once, and derives every keyless address in the browser before you sign |
| `/dashboard` | Your vigil, plus any vigils that name you as an heir |

Watching needs no wallet. Connecting one (Meteor, HOT, Intear or MyNearWallet)
adds the owner console (check in, top up, reopen a lapsed vigil, harvest
yield, revoke, and a calendar file that repeats on the check-in schedule) and
lets anyone feed an agent or drive a settlement. An injected EVM wallet funds
an estate in one click.

**Don't trust the UI either.** Every estate address has a **Verify keyless**
button that asks `v1.signer-prod.testnet` itself, through its
`derived_public_key` view, which key it would sign with for this contract and
path, and checks that it matches both the browser's derivation and the address
the contract stores.

### The agent daemon

```bash
cd agent
cp .env.example .env            # fill in the accounts deploy.sh created
npm run watch
```

The loop, in order: pay rent, earn, **stop if dead**, nudge the owner, declare
silence, settle. It settles every chain the estate holds an address on, each
with its own RPC and nonce sequence (`EVM_RPC_URLS` overrides the defaults for
Ethereum, Base and Arbitrum Sepolia), and broadcasts the transaction the
contract assembled. Step three sits above the last two on purpose, and the
contract enforces the same ordering independently.

## Layout

```
contracts/vigil/        the contract
  src/lib.rs            estate lifecycle, rent, settlement entrypoints
  src/evm.rs            RLP + EIP-1559 encoding, so the contract decides what it signs
  src/mpc.rs            chain-signatures interface (note: the wire field is payload_v2)
  src/settlement.rs     the immutable plan
  src/tests.rs          the safety invariants
contracts/mock-pool/    a yield source on demo timescales
frontend/               Next.js: watch any vigil live, verify signatures, check in, feed
agent/                  the watchman daemon
  src/verify.ts         recovers a settlement signature's signer from chain data
scripts/deploy.sh       build, create accounts, deploy, initialise
scripts/demo.sh         the whole lifecycle, on testnet, in one command
```

## Three things that will bite you

All three cost real time to find. The first two are recorded as tests so they
cannot regress; the third is baked into `scripts/deploy.sh`.

**1. The sign wire format renames its field.** The Rust struct calls it
`payload`; the JSON on the wire is `payload_v2`. Reading the struct definition
misleads you. Pinned by `mpc::tests::sign_request_matches_the_published_wire_format`,
which byte-matches NEAR's published wire-format catalog.

**2. The derivation vector in NEAR's docs is stale.** The chain-signatures page
says `example.near` + `ethereum-1` gives `0x1b48b83a…aa3b`. The live signer
contract says `0xef4ea05e…1fa5`. The real derivation uses **SHA3-256** — not
SHA-256, and not keccak256, which are each one import away — over
`"near-mpc-recovery v0.1.0 epsilon derivation:" + account + "," + path`, with no
modular reduction. Had we trusted the docs, every address we told an owner to
fund would be one the contract could never sign for: silent, total, and
discovered only at settlement. `agent/src/derive.test.ts` checks against the
contract's own `derived_public_key` view instead of the documentation.

**3. Plain `cargo build` silently deletes every error message.** near-sdk 5.x
only routes `env::panic_str` to the host's `panic_utf8` (and `sha256` /
`keccak256` to the host) when compiled with `--cfg near`. Newer `cargo-near`
sets that flag; a plain `cargo build --target wasm32-unknown-unknown` does not.
The contract still deploys and still works, but every `require!` becomes a
bare `unreachable` trap with no message, and hashing runs in wasm instead of
on the host. Since the demo's whole point is a refusal you can *read*, that
was not acceptable. Check with any wasm import lister: a correct build imports
`panic_utf8`.

## What is real and what is not

Being precise, since it matters for judging:

- **Real:** the contract, the settlement rules, the MPC signature, the address
  derivation, every test, the testnet deployment.
- **Shortened:** the demo's clock. Check-in windows run in seconds instead of
  months so the lifecycle can be watched.
- **Mocked:** the yield source, for the timing reason in
  [`docs/yield-sources.md`](docs/yield-sources.md) — real staking pays per epoch
  and locks unstaking for ~48 hours.
- **Optional:** the NEAR AI Cloud integration. It words the agent's reminders
  and notices and nothing else. No model decides whether someone has died,
  whether silence has elapsed, or who inherits — those are a clock, a balance
  and an immutable plan. The agent runs identically with no API key.

## License

MIT — see [LICENSE](LICENSE).
