export const NETWORK = "testnet" as const;
export const CONTRACT = process.env.NEXT_PUBLIC_VIGIL_CONTRACT ?? "vigil-1268e2.testnet";
export const DEMO_OWNER = process.env.NEXT_PUBLIC_VIGIL_OWNER ?? "owner-1268e2.testnet";
export const YIELD_POOL = process.env.NEXT_PUBLIC_YIELD_POOL ?? "pool-1268e2.testnet";
export const MPC_SIGNER = "v1.signer-prod.testnet";
export const SEPOLIA_CHAIN_ID = 11155111;
export const REPO = "https://github.com/dotandev/vigil";

/** Mirrors the contract's ABSOLUTE_MIN_RENT_PER_DAY (1 milliNEAR). */
export const MIN_RENT_PER_DAY_YOCTO = 10n ** 21n;

/** Gas for a plain value transfer, which is all a settlement ever is. */
export const TRANSFER_GAS = 21_000n;

export interface EvmChain {
  id: number;
  key: string;
  name: string;
  short: string;
  rpc: string;
  explorer: string;
  faucet: string;
}

/** Every EVM testnet an estate can hold an address on. One MPC key, one derivation, any chain. */
export const CHAINS: EvmChain[] = [
  {
    id: 11155111,
    key: "ethereum",
    name: "Ethereum Sepolia",
    short: "Sepolia",
    rpc: process.env.NEXT_PUBLIC_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    faucet: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  },
  {
    id: 84532,
    key: "base",
    name: "Base Sepolia",
    short: "Base",
    rpc: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    faucet: "https://docs.base.org/chain/network-faucets",
  },
  {
    id: 421614,
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    short: "Arbitrum",
    rpc: process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    faucet: "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info#faucets",
  },
];

export const chainById = (id: number): EvmChain | undefined => CHAINS.find((c) => c.id === id);
