"use client";

import { useAllVigils } from "@/lib/hooks";
import { near } from "@/lib/format";
import { Skeleton, Stat } from "./ui";

export function NetworkStats() {
  const { rows } = useAllVigils();
  if (!rows)
    return (
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat" key={i}>
            <Skeleton h={12} w={80} />
            <Skeleton h={28} w={60} />
          </div>
        ))}
      </div>
    );
  const watching = rows.filter((r) => r.status === "Watching").length;
  const lapsed = rows.filter((r) => r.status === "Lapsed").length;
  const endowed = rows.reduce((s, r) => s + BigInt(r.agent_balance), 0n);
  const signed = rows.reduce((s, r) => s + r.legs_signed, 0);
  return (
    <div className="stats">
      <Stat label="Vigils on testnet" value={rows.length} />
      <Stat label="Watching now" value={watching} hint={lapsed ? `${lapsed} lapsed` : undefined} />
      <Stat label="Held by agents" value={`${near(endowed, 2)} N`} />
      <Stat label="MPC signatures" value={signed} hint="settlement legs signed" />
    </div>
  );
}
