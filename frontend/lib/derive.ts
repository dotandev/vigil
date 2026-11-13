/**
 * Chain-signature address derivation, in the browser.
 *
 * Same algorithm as agent/src/derive.ts, which is tested against the live
 * signer contract's own `derived_public_key` view:
 *
 *     epsilon = sha3_256(PREFIX + contract + "," + path)   (no reduction)
 *     derived = root + epsilon * G
 *     address = keccak256(uncompressed(derived)[1..])[-20..]
 *
 * The contract stores whatever address it is given, so the UI must derive it
 * correctly: a wrong address here is an estate nobody can ever settle.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";

const PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";

export const ROOT_PUBLIC_KEYS = {
  testnet:
    "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3",
  mainnet:
    "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya",
} as const;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function rootPoint(encoded: string) {
  const raw = bs58.decode(encoded.replace(/^secp256k1:/, ""));
  if (raw.length !== 64) throw new Error("bad root key");
  const full = new Uint8Array(65);
  full[0] = 0x04;
  full.set(raw, 1);
  return secp256k1.Point.fromBytes(full);
}

export function deriveEvmAddress(contract: string, path: string, network: keyof typeof ROOT_PUBLIC_KEYS = "testnet") {
  const digest = sha3_256(new TextEncoder().encode(`${PREFIX}${contract},${path}`));
  const epsilon = BigInt(`0x${toHex(digest)}`);
  const derived = secp256k1.Point.BASE.multiply(epsilon).add(rootPoint(ROOT_PUBLIC_KEYS[network]));
  const hash = keccak_256(derived.toBytes(false).slice(1));
  return `0x${toHex(hash.slice(-20))}` as `0x${string}`;
}

/** The EVM address for a NEAR-encoded secp256k1 public key (as the signer contract returns it). */
export function addressFromNearKey(encoded: string) {
  const hash = keccak_256(rootPoint(encoded).toBytes(false).slice(1));
  return `0x${toHex(hash.slice(-20))}` as `0x${string}`;
}

/** The contract requires every path to be namespaced under its owner. */
export const estatePath = (owner: string, name = "ethereum-1") => `${owner}/${name}`;
