/** Thin wrapper over the two NEAR calls the agent makes. */

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import type { AgentConfig } from "./config.js";

export type EstateStatus =
  | "Watching"
  | "Triggered"
  | "Settled"
  | "Lapsed"
  | "Revoked";
export type AgentState = "Alive" | "Fulfilled" | "Starved" | "StoodDown";

export interface VigilStatus {
  owner: string;
  status: EstateStatus;
  agent_state: AgentState;
  agent_balance: string;
  rent_per_day: string;
  runway_ms: number;
  last_check_in_ms: number;
  silent_at_ms: number;
  is_silent: boolean;
  days_survived: number;
  total_rent_paid: string;
  total_yield_claimed: string;
  total_donated: string;
  legs_total: number;
  legs_signed: number;
}

export interface SettlementLeg {
  heir_label: string;
  slot_index: number;
  to: string;
  value: string;
  basis_points: number;
  status: "AwaitingSignature" | "Signed" | "Broadcast";
  signature: string | null;
  /** Complete signed transaction, assembled by the contract. */
  signed_tx?: string | null;
  tx_hash: string | null;
}

export interface Estate {
  owner: string;
  heirs: Array<{
    label: string;
    near_account: string | null;
    evm_address: string | null;
    basis_points: number;
  }>;
  slots: Array<{
    chain: { Evm: { chain_id: number } };
    derivation_path: string;
    address: string;
  }>;
  status: EstateStatus;
  plans: Array<{
    committed_at_ms: number;
    total_reported: string;
    legs: SettlementLeg[];
  }>;
}

export class VigilClient {
  private account: Account;
  private provider: JsonRpcProvider;

  constructor(private cfg: AgentConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.nearRpcUrl });
    const signer = new KeyPairSigner(
      KeyPair.fromString(cfg.agentPrivateKey as `ed25519:${string}`),
    );
    this.account = new Account(cfg.agentAccountId, this.provider, signer);
  }

  private async view<T>(
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    // Note: the provider names this `method`, while Account names the same
    // thing `methodName`. They are not interchangeable.
    const result = await this.provider.callFunction({
      contractId: this.cfg.contractId,
      method: methodName,
      args,
    });
    if (result === undefined) {
      throw new Error(`view ${methodName} returned nothing`);
    }
    return result as T;
  }

  private async call(
    methodName: string,
    args: Record<string, unknown>,
    { gas = 300_000_000_000_000n, deposit = 0n } = {},
  ) {
    if (this.cfg.dryRun) {
      console.log(`  [dry-run] would call ${methodName}`, JSON.stringify(args));
      return null;
    }
    return this.account.callFunction({
      contractId: this.cfg.contractId,
      methodName,
      args,
      gas,
      deposit,
    });
  }

  getStatus = () => this.view<VigilStatus>("get_status", { owner: this.cfg.owner });
  getEstate = () => this.view<Estate>("get_estate", { owner: this.cfg.owner });
  pendingRent = () =>
    this.view<string>("pending_rent", { owner: this.cfg.owner }).then(BigInt);

  tick = () => this.call("tick", { owner: this.cfg.owner });
  harvest = () => this.call("harvest", { owner: this.cfg.owner });

  declareSilence = (reportedBalances: bigint[]) =>
    this.call("declare_silence", {
      owner: this.cfg.owner,
      reported_balances: reportedBalances.map(String),
    });

  signSettlementLeg = (
    planIndex: number,
    legIndex: number,
    fields: {
      chain_id: number;
      nonce: number;
      max_priority_fee_per_gas: string;
      max_fee_per_gas: string;
      gas_limit: number;
      to: string;
      value: string;
    },
  ) =>
    this.call(
      "sign_settlement_leg",
      {
        owner: this.cfg.owner,
        plan_index: planIndex,
        leg_index: legIndex,
        fields,
      },
      { deposit: 1n },
    );

  recordBroadcast = (planIndex: number, legIndex: number, txHash: string) =>
    this.call("record_broadcast", {
      owner: this.cfg.owner,
      plan_index: planIndex,
      leg_index: legIndex,
      tx_hash: txHash,
    });
}
