// Funding an estate from an injected EVM wallet (MetaMask, Rabby, …).
// Nothing here can move money *out* of an estate: that needs the MPC network.

import type { EvmChain } from "./config";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

const provider = (): Eip1193 | null =>
  typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

export const hasEvmWallet = () => !!provider();

async function switchTo(p: Eip1193, chain: EvmChain) {
  const hex = `0x${chain.id.toString(16)}`;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [chain.rpc],
          blockExplorerUrls: [chain.explorer],
        },
      ],
    });
  }
}

export function ethToWei(amount: string): bigint {
  const t = amount.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(t)) throw new Error("Enter an amount like 0.01.");
  const [w, f = ""] = t.split(".");
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
}

/** Send `wei` to the estate address on `chain`. Returns the transaction hash. */
export async function fundEstate(chain: EvmChain, to: string, wei: bigint): Promise<string> {
  const p = provider();
  if (!p) throw new Error("No Ethereum wallet found. Install MetaMask, or send funds to the address directly.");
  const [from] = (await p.request({ method: "eth_requestAccounts" })) as string[];
  await switchTo(p, chain);
  return (await p.request({
    method: "eth_sendTransaction",
    params: [{ from, to, value: `0x${wei.toString(16)}` }],
  })) as string;
}

export function explainEvm(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string };
  if (err?.code === 4001) return "You cancelled the transaction.";
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  if (/insufficient funds/i.test(msg)) return "Not enough ETH in your wallet on this network.";
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
