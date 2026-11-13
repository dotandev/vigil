/**
 * The watchman.
 *
 * One loop, and the order of its steps is the whole design:
 *
 *   1. Pay rent. Existing costs money and the bill comes first.
 *   2. Earn, if the estate has somewhere to earn from.
 *   3. If dead — say so, and stop. A dead agent does nothing else, ever.
 *   4. If the owner is overdue but not yet silent, nudge them.
 *   5. If the owner is silent, commit the plan.
 *   6. If a plan is committed, settle it leg by leg.
 *
 * Step 3 sits above steps 5 and 6 on purpose. The contract enforces the same
 * ordering, so an agent that ignored it would simply be rejected on-chain.
 */

import { loadConfig } from "./config.js";
import { deriveEvmAddress, ROOT_PUBLIC_KEYS } from "./derive.js";
import {
  assembleSignedTx,
  broadcast,
  buildLeg,
  evmClient,
  readBalance,
  TRANSFER_GAS_LIMIT,
} from "./evm.js";
import { VigilClient, type Estate, type VigilStatus } from "./near.js";
import { announceLapse, announceSettlement, nudgeOwner } from "./outreach.js";
import type { Hex } from "viem";

const cfg = loadConfig();
const vigil = new VigilClient(cfg);
const evm = evmClient(cfg.evmRpcUrl);

const near = (yocto: string | bigint) =>
  (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

/** The address the vigil contract can sign for on this chain. */
const estateAddress = deriveEvmAddress(
  cfg.contractId,
  cfg.derivationPath,
  ROOT_PUBLIC_KEYS[cfg.network],
) as Hex;

async function payRent(status: VigilStatus) {
  const owed = await vigil.pendingRent();
  if (owed < cfg.minRentToTickYocto) return;
  log(`  rent due ${near(owed)} N — ticking`);
  await vigil.tick();
}

async function earn(estate: Estate) {
  if (!(estate as unknown as { yield_source?: string }).yield_source) return;
  try {
    await vigil.harvest();
    log("  harvested wages from the yield source");
  } catch (e) {
    log("  harvest failed:", (e as Error).message);
  }
}

async function settleOneLeg(
  planIndex: number,
  legIndex: number,
  nonceOffset: number,
  estate: Estate,
) {
  const leg = estate.plans[planIndex]!.legs[legIndex]!;
  log(`  leg ${legIndex} → ${leg.heir_label} ${leg.to} (${leg.value} wei)`);

  const fields = await buildLeg(evm, {
    from: estateAddress,
    to: leg.to,
    value: BigInt(leg.value),
    chainId: cfg.evmChainId,
    nonceOffset,
    maxFeeCapWei: cfg.gasReserveWei / TRANSFER_GAS_LIMIT,
  });

  // The contract re-encodes these fields and signs the hash it computes
  // itself. If any of them disagrees with the committed plan, this throws.
  await vigil.signSettlementLeg(planIndex, legIndex, fields);

  const refreshed = await vigil.getEstate();
  const signature = refreshed.plans[planIndex]?.legs[legIndex]?.signature;
  if (!signature) {
    log("  no signature yet; will retry next tick");
    return;
  }

  const signed = assembleSignedTx(fields, signature);
  if (cfg.dryRun) {
    log(`  [dry-run] would broadcast ${signed.slice(0, 24)}…`);
    return;
  }
  const hash = await broadcast(evm, signed);
  log(`  broadcast ${hash}`);
  await vigil.recordBroadcast(planIndex, legIndex, hash);
}

async function settle(estate: Estate) {
  for (const [planIndex, plan] of estate.plans.entries()) {
    let nonceOffset = 0;
    for (const [legIndex, leg] of plan.legs.entries()) {
      if (leg.status !== "AwaitingSignature") continue;
      await settleOneLeg(planIndex, legIndex, nonceOffset, estate);
      nonceOffset += 1;
    }
  }
}

let announced = false;

async function step() {
  const status = await vigil.getStatus();
  const estate = await vigil.getEstate();

  log(
    `${status.status}/${status.agent_state} — balance ${near(status.agent_balance)} N, ` +
      `runway ${(status.runway_ms / 86_400_000).toFixed(2)}d, ` +
      `legs ${status.legs_signed}/${status.legs_total}`,
  );

  if (status.agent_state === "Starved") {
    if (!announced) {
      announced = true;
      log("\n  THE WATCH HAS LAPSED\n  " + (await announceLapse(cfg, status)) + "\n");
    }
    return "stop";
  }
  if (status.agent_state === "Fulfilled") {
    if (!announced) {
      announced = true;
      log("\n  THE ESTATE IS SETTLED\n  " + (await announceSettlement(cfg, status)) + "\n");
    }
    return "stop";
  }
  if (status.status === "Revoked" || status.status === "Settled") return "stop";

  await payRent(status);
  await earn(estate);

  // Re-read: paying rent may have just killed the agent.
  const after = await vigil.getStatus();
  if (after.agent_state !== "Alive") return "continue";

  if (after.status === "Watching") {
    const now = Date.now();
    const untilSilent = after.silent_at_ms - now;

    if (after.is_silent) {
      const balance = await readBalance(evm, estateAddress);
      const distributable =
        balance > cfg.gasReserveWei ? balance - cfg.gasReserveWei : 0n;
      log(
        `  owner silent since ${new Date(after.silent_at_ms).toISOString()} — ` +
          `committing plan over ${distributable} wei`,
      );
      await vigil.declareSilence([distributable]);
    } else if (untilSilent < 2 * 86_400_000) {
      log("  " + (await nudgeOwner(cfg, after, untilSilent)));
    }
  }

  if (after.status === "Triggered") {
    await settle(await vigil.getEstate());
  }

  return "continue";
}

async function main() {
  log(`vigil agent watching ${cfg.owner} via ${cfg.contractId}`);
  log(`estate address on chain ${cfg.evmChainId}: ${estateAddress}`);
  if (cfg.dryRun) log("DRY RUN — no transactions will be sent");

  for (;;) {
    try {
      if ((await step()) === "stop") {
        log("nothing left to watch; the agent stops here");
        return;
      }
    } catch (e) {
      log("error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
