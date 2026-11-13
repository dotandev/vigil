"use client";

import { useState } from "react";
import type { Snapshot } from "@/lib/chain";
import { ago, duration, MS_PER_DAY, near, rentRate } from "@/lib/format";
import { Bar, Pill, useTick } from "./ui";
import { useWallet } from "./providers";

/** The agent's balance and runway, advanced locally between polls. */
export function liveAgent(snap: Snapshot) {
  const estate = snap.estate!;
  const status = snap.status!;
  const alive = estate.agent.state === "Alive";
  const window = estate.check_in_interval_ms + estate.grace_period_ms;
  // Rent accrues only while Watching: once silence is declared the contract
  // stops charging, so the agent keeps its balance to finish the settlement.
  const charging = alive && estate.status === "Watching";
  const runway = charging ? Math.max(0, status.runway_ms - (Date.now() - snap.fetchedAtMs)) : 0;
  const balance = charging
    ? (BigInt(estate.agent.rent_per_day) * BigInt(Math.floor(runway))) / BigInt(MS_PER_DAY)
    : BigInt(estate.agent.balance);
  const frac = charging ? (window > 0 ? Math.min(1, runway / window) : 1) : alive ? 1 : 0;
  const tone = !charging ? (alive ? "warm" : "bad") : frac < 0.34 ? "bad" : frac < 1 ? "warm" : "good";
  return { alive, charging, runway, balance, frac, tone };
}

export function AgentCard({ snap, owner }: { snap: Snapshot; owner: string }) {
  useTick();
  const { run, busy } = useWallet();
  const [amount, setAmount] = useState("1");
  const estate = snap.estate!;
  const a = liveAgent(snap);

  return (
    <article className="card agent">
      <header className="card-head">
        <h2>The agent</h2>
        <Pill state={estate.agent.state} />
      </header>
      <div className="big">
        <span>{near(a.balance)}</span>
        <small>NEAR</small>
      </div>
      <Bar frac={a.frac} tone={a.tone} label="Runway against the check-in window" />
      <dl className="facts">
        <div>
          <dt>Runway</dt>
          <dd>{a.charging ? duration(a.runway) : a.alive ? "rent paused" : "dead"}</dd>
        </div>
        <div>
          <dt>Rent</dt>
          <dd>{rentRate(estate.agent.rent_per_day)}</dd>
        </div>
        <div>
          <dt>Rent paid</dt>
          <dd>{near(estate.agent.total_rent_paid)} N</dd>
        </div>
        <div>
          <dt>Fed by others</dt>
          <dd>{near(estate.agent.total_donated)} N</dd>
        </div>
      </dl>
      <p className="hint">Anyone may feed the agent. Heirs have every reason to keep alive the watchman that will one day pay them.</p>
      <div className="actions">
        <div className="input-group">
          <input className="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount of NEAR to feed" />
          <span className="unit">NEAR</span>
        </div>
        <button
          className="btn"
          type="button"
          disabled={!a.alive || !!busy}
          onClick={() => run("Feeding the agent", (w) => w.feed(owner, w.nearToYocto(amount)), `Fed ${amount} NEAR`)}
        >
          Feed
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          title="Charge rent now. Anyone may."
          disabled={!a.alive || !!busy}
          onClick={() => run("Charging rent", (w) => w.tick(owner))}
        >
          Charge rent
        </button>
      </div>
    </article>
  );
}

export function OwnerCard({ snap }: { snap: Snapshot }) {
  useTick();
  const { account, run, busy } = useWallet();
  const estate = snap.estate!;
  const status = snap.status!;
  const chainNow = snap.chainNowMs + (Date.now() - snap.fetchedAtMs);
  const window = estate.check_in_interval_ms + estate.grace_period_ms;
  const untilSilent = status.silent_at_ms - chainNow;
  const untilDue = estate.last_check_in_ms + estate.check_in_interval_ms - chainNow;

  let big: string;
  let label: string;
  if (estate.status === "Watching") {
    big = untilSilent > 0 ? duration(untilSilent) : "silent";
    label = untilSilent <= 0 ? "past the deadline" : untilDue > 0 ? "until silent" : "in grace period";
  } else if (estate.status === "Triggered") {
    big = "silent";
    label = "plan committed";
  } else if (estate.status === "Lapsed") {
    big = "unwatched";
    label = "the agent starved";
  } else {
    big = estate.status.toLowerCase();
    label = "";
  }
  const frac = estate.status === "Watching" && window > 0 ? untilSilent / window : 0;
  const inGrace = estate.status === "Watching" && untilDue <= 0 && untilSilent > 0;

  const isOwner = account === estate.owner;
  const canCheckIn = isOwner && estate.agent.state === "Alive" && (estate.status === "Watching" || estate.status === "Triggered");
  const gwei = Number(BigInt(estate.max_fee_per_gas_cap) / 1_000_000n) / 1000;

  return (
    <article className="card owner">
      <header className="card-head">
        <h2>The owner</h2>
        <Pill state={estate.status} />
      </header>
      <div className="big">
        <span>{big}</span>
        <small>{label}</small>
      </div>
      <Bar frac={frac} tone={inGrace ? "bad" : undefined} label="Check-in window remaining" />
      <dl className="facts">
        <div>
          <dt>Last check-in</dt>
          <dd>{ago(estate.last_check_in_ms + (Date.now() - chainNow))}</dd>
        </div>
        <div>
          <dt>Check in every</dt>
          <dd>{duration(estate.check_in_interval_ms)}</dd>
        </div>
        <div>
          <dt>Grace</dt>
          <dd>{duration(estate.grace_period_ms)}</dd>
        </div>
        <div>
          <dt>Gas cap</dt>
          <dd>{gwei.toLocaleString()} gwei</dd>
        </div>
      </dl>
      <p className="hint">
        {estate.status === "Triggered"
          ? "Silence was declared, but you can still pull back: checking in now discards the plan, until the last signature lands."
          : "Checking in works right up until the last signature: a trigger is discarded and the vigil goes back to watching."}
      </p>
      <div className="actions">
        {isOwner ? (
          <button className="btn btn-warm" type="button" disabled={!canCheckIn || !!busy} onClick={() => run("Checking in", (w) => w.checkIn(), "Checked in. The clock is reset.")}>
            Check in
          </button>
        ) : (
          <span className="muted small">
            Only <code>{estate.owner}</code> can check in.
          </span>
        )}
      </div>
    </article>
  );
}
