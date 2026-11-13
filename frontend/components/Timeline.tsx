"use client";

import { useEffect, useState } from "react";
import { EXPLORER, ownerEvents, type VigilEventRow } from "@/lib/chain";
import { CONTRACT } from "@/lib/config";
import { ago, eth, near, short } from "@/lib/format";
import { useWallet } from "./providers";
import { Skeleton } from "./ui";

const LABEL: Record<string, { title: string; tone: string }> = {
  vigil_opened: { title: "Vigil opened", tone: "good" },
  checked_in: { title: "Owner checked in", tone: "good" },
  agent_fed: { title: "Agent fed", tone: "good" },
  yield_harvested: { title: "Yield harvested", tone: "good" },
  rent_charged: { title: "Rent charged", tone: "muted" },
  agent_starved: { title: "Agent starved", tone: "bad" },
  silence_declared: { title: "Silence declared", tone: "warm" },
  settlement_signed: { title: "Payment signed by the MPC network", tone: "warm" },
  settlement_broadcast: { title: "Payment broadcast", tone: "good" },
  agent_fulfilled: { title: "Fulfilled", tone: "good" },
  vigil_revoked: { title: "Vigil revoked", tone: "muted" },
};

function detail(e: VigilEventRow): string | null {
  const d = e.data as Record<string, string | number>;
  switch (e.event) {
    case "vigil_opened":
      return Number(d.runway_days) >= 1 ? `${d.runway_days} day${d.runway_days === 1 ? "" : "s"} of runway` : "under a day of runway";
    case "agent_fed":
      return `${near(String(d.amount), 3)} N from ${d.by}`;
    case "yield_harvested":
      return `${near(String(d.amount), 3)} N`;
    case "rent_charged":
      return `${near(String(d.amount), 4)} N, ${near(String(d.balance), 3)} N left`;
    case "silence_declared":
      return `${d.legs} payment${d.legs === 1 ? "" : "s"} committed`;
    case "settlement_signed":
      return `${eth(String(d.value))} ETH to ${short(String(d.to), 8, 6)}`;
    case "settlement_broadcast":
      return short(String(d.tx_hash), 10, 8);
    case "vigil_revoked":
      return `${near(String(d.refunded), 3)} N refunded`;
    default:
      return null;
  }
}

/** The vigil's own history, from the events the contract emits. */
export function Timeline({ owner }: { owner: string }) {
  const { nonce } = useWallet();
  const [rows, setRows] = useState<VigilEventRow[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const evs = await ownerEvents(CONTRACT, owner).catch(() => null);
      if (!live) return;
      if (evs) setRows(evs);
      else setRows((r) => r ?? []);
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [owner, nonce]);

  return (
    <article className="card">
      <header className="card-head">
        <h2>History</h2>
        <span className="muted small">from the contract&apos;s own events</span>
      </header>
      {rows === null ? (
        <>
          <Skeleton h={16} />
          <Skeleton h={16} w="80%" />
          <Skeleton h={16} w="60%" />
        </>
      ) : rows.length === 0 ? (
        <p className="muted">No recent events for this vigil.</p>
      ) : (
        <ol className="timeline">
          {rows.map((e, i) => {
            const l = LABEL[e.event] ?? { title: e.event, tone: "muted" };
            const d = detail(e);
            return (
              <li key={`${e.hash}-${i}`} data-tone={l.tone}>
                <span className="tl-dot" aria-hidden="true" />
                <div className="tl-body">
                  <strong>{l.title}</strong>
                  {d && <span className="muted"> · {d}</span>}
                  <div className="tl-meta small">
                    <span className="muted">{ago(e.timestampMs)}</span>
                    <a className="link mono" href={`${EXPLORER}/txns/${e.hash}`} target="_blank" rel="noreferrer">
                      {short(e.hash, 6, 4)}
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}
