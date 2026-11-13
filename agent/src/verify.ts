/**
 * Independent check that a settlement signature is genuine.
 *
 *     npm run verify -- <vigil-contract> <owner> [leg] [nonce] [maxPriorityFee] [maxFee]
 *
 * Reads the committed plan and the MPC signature straight from the contract,
 * rebuilds the EIP-1559 transaction from the plan's recipient and amount, and
 * recovers the signer. If the recovered address equals the estate address
 * derived from (contract, path), the MPC network really did sign that exact
 * transfer for an address nobody holds a key to.
 *
 * Uses the signed transaction the contract assembled. For a leg without one,
 * it rebuilds the transaction with the fee and nonce defaults scripts/demo.sh uses.
 */
import { recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import { deriveEvmAddress, ROOT_PUBLIC_KEYS } from "./derive.js";

const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";

async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await res.json()) as any;
  if (!body.result?.result) throw new Error(JSON.stringify(body.error ?? body.result));
  return JSON.parse(Buffer.from(body.result.result).toString());
}

const [contract, owner, legArg = "0", nonce = "0", tip = "1000000000", maxFee = "30000000000"] =
  process.argv.slice(2);
if (!contract || !owner) {
  console.error("usage: npm run verify -- <vigil-contract> <owner> [leg] [nonce] [tip] [maxFee]");
  process.exit(1);
}

const estate = await view<any>(contract, "get_estate", { owner });
if (!estate) throw new Error(`no vigil for ${owner}`);
const plan = estate.plans.at(-1);
const leg = plan?.legs[Number(legArg)];
if (!leg?.signature) throw new Error("that leg has no signature yet");

const slot = estate.slots[leg.slot_index];
const chainId = slot.chain.Evm.chain_id as number;
const estateAddr = deriveEvmAddress(contract, slot.derivation_path, ROOT_PUBLIC_KEYS.testnet);

const sig: string = leg.signature;
// The contract stores the complete signed transaction; older legs only have r||s||v.
const signed = (leg.signed_tx as Hex | undefined) ?? serializeTransaction(
  {
    type: "eip1559",
    chainId,
    nonce: Number(nonce),
    maxPriorityFeePerGas: BigInt(tip),
    maxFeePerGas: BigInt(maxFee),
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
const recovered = await recoverTransactionAddress({ serializedTransaction: signed as any });

console.log(`leg ${legArg}: ${leg.heir_label} <- ${Number(leg.value) / 1e18} ETH on chain ${chainId}`);
console.log(`estate address (derived)   ${estateAddr}`);
console.log(`signer (recovered from sig) ${recovered.toLowerCase()}`);
const ok = recovered.toLowerCase() === estateAddr.toLowerCase();
console.log(ok ? "MATCH: the MPC network signed this transfer for the estate" : "MISMATCH");
process.exit(ok ? 0 : 1);
