// Recover who actually signed a settlement leg, in the browser.
//
// The contract stores r||s||v. Rebuilding the EIP-1559 transaction from the
// committed plan (recipient + amount are fixed on chain) and recovering the
// signer shows the MPC network signed exactly that transfer, for the estate's
// keyless address. Nonce and fees aren't stored — the contract only checks
// them — so they default to what scripts/demo.sh signs with and can be edited.

import { recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import type { ChainSlot, Leg } from "./chain";

export interface FeeParams {
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

export const DEMO_FEES: FeeParams = {
  nonce: 0,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 30_000_000_000n,
};

export async function recoverSigner(leg: Leg, slot: ChainSlot, fees: FeeParams): Promise<string> {
  const sig = leg.signature;
  if (!sig || sig.length !== 132) throw new Error("no signature on this leg");
  const signed = serializeTransaction(
    {
      type: "eip1559",
      chainId: slot.chain.Evm.chain_id,
      nonce: fees.nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gas: 21_000n,
      to: leg.to as Hex,
      value: BigInt(leg.value),
      data: "0x",
      accessList: [],
    },
    {
      r: `0x${sig.slice(2, 66)}`,
      s: `0x${sig.slice(66, 130)}`,
      yParity: parseInt(sig.slice(130, 132), 16),
    },
  );
  const addr = await recoverTransactionAddress({ serializedTransaction: signed as any });
  return addr.toLowerCase();
}
