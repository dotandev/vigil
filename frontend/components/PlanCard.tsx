"use client";

import { useEffect, useState } from "react";
import {
  evmBalance,
  evmFees,
  evmNonce,
  evmReceipt,
  evmSendRaw,
  type ChainSlot,
  type Estate,
  type EvmReceipt,
  type Leg,
  type Snapshot,
} from "@/lib/chain";
import { chainById, TRANSFER_GAS } from "@/lib/config";
import { chainName, eth, evmExplorer, short } from "@/lib/format";
import { DEMO_FEES, recoverSigner } from "@/lib/verify";
import { recoverTransactionAddress } from "viem";
import { Pill } from "./ui";
import { useToast, useWallet } from "./providers";

// ---------------------------------------------------------------- helpers

/** The estate must keep enough to pay gas for every leg, at the owner's cap. */
const reservePerChain = (estate: Estate) =>
  BigInt(estate.heirs.filter((h) => h.evm_address).length) * TRANSFER_GAS * BigInt(estate.max_fee_per_gas_cap);

async function signerOf(leg: Leg, slot: ChainSlot) {
  if (leg.signed_tx) return (await recoverTransactionAddress({ serializedTransaction: leg.signed_tx as `0x02${string}` })).toLowerCase();
  return recoverSigner(leg, slot, DEMO_FEES);
}

// -------------------------------------------------------------- one leg

