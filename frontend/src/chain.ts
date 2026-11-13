// Read-only access to the vigil contract over plain JSON-RPC. No wallet needed
// to watch anybody's vigil — the whole point is that it is public.

export const RPC = import.meta.env.VITE_NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io";
const NEARBLOCKS_API = "https://api-testnet.nearblocks.io/v1";

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

export async function activity(contract: string): Promise<ActivityItem[]> {
  const res = await fetch(`${NEARBLOCKS_API}/account/${contract}/txns-only?per_page=12&order=desc`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body.txns ?? []).map((t: any) => ({
    hash: t.transaction_hash,
    signer: t.signer_account_id,
    method: t.actions?.[0]?.method ?? t.actions?.[0]?.action ?? "—",
    ok: Boolean(t.outcomes?.status),
    timestampMs: Number(BigInt(t.block_timestamp ?? "0") / 1_000_000n),
  }));
}
