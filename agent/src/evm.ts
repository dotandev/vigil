/**
 * The EVM side of a settlement.
 *
 * The agent never holds a key here either. It builds an unsigned transaction,
 * hands the *fields* to the vigil contract, and waits for the MPC network's
 * signature to appear in contract state. Then it staples the two together and
 * broadcasts. Every number below is checked against the committed plan by the
 * contract before anything is signed.
 */

import {
  createPublicClient,
  http,
  serializeTransaction,
  type Hex,
  type PublicClient,
} from "viem";

export interface UnsignedLeg {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  value: string;
}

/** A plain value transfer costs exactly this much gas, always. */
export const TRANSFER_GAS_LIMIT = 21_000n;

export function evmClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

export async function readBalance(
  client: PublicClient,
  address: Hex,
): Promise<bigint> {
  return client.getBalance({ address });
}

/**
 * Build the fields for one leg. `nonceOffset` matters: the legs of a plan all
 * come from the same address, so they must be numbered consecutively or the
 * second one will never confirm.
 */
export async function buildLeg(
  client: PublicClient,
  opts: {
    from: Hex;
    to: string;
    value: bigint;
    chainId: number;
    nonceOffset: number;
    maxFeeCapWei: bigint;
  },
): Promise<UnsignedLeg> {
  const baseNonce = await client.getTransactionCount({
    address: opts.from,
    blockTag: "pending",
  });
  const fees = await client.estimateFeesPerGas();

  const maxFee =
    fees.maxFeePerGas < opts.maxFeeCapWei ? fees.maxFeePerGas : opts.maxFeeCapWei;
  const tip =
    fees.maxPriorityFeePerGas < maxFee ? fees.maxPriorityFeePerGas : maxFee;

  return {
    chain_id: opts.chainId,
    nonce: baseNonce + opts.nonceOffset,
    max_priority_fee_per_gas: tip.toString(),
    max_fee_per_gas: maxFee.toString(),
    gas_limit: Number(TRANSFER_GAS_LIMIT),
    to: opts.to.toLowerCase(),
    value: opts.value.toString(),
  };
}

/**
 * Turn the contract's stored `0x<r><s><v>` into a broadcastable transaction.
 *
 * The contract stores `r` as the x-coordinate of the MPC network's `big_r`
 * point and `v` as the recovery id, which is exactly what EIP-1559 wants as
 * `yParity`.
 */
export function assembleSignedTx(leg: UnsignedLeg, signature: string): Hex {
  const raw = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (raw.length !== 130) {
    throw new Error(`expected 65 signature bytes, got ${raw.length / 2}`);
  }
  const r = `0x${raw.slice(0, 64)}` as Hex;
  const s = `0x${raw.slice(64, 128)}` as Hex;
  const yParity = parseInt(raw.slice(128, 130), 16);

  return serializeTransaction(
    {
      type: "eip1559",
      chainId: leg.chain_id,
      nonce: leg.nonce,
      maxPriorityFeePerGas: BigInt(leg.max_priority_fee_per_gas),
      maxFeePerGas: BigInt(leg.max_fee_per_gas),
      gas: BigInt(leg.gas_limit),
      to: leg.to as Hex,
      value: BigInt(leg.value),
      data: "0x",
    },
    { r, s, yParity: yParity as 0 | 1 },
  );
}

export async function broadcast(
  client: PublicClient,
  signedTx: Hex,
): Promise<Hex> {
  return client.sendRawTransaction({ serializedTransaction: signedTx });
}
