"use client";

import Link from "next/link";
import { useVigil, useActivity } from "@/lib/hooks";
import { CONTRACT } from "@/lib/config";
import { EXPLORER } from "@/lib/chain";
import { AgentCard, OwnerCard } from "./Vitals";
import { EstateCard } from "./EstateCard";
import { PlanCard } from "./PlanCard";
import { ActivityCard } from "./ActivityCard";
import { OwnerConsole } from "./OwnerConsole";
import { Timeline } from "./Timeline";
import { Empty, Pill, Skeleton } from "./ui";
import { useWallet } from "./providers";

function Banner({ status, agent }: { status: string; agent: string }) {
  if (status === "Lapsed")
    return (
      <div className="banner" data-tone="bad">
        <strong>The watchman starved.</strong> Nothing is being watched and nothing can be distributed. The estate is untouched. Only the owner can
        reopen it.
      </div>
    );
  if (status === "Triggered")
    return (
      <div className="banner" data-tone="warm">
        <strong>Silence declared.</strong> The settlement plan is committed and frozen. The owner can still check in to pull it back until the last
        leg is signed.
      </div>
    );
  if (status === "Settled" || agent === "Fulfilled")
    return (
      <div className="banner" data-tone="good">
        <strong>Fulfilled.</strong> Every leg of the plan was signed. The watchman&apos;s last act was its purpose.
      </div>
    );
  return null;
}

export function VigilView({ owner }: { owner: string }) {
  const { snap, error, loading } = useVigil(owner);
  const items = useActivity();
  const { account } = useWallet();

  if (loading && !snap)
    return (
      <div className="vigil">
        <div className="vitals">
          <div className="card">
            <Skeleton h={14} w={90} />
            <Skeleton h={44} w="60%" />
            <Skeleton h={6} />
            <Skeleton h={60} />
          </div>
          <div className="card">
            <Skeleton h={14} w={90} />
            <Skeleton h={44} w="60%" />
            <Skeleton h={6} />
            <Skeleton h={60} />
          </div>
        </div>
      </div>
    );

  if (error && !snap) return <p className="notice" data-tone="bad">Could not read {CONTRACT}: {error}</p>;

  if (!snap?.estate || !snap.status)
    return (
      <Empty title={`${owner} has no vigil`}>
        <p className="muted">There is nothing being watched for this account on {CONTRACT}.</p>
        {account === owner ? (
          <Link className="btn btn-warm" href="/new">
            Open your vigil
          </Link>
        ) : (
          <Link className="btn" href="/explore">
            Browse vigils
          </Link>
        )}
      </Empty>
    );

  const estate = snap.estate;
  return (
    <div className="vigil">
      <div className="vigil-head">
        <div>
          <span className="eyebrow">Vigil for</span>
          <h1 className="vigil-title mono">{owner}</h1>
        </div>
        <div className="vigil-head-pills">
          <Pill state={estate.status} />
          <Pill state={estate.agent.state} label={`agent ${estate.agent.state.toLowerCase()}`} />
          <a className="link small" href={`${EXPLORER}/address/${owner}`} target="_blank" rel="noreferrer">
            Owner on explorer ↗
          </a>
        </div>
      </div>
      <Banner status={estate.status} agent={estate.agent.state} />
      <div className="vitals">
        <AgentCard snap={snap} owner={owner} />
        <OwnerCard snap={snap} />
      </div>
      <OwnerConsole estate={estate} />
      <div className="two-col">
        <EstateCard estate={estate} />
        <PlanCard snap={snap} />
      </div>
      <div className="two-col">
        <Timeline owner={owner} />
        <ActivityCard items={items} explorer={`${EXPLORER}/address/${CONTRACT}`} />
      </div>
    </div>
  );
}
