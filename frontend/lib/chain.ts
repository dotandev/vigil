// Read-only access to the vigil contract over plain JSON-RPC. No wallet needed
// to watch anybody's vigil, because every vigil is public.

export const RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io";
// FastNEAR indexes testnet transactions per account and returns full receipts
// (with event logs) in one batch call: no API key, generous limits.
const TX_API = process.env.NEXT_PUBLIC_TX_API ?? "https://tx.test.fastnear.com/v0";

export type EstateStatus = "Watching" | "Triggered" | "Settled" | "Lapsed" | "Revoked";
export type AgentState = "Alive" | "Fulfilled" | "Starved" | "StoodDown";
export type LegStatus = "AwaitingSignature" | "Signed" | "Broadcast";

export interface Heir {
  label: string;
  near_account: string | null;
  evm_address: string | null;
  basis_points: number;
}

export interface ChainSlot {
  chain: { Evm: { chain_id: number } };
  derivation_path: string;
  address: string;
}

export interface Leg {
  heir_label: string;
  slot_index: number;
  to: string;
  value: string;
  basis_points: number;
  status: LegStatus;
  signature: string | null;
  /** The complete signed transaction, assembled by the contract. Anyone may broadcast it. */
  signed_tx?: string | null;
  tx_hash: string | null;
}

export interface Plan {
  committed_at_ms: number;
  total_reported: string;
  legs: Leg[];
}

export interface Estate {
  owner: string;
  heirs: Heir[];
  slots: ChainSlot[];
  check_in_interval_ms: number;
  grace_period_ms: number;
  last_check_in_ms: number;
  status: EstateStatus;
  agent: {
    state: AgentState;
    balance: string;
    rent_per_day: string;
    last_tick_ms: number;
    total_rent_paid: string;
    total_yield_claimed: string;
    total_donated: string;
    days_survived: number;
    died_at_ms: number | null;
  };
  plans: Plan[];
  max_fee_per_gas_cap: string;
  yield_source: string | null;
}

export interface Status {
  owner: string;
  status: EstateStatus;
  agent_state: AgentState;
  agent_balance: string;
  rent_per_day: string;
  runway_ms: number;
  last_check_in_ms: number;
  silent_at_ms: number;
  is_silent: boolean;
  legs_total: number;
  legs_signed: number;
}

export interface ActivityItem {
  hash: string;
  signer: string;
  method: string;
  ok: boolean;
  timestampMs: number;
}

/** The block time of the latest final block, so countdowns use chain time, not the viewer's clock. */
export interface Snapshot {
  estate: Estate | null;
  status: Status | null;
  chainNowMs: number;
  fetchedAtMs: number;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "vigil", method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
  return body.result as T;
}

export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (!result.result) throw new Error(result.error ?? "view call failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

export async function snapshot(contract: string, owner: string): Promise<Snapshot> {
  const [estate, block] = await Promise.all([
    view<Estate | null>(contract, "get_estate", { owner }),
    rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" }),
  ]);
  const status = estate ? await view<Status>(contract, "get_status", { owner }) : null;
  return {
    estate,
    status,
    chainNowMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n),
    fetchedAtMs: Date.now(),
  };
}

export const listOwners = (contract: string) => view<string[]>(contract, "list_owners");

interface FullTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: any[] };
  execution_outcome: { block_timestamp: number | string; outcome: { status: any } };
  receipts: { execution_outcome: { outcome: { logs: string[]; status: any } } }[];
}

const txCache = new Map<string, FullTx>();

async function fullTxs(hashes: string[]): Promise<FullTx[]> {
  const missing = hashes.filter((h) => !txCache.has(h));
  if (missing.length) {
    const res = await fetch(`${TX_API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hashes: missing }),
    });
    if (res.ok) {
      const body = (await res.json()) as { transactions: FullTx[] };
      for (const t of body.transactions ?? []) {
        // A transaction is immutable once old enough to have all its receipts.
        const ageMs = Date.now() - Number(BigInt(t.execution_outcome.block_timestamp) / 1_000_000n);
        if (ageMs > 60_000) txCache.set(t.transaction.hash, t);
        else txCache.set(`fresh:${t.transaction.hash}`, t);
      }
    }
  }
  return hashes
    .map((h) => txCache.get(h) ?? txCache.get(`fresh:${h}`))
    .filter((t): t is FullTx => !!t);
}

const listCache = new Map<string, { at: number; hashes: string[] }>();

/** Most recent transaction hashes touching an account, newest first. Cached briefly. */
async function recentHashes(account: string, limit: number): Promise<string[]> {
  const hit = listCache.get(account);
  if (hit && Date.now() - hit.at < 8000) return hit.hashes.slice(0, limit);
  const res = await fetch(`${TX_API}/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: account }),
  });
  if (!res.ok) throw new Error(`transaction index ${res.status}`);
  const body = (await res.json()) as { account_txs: { transaction_hash: string }[] };
  const hashes = (body.account_txs ?? []).map((t) => t.transaction_hash);
  listCache.set(account, { at: Date.now(), hashes });
  return hashes.slice(0, limit);
}

