/**
 * The agent's voice.
 *
 * Deliberately quarantined from every decision. A model never decides whether
 * someone has died, whether silence has elapsed, or what anybody inherits —
 * those come from a clock, a balance and an immutable plan. All a model does
 * here is choose the words, which is the one part of this job that is actually
 * a language problem.
 *
 * If no API key is configured the agent falls back to fixed text and carries
 * on. Nothing in the settlement path depends on this file.
 */

import type { AgentConfig } from "./config.js";
import type { VigilStatus } from "./near.js";

const SYSTEM = `You write short, calm notices on behalf of an automated estate watchman.
The reader is a real person dealing with a possible death or a lapsed safeguard.
Rules: under 60 words. No marketing voice, no emoji, no exclamation marks.
Never speculate about whether someone has died. State only what is mechanically
true and what the reader can do next.`;

async function compose(
  cfg: AgentConfig,
  prompt: string,
  fallback: string,
): Promise<string> {
  if (!cfg.nearAiApiKey) return fallback;
  try {
    const res = await fetch(`${cfg.nearAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.nearAiApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.nearAiModel,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: 160,
        temperature: 0.4,
      }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function days(ms: number): string {
  const d = Math.max(0, Math.floor(ms / 86_400_000));
  return d === 1 ? "1 day" : `${d} days`;
}

/** Nudge the owner, escalating as the deadline approaches. */
export async function nudgeOwner(
  cfg: AgentConfig,
  status: VigilStatus,
  msUntilSilent: number,
): Promise<string> {
  const remaining = days(msUntilSilent);
  const fallback = `Check-in due. Your vigil settles your estate in ${remaining} if you do not check in. Call check_in on ${cfg.contractId} to reset the clock.`;
  return compose(
    cfg,
    `Write a check-in reminder to the owner of an estate vigil.
They have ${remaining} left before the watchman begins distributing to their heirs.
This is reminder urgency level: ${msUntilSilent < 86_400_000 ? "final" : "routine"}.
They reset it by calling check_in on the contract ${cfg.contractId}.`,
    fallback,
  );
}

/** Tell the heirs the watch has stopped without settling anything. */
export async function announceLapse(
  cfg: AgentConfig,
  status: VigilStatus,
): Promise<string> {
  const fallback = `The vigil watching ${status.owner} has lapsed: its agent ran out of funding after ${status.days_survived} days and has stopped. Nothing has been distributed and the estate is untouched. Only the owner can restart it.`;
  return compose(
    cfg,
    `Write a notice to the heirs of an estate vigil.
The watchman agent ran out of money and stopped after ${status.days_survived} days.
Critically: nothing was distributed, the estate is untouched and still entirely the owner's.
Only the owner can restart the vigil. Anyone may fund the agent to keep a future one alive.`,
    fallback,
  );
}

/** Tell the heirs the estate has been settled. */
export async function announceSettlement(
  cfg: AgentConfig,
  status: VigilStatus,
): Promise<string> {
  const fallback = `The vigil watching ${status.owner} recorded no check-in past its deadline and has distributed the estate to the named heirs across ${status.legs_total} transfers. Transaction hashes are recorded on ${cfg.contractId}.`;
  return compose(
    cfg,
    `Write a notice to the heirs of an estate vigil.
The owner did not check in before the deadline, so the watchman distributed the estate
across ${status.legs_total} transfers to the heirs named by the owner.
Each transaction hash is recorded publicly on the contract ${cfg.contractId}.`,
    fallback,
  );
}
