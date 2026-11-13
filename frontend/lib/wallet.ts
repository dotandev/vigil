// Wallet actions. Watching needs no wallet; acting does. Loaded lazily: the
// selector is most of the bundle and touches `window`.

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { actionCreators } from "@near-js/transactions";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT, NETWORK } from "./config";
import type { ChainSlot, Heir } from "./chain";

const TGAS = 1_000_000_000_000n;

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

export async function initWallet(onChange: (account: string | null) => void) {
  if (!selector) {
    selector = await setupWalletSelector({
      network: NETWORK,
      modules: [setupMeteorWallet(), setupHotWallet(), setupIntearWallet(), setupMyNearWallet()],
    });
    modal = setupModal(selector, { contractId: CONTRACT, theme: "dark" });
  }
  const emit = () => onChange(selector!.store.getState().accounts.find((a) => a.active)?.accountId ?? null);
  const sub = selector.store.observable.subscribe(emit);
  emit();
  return () => sub.unsubscribe();
}

export const showConnect = () => modal?.show();

export async function signOut() {
  if (selector?.isSignedIn()) await (await selector.wallet()).signOut();
}

export class NeedsWallet extends Error {
  constructor() {
    super("Connect a wallet first.");
  }
}

/** Pull the contract's own words out of a wallet or RPC error when they are in there. */
export function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const panic = raw.match(/Smart contract panicked: ([^"\\}]+)/);
  if (panic) return panic[1].trim();
  if (/reject|denied|cancel/i.test(raw)) return "You cancelled the transaction.";
  if (/NotEnoughBalance|not enough balance|LackBalanceForState/i.test(raw)) return "Not enough NEAR in this account.";
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}

export interface TxResult {
  hash: string | null;
}

async function call(method: string, args: object, deposit = 0n, gasTgas = 50n): Promise<TxResult> {
  if (!selector) throw new Error("The wallet is still loading.");
  if (!selector.isSignedIn()) {
    showConnect();
    throw new NeedsWallet();
  }
  const wallet = await selector.wallet();
  const outcome: any = await wallet.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actionCreators.functionCall(method, args, gasTgas * TGAS, deposit)],
  });
  // Injected wallets resolve with the outcome; redirect wallets navigate away
  // and return with ?transactionHashes=…, which the wallet provider picks up.
  const failed =
    outcome?.status?.Failure ??
    outcome?.receipts_outcome?.find((r: any) => r?.outcome?.status?.Failure)?.outcome.status.Failure;
  if (failed) throw new Error(JSON.stringify(failed));
  return { hash: outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null };
}

export const YOCTO_PER_NEAR = 10n ** 24n;

export function nearToYocto(amount: string): bigint {
  const t = amount.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(t)) throw new Error("Enter an amount like 1 or 0.5.");
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

export interface OpenVigilArgs {
  heirs: Heir[];
  slots: ChainSlot[];
  check_in_interval_ms: number;
  grace_period_ms: number;
  rent_per_day: string;
  max_fee_per_gas_cap: string;
  yield_source: string | null;
}

export const checkIn = () => call("check_in", {});
export const feed = (owner: string, yocto: bigint) => call("feed", { owner }, yocto);
export const tick = (owner: string) => call("tick", { owner });
export const harvest = (owner: string) => call("harvest", { owner }, 0n, 100n);
export const revoke = () => call("revoke", {}, 0n, 60n);
export const reopen = (yocto: bigint, rentPerDay: string | null) =>
  call("reopen_vigil", { rent_per_day: rentPerDay }, yocto);
export const openVigil = (args: OpenVigilArgs, endowment: bigint) => call("open_vigil", args, endowment, 100n);

// Settlement is permissionless: anyone may drive it, nobody may redirect it.
export const declareSilence = (owner: string, reportedBalances: bigint[]) =>
  call("declare_silence", { owner, reported_balances: reportedBalances.map(String) }, 0n, 100n);

export interface LegFields {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  value: string;
}

/** Ask the MPC network, through the contract, to sign one leg. Takes a while. */
export const signLeg = (owner: string, planIndex: number, legIndex: number, fields: LegFields) =>
  call("sign_settlement_leg", { owner, plan_index: planIndex, leg_index: legIndex, fields }, 1n, 300n);

export const recordBroadcast = (owner: string, planIndex: number, legIndex: number, txHash: string) =>
  call("record_broadcast", { owner, plan_index: planIndex, leg_index: legIndex, tx_hash: txHash }, 0n, 30n);