const failed = (t: FullTx) =>
  "Failure" in (t.execution_outcome.outcome.status ?? {}) ||
  t.receipts.some((r) => r.execution_outcome?.outcome?.status && "Failure" in r.execution_outcome.outcome.status);

function toActivity(t: FullTx): ActivityItem {
  const action = t.transaction.actions?.[0];
  const method =
    typeof action === "object" && action?.FunctionCall ? action.FunctionCall.method_name : typeof action === "string" ? action : Object.keys(action ?? {})[0] ?? "—";
  return {
    hash: t.transaction.hash,
    signer: t.transaction.signer_id,
    method,
    ok: !failed(t),
    timestampMs: Number(BigInt(t.execution_outcome.block_timestamp) / 1_000_000n),
  };
}

export async function activity(contract: string, limit = 12, account = contract): Promise<ActivityItem[]> {
  const txs = await fullTxs(await recentHashes(account, limit));
  return txs
    .filter((t) => t.transaction.receiver_id === contract)
    .map(toActivity)
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

/** Status of many vigils at once, for the explore page. Bounded concurrency keeps the RPC happy. */
export async function statuses(contract: string, owners: string[], limit = 6): Promise<Status[]> {
  const out: Status[] = [];
  let i = 0;
  const worker = async () => {
    while (i < owners.length) {
      const owner = owners[i++];
      try {
        out.push(await view<Status>(contract, "get_status", { owner }));
      } catch {
        /* an estate revoked between list and read */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, owners.length) }, worker));
  return out;
}

/** Chain time of the latest final block. */
export async function chainNow(): Promise<number> {
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
}

/** Balance of an EVM address, in wei, straight from a public RPC. */
export async function evmBalance(rpcUrl: string, address: string): Promise<bigint | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    });
    const body = await res.json();
    return body.result ? BigInt(body.result) : null;
  } catch {
    return null;
  }
}

/** Whether an account exists on NEAR, for validating heir accounts. */
export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ EVM side

async function evm<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "EVM RPC error");
  return body.result as T;
}

export const evmNonce = async (rpcUrl: string, address: string) =>
  Number(BigInt(await evm<string>(rpcUrl, "eth_getTransactionCount", [address, "pending"])));

/** Current fees, capped by the owner's ceiling so the contract will accept them. */
export async function evmFees(rpcUrl: string, capWei: bigint) {
  const [block, tipHex] = await Promise.all([
    evm<{ baseFeePerGas?: string }>(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    evm<string>(rpcUrl, "eth_maxPriorityFeePerGas", []).catch(() => "0x3b9aca00"),
  ]);
  const base = BigInt(block.baseFeePerGas ?? "0x0");
  let tip = BigInt(tipHex);
  let maxFee = base * 2n + tip;
  if (maxFee > capWei) maxFee = capWei;
  if (tip > maxFee) tip = maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, baseFee: base };
}

export const evmSendRaw = (rpcUrl: string, raw: string) => evm<string>(rpcUrl, "eth_sendRawTransaction", [raw]);

export interface EvmReceipt {
  status: "0x1" | "0x0";
  from: string;
  to: string;
  blockNumber: string;
}

export const evmReceipt = (rpcUrl: string, hash: string) =>
  evm<EvmReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [hash]).catch(() => null);

// ------------------------------------------------------------- MPC signer

/** Ask the MPC signer contract itself which public key it would sign with. */
export const signerDerivedKey = (signer: string, predecessor: string, path: string) =>
  view<string>(signer, "derived_public_key", { path, predecessor, domain_id: 0 });

// ------------------------------------------------------------------ events

export interface VigilEventRow {
  event: string;
  data: Record<string, unknown>;
  hash: string;
  timestampMs: number;
  signer: string;
}

/**
 * The contract's NEP-297 events for one owner, read from the receipts of the
 * contract's and the owner's recent transactions.
 */
export async function ownerEvents(contract: string, owner: string, limit = 40): Promise<VigilEventRow[]> {
  const [a, b] = await Promise.all([recentHashes(contract, limit).catch(() => []), recentHashes(owner, limit).catch(() => [])]);
  const hashes = [...new Set([...a, ...b])];
  const txs = await fullTxs(hashes);
  const rows: VigilEventRow[] = [];
  for (const t of txs) {
    if (t.transaction.receiver_id !== contract) continue;
    const meta = toActivity(t);
    for (const r of t.receipts) {
      for (const l of r.execution_outcome?.outcome?.logs ?? []) {
        if (!l.startsWith("EVENT_JSON:")) continue;
        try {
          const j = JSON.parse(l.slice(11));
          const data = (j.data?.[0] ?? {}) as Record<string, unknown>;
          if (j.standard === "vigil" && data.owner === owner)
            rows.push({ event: j.event, data, hash: meta.hash, timestampMs: meta.timestampMs, signer: meta.signer });
        } catch {
          /* not ours */
        }
      }
    }
  }
  return rows.sort((x, y) => y.timestampMs - x.timestampMs);
}
