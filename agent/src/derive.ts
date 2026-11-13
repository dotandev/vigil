/**
 * Chain-signature address derivation.
 *
 * The estate's Ethereum address has no private key. It is the MPC network's
 * root public key plus a tweak derived from (requesting account, path), and
 * the matching secret exists only as shares across the network's operators.
 * Nobody — not the owner, not this agent, not the vigil contract — can sign
 * for it except by asking the network, and the network only answers the
 * contract.
 *
 * Additive key derivation:
 *
 *     epsilon  = sha3_256(PREFIX + predecessorId + "," + path)  as a scalar
 *     derived  = rootPoint + epsilon * G
 *     address  = keccak256(uncompressed(derived)[1..])[-20..]
 *
 * Verified in `derive.test.ts` against the live signer contract's own
 * `derived_public_key` view, which is the only answer that counts.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";

/** Fixed by the MPC implementation; changing a byte changes every address. */
const TWEAK_DERIVATION_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";

export const ROOT_PUBLIC_KEYS = {
  testnet:
    "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3",
  mainnet:
    "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya",
} as const;

export const MPC_SIGNER = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
} as const;

export type NearNetwork = keyof typeof ROOT_PUBLIC_KEYS;

/** NEAR encodes a secp256k1 key as base58 of the 64 raw bytes `x || y`. */
function decodeRootKey(encoded: string): Uint8Array {
  const body = encoded.startsWith("secp256k1:") ? encoded.slice(10) : encoded;
  const raw = bs58.decode(body);
  if (raw.length !== 64) {
    throw new Error(`expected a 64-byte secp256k1 key, got ${raw.length}`);
  }
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(raw, 1);
  return uncompressed;
}

export function deriveEpsilon(predecessorId: string, path: string): bigint {
  // SHA3-256, *not* SHA-256 and *not* keccak256. All three are one import
  // apart and only one of them produces an address the network agrees with.
  // The `,` is nearcore's ACCOUNT_DATA_SEPARATOR, reused here to mark where
  // the account id ends so the hash cannot be made ambiguous.
  const digest = sha3_256(
    new TextEncoder().encode(`${TWEAK_DERIVATION_PREFIX}${predecessorId},${path}`),
  );
  // The contract feeds these bytes to `Scalar::from_repr` with no reduction,
  // so we must not reduce either.
  return bytesToBigInt(digest);
}

/** The derived public key, uncompressed, 65 bytes starting with 0x04. */
export function derivePublicKey(
  predecessorId: string,
  path: string,
  rootPublicKey: string,
): Uint8Array {
  const root = secp256k1.Point.fromBytes(decodeRootKey(rootPublicKey));
  const epsilon = deriveEpsilon(predecessorId, path);
  const derived = secp256k1.Point.BASE.multiply(epsilon).add(root);
  return derived.toBytes(false);
}

/** The Ethereum address the vigil contract controls on `path`. */
export function deriveEvmAddress(
  predecessorId: string,
  path: string,
  rootPublicKey: string,
): `0x${string}` {
  const pub = derivePublicKey(predecessorId, path, rootPublicKey);
  const hash = keccak_256(pub.slice(1));
  return `0x${Buffer.from(hash.slice(-20)).toString("hex")}`;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

// Run directly to print an address: `npm run derive -- <account> <path>`
if (process.argv[1]?.endsWith("derive.ts")) {
  const [account, path = "ethereum-1", network = "testnet"] =
    process.argv.slice(2);
  if (!account) {
    console.error("usage: npm run derive -- <near-account> [path] [network]");
    process.exit(1);
  }
  const root = ROOT_PUBLIC_KEYS[network as NearNetwork];
  console.log(deriveEvmAddress(account, path, root));
}
