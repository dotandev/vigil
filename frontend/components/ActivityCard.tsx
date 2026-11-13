import type { ActivityItem } from "@/lib/chain";
import { EXPLORER } from "@/lib/chain";
import { ago, short } from "@/lib/format";

export function ActivityCard({ items, explorer }: { items: ActivityItem[] | null; explorer: string }) {
  return (
    <article className="card">
      <header className="card-head">
        <h2>On chain</h2>
        <a className="link" href={explorer} target="_blank" rel="noreferrer">
          Explorer ↗
        </a>
      </header>
      <ol className="activity">
        {items === null ? (
          <li className="muted">Loading…</li>
        ) : items.length === 0 ? (
          <li className="muted">No recent transactions found.</li>
        ) : (
          items.map((t) => (
            <li key={t.hash} data-ok={String(t.ok)}>
              <span className="dot" aria-hidden="true" />
              <span className="mono method">{t.method}</span>
              <span className="muted signer">{t.signer}</span>
              <span className="muted when">{t.ok ? ago(t.timestampMs) : `refused · ${ago(t.timestampMs)}`}</span>
              <a className="link mono" href={`${EXPLORER}/txns/${t.hash}`} target="_blank" rel="noreferrer">
                {short(t.hash, 6, 4)}
              </a>
            </li>
          ))
        )}
      </ol>
    </article>
  );
}
