"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAllVigils } from "@/lib/hooks";
import { duration, near } from "@/lib/format";
import { Empty, Pill, Skeleton } from "@/components/ui";
import { CONTRACT } from "@/lib/config";
import type { EstateStatus } from "@/lib/chain";

const FILTERS: ("All" | EstateStatus)[] = ["All", "Watching", "Triggered", "Lapsed", "Settled"];

export default function Explore() {
  const { rows, error } = useAllVigils();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    if (!rows) return null;
    const order: Record<string, number> = { Triggered: 0, Watching: 1, Lapsed: 2, Settled: 3, Revoked: 4 };
    return rows
      .filter((r) => filter === "All" || r.status === filter)
      .filter((r) => !q || r.owner.includes(q.trim().toLowerCase()))
      .sort((a, b) => order[a.status] - order[b.status] || a.owner.localeCompare(b.owner));
  }, [rows, filter, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: rows?.length ?? 0 };
    rows?.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
    return c;
  }, [rows]);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Explore</span>
          <h1 className="page-title">Every vigil on {CONTRACT}</h1>
          <p className="muted">All of it is public: who is being watched, how long their watchman can last, and whether anything has been signed.</p>
        </div>
        <Link className="btn btn-warm" href="/new">
          Open a vigil
        </Link>
      </div>

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f} role="tab" type="button" aria-selected={filter === f} className="tab" onClick={() => setFilter(f)}>
              {f}
              <span className="tab-count">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search by account…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by owner account" />
      </div>

      {error && !rows && <p className="notice" data-tone="bad">{error}</p>}

      {!shown ? (
        <div className="table-wrap">
          {[0, 1, 2].map((i) => (
            <div className="row-skel" key={i}>
              <Skeleton h={16} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <Empty title="No vigils match">
          <p className="muted">Try another filter, or open the first one.</p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Vigil</th>
                <th>Agent</th>
                <th className="num">Balance</th>
                <th className="num">Runway</th>
                <th className="num">Signed</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.owner}>
                  <td>
                    <Link className="mono row-link" href={`/vigil?owner=${encodeURIComponent(r.owner)}`}>
                      {r.owner}
                    </Link>
                  </td>
                  <td>
                    <Pill state={r.status} />
                  </td>
                  <td>
                    <Pill state={r.agent_state} />
                  </td>
                  <td className="num mono">{near(r.agent_balance, 3)} N</td>
                  <td className="num mono">{r.agent_state === "Alive" ? (r.status === "Watching" ? duration(r.runway_ms) : "paused") : "—"}</td>
                  <td className="num mono">
                    {r.legs_total ? `${r.legs_signed}/${r.legs_total}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