function LegRow({ estate, planIndex, legIndex, leg, slot, plan }: {
  estate: Estate;
  planIndex: number;
  legIndex: number;
  leg: Leg;
  slot: ChainSlot;
  plan: Estate["plans"][number];
}) {
  const { run, busy, account } = useWallet();
  const { push } = useToast();
  const chain = chainById(slot.chain.Evm.chain_id);
  const [verify, setVerify] = useState<{ tone: string; text: string } | null>(null);
  const [receipt, setReceipt] = useState<EvmReceipt | null | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  const hash = leg.tx_hash ?? pendingHash;
  useEffect(() => {
    if (!hash || !chain) return;
    let live = true;
    const load = () => evmReceipt(chain.rpc, hash).then((r) => live && setReceipt(r));
    load();
    const id = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [hash, chain]);

  const requestSignature = () =>
    run(
      `Requesting the MPC signature for ${leg.heir_label}`,
      async (w) => {
        if (!chain) throw new Error(`Unsupported chain ${slot.chain.Evm.chain_id}`);
        // Nonce: this leg goes after every earlier leg of the same plan that
        // has not yet been broadcast, so they land in order.
        const ahead = plan.legs.slice(0, legIndex).filter((l) => l.status !== "Broadcast").length;
        const [base, fees] = await Promise.all([evmNonce(chain.rpc, slot.address), evmFees(chain.rpc, BigInt(estate.max_fee_per_gas_cap))]);
        return w.signLeg(estate.owner, planIndex, legIndex, {
          chain_id: chain.id,
          nonce: base + ahead,
          max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
          max_fee_per_gas: fees.maxFeePerGas.toString(),
          gas_limit: Number(TRANSFER_GAS),
          to: leg.to.toLowerCase(),
          value: leg.value,
        });
      },
      `${leg.heir_label}'s payment is signed by the MPC network`,
    );

  const broadcast = async () => {
    if (!leg.signed_tx || !chain) return;
    setSending(true);
    try {
      const txHash = await evmSendRaw(chain.rpc, leg.signed_tx);
      setPendingHash(txHash);
      push({ tone: "good", title: `Broadcast to ${chain.name}`, body: `${eth(leg.value)} ETH to ${leg.heir_label}`, href: `${chain.explorer}/tx/${txHash}` });
      if (account) await run("Recording the broadcast on NEAR", (w) => w.recordBroadcast(estate.owner, planIndex, legIndex, txHash));
    } catch (e) {
      const msg = (e as Error).message;
      push({
        tone: "bad",
        title: "Broadcast failed",
        body: /insufficient funds/i.test(msg)
          ? `The estate address on ${chain.name} doesn't hold enough to pay this leg and its gas. Fund it, then try again.`
          : /nonce too low|already known/i.test(msg)
            ? "This transaction (or one with its nonce) is already on chain."
            : msg,
      }, 12000);
    } finally {
      setSending(false);
    }
  };

  const checkSignature = async () => {
    setVerify({ tone: "", text: "Recovering the signer…" });
    try {
      const signer = await signerOf(leg, slot);
      const ok = signer === slot.address.toLowerCase();
      setVerify({ tone: ok ? "good" : "bad", text: ok ? `✓ Signed by the estate address ${signer}` : `✗ Signed by ${signer}, not the estate` });
    } catch (e) {
      setVerify({ tone: "bad", text: (e as Error).message });
    }
  };

  const confirmed = receipt?.status === "0x1" && receipt.from.toLowerCase() === slot.address.toLowerCase();

  return (
    <div className="leg">
      <div className="leg-main">
        <span className="heir-name">{leg.heir_label}</span>
        <span className="mono">{eth(leg.value)} ETH</span>
        <span className="mono muted">→ {short(leg.to, 8, 6)}</span>
        <Pill state={confirmed ? "Broadcast" : leg.status} label={confirmed ? "Paid" : leg.status === "AwaitingSignature" ? "Awaiting signature" : leg.status} />
      </div>

      {leg.status === "AwaitingSignature" && estate.status === "Triggered" && (
        <div className="leg-actions">
          <button className="btn btn-sm" type="button" disabled={!!busy || estate.agent.state !== "Alive"} onClick={requestSignature}>
            Request MPC signature
          </button>
          <span className="muted small">Anyone can do this. The contract checks the fields against the plan before the network signs.</span>
        </div>
      )}

      {leg.signature && (
        <div className="leg-sig">
          <code className="sig" title={leg.signature}>
            {short(leg.signature, 18, 12)}
          </code>
          <button className="btn btn-ghost btn-sm" type="button" onClick={checkSignature}>
            Verify signature
          </button>
          {leg.signed_tx && !leg.tx_hash && !pendingHash && (
            <button className="btn btn-warm btn-sm" type="button" disabled={sending} onClick={broadcast}>
              {sending ? "Broadcasting…" : `Broadcast to ${chain?.short ?? "chain"}`}
            </button>
          )}
          {leg.signed_tx && pendingHash && !leg.tx_hash && account && (
            <button className="btn btn-ghost btn-sm" type="button" disabled={!!busy} onClick={() => run("Recording the broadcast on NEAR", (w) => w.recordBroadcast(estate.owner, planIndex, legIndex, pendingHash))}>
              Record on NEAR
            </button>
          )}
        </div>
      )}

      {hash && (
        <div className="leg-tx small">
          <a className="link" href={evmExplorer(slot.chain.Evm.chain_id, hash, "tx")} target="_blank" rel="noreferrer">
            {short(hash, 10, 8)} ↗
          </a>
          <span data-tone={confirmed ? "good" : receipt?.status === "0x0" ? "bad" : ""}>
            {receipt === undefined
              ? "checking…"
              : receipt === null
                ? "pending on chain"
                : confirmed
                  ? `confirmed: paid from the estate in block ${Number(BigInt(receipt.blockNumber))}`
                  : receipt.status === "0x0"
                    ? "reverted on chain"
                    : "confirmed, but not sent from the estate address"}
          </span>
        </div>
      )}

      {verify && (
        <div className="verify-result" data-tone={verify.tone} aria-live="polite">
          {verify.text}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------- declare silence

function DeclareSilence({ snap }: { snap: Snapshot }) {
  const { run, busy } = useWallet();
  const estate = snap.estate!;
  const [balances, setBalances] = useState<(bigint | null)[] | null>(null);
  const reserve = reservePerChain(estate);

  useEffect(() => {
    let live = true;
    Promise.all(estate.slots.map((s) => {
      const c = chainById(s.chain.Evm.chain_id);
      return c ? evmBalance(c.rpc, s.address) : Promise.resolve(null);
    })).then((b) => live && setBalances(b));
    return () => {
      live = false;
    };
  }, [estate.slots]);

  const distributable = balances?.map((b) => (b !== null && b > reserve ? b - reserve : 0n)) ?? null;

  return (
    <div className="declare">
      <p>
        <strong>The owner is silent.</strong> Anyone may now declare it. The plan is committed from each chain&apos;s current balance, less
        gas for every payment at the owner&apos;s cap, and can never change afterwards.
      </p>
      <ul className="declare-list">
        {estate.slots.map((s, i) => (
          <li key={s.derivation_path}>
            <span>{chainName(s.chain.Evm.chain_id)}</span>
            <span className="mono">{distributable ? `${eth(distributable[i].toString())} ETH to distribute` : "reading balance…"}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-warm"
        disabled={!distributable || !!busy}
        onClick={() => run("Declaring silence", (w) => w.declareSilence(estate.owner, distributable!), "Silence declared. The plan is committed.")}
      >
        Declare silence and commit the plan
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ card

export function PlanCard({ snap }: { snap: Snapshot }) {
  const estate = snap.estate!;
  const legs = estate.plans.flatMap((p) => p.legs);
  const signed = legs.filter((l) => l.signature).length;
  const canDeclare = estate.status === "Watching" && estate.agent.state === "Alive" && snap.status!.is_silent;

  return (
    <article className="card">
      <header className="card-head">
        <h2>Settlement</h2>
        {legs.length > 0 && (
          <span className="pill" data-tone={signed === legs.length ? "good" : "warm"}>
            {signed}/{legs.length} signed
          </span>
        )}
      </header>

      {canDeclare && <DeclareSilence snap={snap} />}

      {estate.plans.length === 0 ? (
        !canDeclare && <p className="muted">No plan yet. One is committed, immutably, the moment silence is declared.</p>
      ) : (
        estate.plans.map((plan, planIndex) => {
          const slot = estate.slots[plan.legs[0]?.slot_index ?? 0];
          return (
            <div className="plan" key={`${plan.committed_at_ms}-${planIndex}`}>
              <p className="muted small">
                <strong className="plan-chain">{chainName(slot.chain.Evm.chain_id)}</strong> · committed{" "}
                {new Date(plan.committed_at_ms).toLocaleString()} over {eth(plan.total_reported)} ETH. Recipients and amounts can no longer change.
              </p>
              <div className="legs">
                {plan.legs.map((leg, legIndex) => (
                  <LegRow key={legIndex} estate={estate} plan={plan} planIndex={planIndex} legIndex={legIndex} leg={leg} slot={slot} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </article>
  );
}
