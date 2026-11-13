"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/providers";
import { VigilView } from "@/components/VigilView";
import { Empty, Pill } from "@/components/ui";
import { listOwners, view, type Estate } from "@/lib/chain";
import { CONTRACT } from "@/lib/config";

/** Vigils that name the connected account as an heir. */
function useHeirOf(account: string | null) {
  const [found, setFound] = useState<Estate[] | null>(null);
  useEffect(() => {
    if (!account) return setFound(null);
    let live = true;
    (async () => {
      const owners = await listOwners(CONTRACT).catch(() => []);
      const estates = await Promise.all(
        owners.map((o) => view<Estate | null>(CONTRACT, "get_estate", { owner: o }).catch(() => null)),
      );
      if (live) setFound(estates.filter((e): e is Estate => !!e && e.heirs.some((h) => h.near_account === account)));
    })();
    return () => {
      live = false;
    };
  }, [account]);
  return found;
}

export default function Dashboard() {
  const { account, ready, connect } = useWallet();
  const heirOf = useHeirOf(account);

  if (!account)
    return (
      <main className="page">
        <Empty title="Your vigil lives here">
          <p className="muted">Connect a NEAR wallet to check in, top up your watchman, or see vigils that name you as an heir.</p>
          <button className="btn btn-warm" type="button" onClick={connect} disabled={!ready}>
            Connect wallet
          </button>
        </Empty>
      </main>
    );

  return (
    <main className="page">
      <VigilView owner={account} />
      {heirOf && heirOf.length > 0 && (
        <section className="card heir-of">
          <header className="card-head">
            <h2>You are an heir on</h2>
          </header>
          <ul className="list">
            {heirOf.map((e) => {
              const share = e.heirs.find((h) => h.near_account === account)!.basis_points / 100;
              return (
                <li key={e.owner}>
                  <Link href={`/vigil?owner=${encodeURIComponent(e.owner)}`} className="mono">
                    {e.owner}
                  </Link>
                  <Pill state={e.status} />
                  <span className="muted">{share}% share</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
