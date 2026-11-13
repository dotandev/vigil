"use client";

import { useState } from "react";
import type { Estate } from "@/lib/chain";
import { duration, near } from "@/lib/format";
import { Confirm, CopyButton } from "./ui";
import { canRemind, checkInCalendar, download } from "@/lib/ics";
import { useWallet } from "./providers";

export type Role = "owner" | "heir" | "visitor" | "anonymous";

export function roleOf(estate: Estate, account: string | null): Role {
  if (!account) return "anonymous";
  if (account === estate.owner) return "owner";
  if (estate.heirs.some((h) => h.near_account === account)) return "heir";
  return "visitor";
}

const ROLE_COPY: Record<Role, string> = {
  owner: "This is your vigil.",
  heir: "You are named as an heir on this vigil.",
  visitor: "You are watching someone else's vigil. You can still feed its agent.",
  anonymous: "Connect a wallet to act on this vigil.",
};

/** What the owner can do beyond checking in: revive, top up, earn, stand down. */
export function OwnerConsole({ estate }: { estate: Estate }) {
  const { account, run, busy, connect } = useWallet();
  const role = roleOf(estate, account);
  const [reopenAmt, setReopenAmt] = useState("3");
  const [topUp, setTopUp] = useState("5");
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const windowMs = estate.check_in_interval_ms + estate.grace_period_ms;
  const rent = BigInt(estate.agent.rent_per_day);
  const runwayFor = (amt: string) => {
    try {
      const y = BigInt(Math.round(Number(amt) * 1e6)) * 10n ** 18n;
      return Number((y * 86_400_000n) / rent);
    } catch {
      return 0;
    }
  };
  const reopenRunway = runwayFor(reopenAmt);
  // Always the canonical vigil page, whichever page this console sits on.
  const shareUrl =
    typeof location !== "undefined"
      ? `${location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vigil?owner=${encodeURIComponent(estate.owner)}`
      : "";

  return (
    <article className="card console">
      <header className="card-head">
        <h2>{role === "owner" ? "Owner console" : "Your role"}</h2>
        <span className="pill" data-tone={role === "owner" ? "warm" : role === "heir" ? "good" : "muted"}>
          {role === "anonymous" ? "not connected" : role}
        </span>
      </header>
      <p className="muted">{ROLE_COPY[role]}</p>

      {role === "anonymous" && (
        <button className="btn btn-warm" type="button" onClick={connect}>
          Connect wallet
        </button>
      )}

      {role === "owner" && (
        <div className="console-grid">
          {estate.status === "Lapsed" && (
            <section className="console-item console-alert">
              <h3>Revive the watchman</h3>
              <p className="muted small">
                Your agent starved, so nothing is being watched. Only you can reopen it. The endowment must outlast one full
                window ({duration(windowMs)}).
              </p>
              <div className="actions">
                <div className="input-group">
                  <input className="amount" inputMode="decimal" value={reopenAmt} onChange={(e) => setReopenAmt(e.target.value)} aria-label="Endowment in NEAR" />
                  <span className="unit">NEAR</span>
                </div>
                <button
                  className="btn btn-warm"
                  type="button"
                  disabled={!!busy || reopenRunway < windowMs}
                  onClick={() => run("Reopening the vigil", (w) => w.reopen(w.nearToYocto(reopenAmt), null), "Vigil reopened. The watch resumes.")}
                >
                  Reopen
                </button>
              </div>
              <p className={reopenRunway < windowMs ? "small bad-text" : "muted small"}>
                Runway at {near(rent)} N/day: {duration(reopenRunway)}
                {reopenRunway < windowMs && " (too short for one window)"}
              </p>
            </section>
          )}

          {estate.agent.state === "Alive" && (
            <section className="console-item">
              <h3>Top up the agent</h3>
              <p className="muted small">Extend its runway. Same as feeding, from your own account.</p>
              <div className="actions">
                <div className="input-group">
                  <input className="amount" inputMode="decimal" value={topUp} onChange={(e) => setTopUp(e.target.value)} aria-label="Top-up in NEAR" />
                  <span className="unit">NEAR</span>
                </div>
                <button className="btn" type="button" disabled={!!busy} onClick={() => run("Topping up", (w) => w.feed(estate.owner, w.nearToYocto(topUp)), `Added ${topUp} NEAR of runway`)}>
                  Top up
                </button>
              </div>
              <p className="muted small">Adds about {duration(runwayFor(topUp))} of runway.</p>
            </section>
          )}

          {estate.yield_source && estate.agent.state === "Alive" && (
            <section className="console-item">
              <h3>Harvest yield</h3>
              <p className="muted small">
                Pull what <code>{estate.yield_source}</code> has accrued into the agent&apos;s balance. Anyone may call this.
              </p>
              <button className="btn" type="button" disabled={!!busy} onClick={() => run("Harvesting yield", (w) => w.harvest(estate.owner))}>
                Harvest
              </button>
            </section>
          )}

          <section className="console-item">
            <h3>Never miss a check-in</h3>
            {canRemind(estate.check_in_interval_ms) ? (
              <>
                <p className="muted small">
                  A repeating event every {duration(estate.check_in_interval_ms)}, with an alert the day before. Works in Google Calendar, Apple
                  Calendar and Outlook.
                </p>
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    download(
                      "vigil-check-in.ics",
                      checkInCalendar({
                        owner: estate.owner,
                        url: shareUrl,
                        nextDueMs: estate.last_check_in_ms + estate.check_in_interval_ms,
                        intervalMs: estate.check_in_interval_ms,
                        graceMs: estate.grace_period_ms,
                      }),
                    )
                  }
                >
                  Add to calendar
                </button>
              </>
            ) : (
              <p className="muted small">This vigil checks in every {duration(estate.check_in_interval_ms)}, which is too often for a calendar. Real vigils run on days or weeks.</p>
            )}
          </section>

          {estate.status !== "Settled" && (
            <section className="console-item">
              <h3>Stand down</h3>
              <p className="muted small">Close the vigil and take back what is left of the endowment. Your estate is untouched.</p>
              <button className="btn btn-danger-ghost" type="button" disabled={!!busy} onClick={() => setConfirmRevoke(true)}>
                Revoke vigil
              </button>
            </section>
          )}
        </div>
      )}

      {role === "heir" && (
        <p className="small">
          When the owner goes silent past the grace period, your share is paid to the address on the plan. Until then, keeping the agent fed is the
          one thing you can do to make sure the watch never lapses.
        </p>
      )}

      <div className="share-row">
        <span className="muted small">Share this vigil</span>
        <CopyButton value={shareUrl || ""} label="Copy link" />
      </div>

      <Confirm
        open={confirmRevoke}
        title="Revoke this vigil?"
        confirmLabel="Revoke and refund"
        danger
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => run("Revoking the vigil", (w) => w.revoke(), "Vigil revoked. The endowment was refunded.")}
      >
        <p>
          The agent stands down and its remaining balance ({near(estate.agent.balance)} NEAR before rent) returns to you. Nobody will be watching
          for your check-ins any more. Your estate addresses keep their funds.
        </p>
      </Confirm>
    </article>
  );
}
