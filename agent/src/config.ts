/** Everything the watchman needs to know, and nothing it needs to keep secret. */

import type { NearNetwork } from "./derive.js";

export interface AgentConfig {
  network: NearNetwork;
  nearRpcUrl: string;
  /** The vigil contract. */
  contractId: string;
  /** Whose estate this agent watches. */
  owner: string;
  /** The account the agent transacts as. */
  agentAccountId: string;
  agentPrivateKey: string;
  /** EVM side. */
  evmRpcUrl: string;
  evmChainId: number;
  /** RPC per EVM chain id, for vigils with estate addresses on several chains. */
  evmRpcUrls: Record<number, string>;
  derivationPath: string;
  /** How often to wake up, in ms. */
  pollMs: number;
  /** Don't spend gas ticking for trivial amounts of rent. */
  minRentToTickYocto: bigint;
  /** Gas budget reserved per settlement leg, in wei. */
  gasReserveWei: bigint;
  /** Optional: a model for escalating outreach. Never used to decide anything. */
  nearAiBaseUrl?: string;
  nearAiApiKey?: string;
  nearAiModel: string;
  dryRun: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function loadConfig(): AgentConfig {
  const network = (process.env.NEAR_NETWORK ?? "testnet") as NearNetwork;
  return {
    network,
    nearRpcUrl:
      process.env.NEAR_RPC_URL ?? `https://rpc.${network}.near.org`,
    contractId: required("VIGIL_CONTRACT_ID"),
    owner: required("VIGIL_OWNER"),
    agentAccountId: required("AGENT_ACCOUNT_ID"),
    agentPrivateKey: required("AGENT_PRIVATE_KEY"),
    evmRpcUrl: process.env.EVM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    evmChainId: Number(process.env.EVM_CHAIN_ID ?? 11155111),
    evmRpcUrls: {
      11155111: "https://ethereum-sepolia-rpc.publicnode.com",
      84532: "https://sepolia.base.org",
      421614: "https://sepolia-rollup.arbitrum.io/rpc",
      ...(process.env.EVM_RPC_URLS ? JSON.parse(process.env.EVM_RPC_URLS) : {}),
      [Number(process.env.EVM_CHAIN_ID ?? 11155111)]:
        process.env.EVM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    },
    // Paths are namespaced under the owner: the contract refuses any other shape.
    derivationPath: process.env.DERIVATION_PATH ?? `${required("VIGIL_OWNER")}/ethereum-1`,
    pollMs: Number(process.env.POLL_MS ?? 15_000),
    minRentToTickYocto: BigInt(
      process.env.MIN_RENT_TO_TICK_YOCTO ?? 10n ** 21n,
    ),
    gasReserveWei: BigInt(process.env.GAS_RESERVE_WEI ?? 2_000_000_000_000_000n),
    nearAiBaseUrl: process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1",
    nearAiApiKey: process.env.NEARAI_API_KEY ?? process.env.NEAR_AI_API_KEY,
    nearAiModel: process.env.NEAR_AI_MODEL ?? "deepseek-ai/DeepSeek-V3.1",
    dryRun: process.env.DRY_RUN === "1",
  };
}
