import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEvmAddress, deriveEpsilon, ROOT_PUBLIC_KEYS } from "./derive.js";

/**
 * Ground truth, taken from the mainnet signer contract itself:
 *
 *   near contract call-function as-read-only v1.signer derived_public_key \
 *     json-args '{"path":"ethereum-1","predecessor":"example.near","domain_id":0}' \
 *     network-config mainnet now
 *   -> secp256k1:5zL9u9afiFPPrPmnH7rEz2t3szev5eZ7wXCwzYq37GYyCbJq3YNU31N4LTULioaw3chJx674XUncmYKiSCd3AxxT
 *
 * which keccaks to the address below. Note this disagrees with the vector
 * printed in the chain-signatures docs page, which predates a change to the
 * derivation and is stale. If this test ever fails, every address we hand an
 * owner to fund is an address the contract cannot sign for, so it is the one
 * test in this repo worth being paranoid about.
 */
const EXAMPLE_NEAR_ETHEREUM_1 = "0xef4ea05e5c11057decc8e1bd6f5369f2acd91fa5";

test("agrees with the live signer contract", () => {
  assert.equal(
    deriveEvmAddress("example.near", "ethereum-1", ROOT_PUBLIC_KEYS.mainnet),
    EXAMPLE_NEAR_ETHEREUM_1,
  );
});

test("a different path gives a different address", () => {
  const a = deriveEvmAddress("example.near", "ethereum-1", ROOT_PUBLIC_KEYS.mainnet);
  const b = deriveEvmAddress("example.near", "ethereum-2", ROOT_PUBLIC_KEYS.mainnet);
  assert.notEqual(a, b);
});

test("a different account gives a different address", () => {
  const a = deriveEvmAddress("example.near", "ethereum-1", ROOT_PUBLIC_KEYS.mainnet);
  const b = deriveEvmAddress("other.near", "ethereum-1", ROOT_PUBLIC_KEYS.mainnet);
  assert.notEqual(a, b);
});

test("testnet and mainnet roots give different addresses", () => {
  const a = deriveEvmAddress("example.near", "ethereum-1", ROOT_PUBLIC_KEYS.mainnet);
  const b = deriveEvmAddress("example.near", "ethereum-1", ROOT_PUBLIC_KEYS.testnet);
  assert.notEqual(a, b);
});

test("epsilon is a usable scalar", () => {
  const e = deriveEpsilon("example.near", "ethereum-1");
  assert.ok(e > 0n);
  assert.ok(e < 2n ** 256n);
});
