import "./style.css";
import {
  activity,
  EXPLORER,
  listOwners,
  snapshot,
  view,
  type ActivityItem,
  type Estate,
  type Snapshot,
} from "./chain";
import { DEMO_FEES, recoverSigner } from "./verify";
// The wallet selector is most of the bundle and only needed to act, not to watch.
const wallet = () => import("./wallet");

const DEFAULT_CONTRACT = import.meta.env.VITE_VIGIL_CONTRACT ?? "vigil-1268e2.testnet";
const DEFAULT_OWNER = import.meta.env.VITE_VIGIL_OWNER ?? "owner-1268e2.testnet";
const POLL_MS = 3_000;
const ACTIVITY_POLL_MS = 15_000;
const MS_PER_DAY = 86_400_000;

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Build DOM without innerHTML: heir labels and addresses are user data. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

function near(yocto: string | bigint, digits = 4): string {
  const v = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, digits);
  return `${whole.toLocaleString()}.${frac}`;
}

function eth(wei: string): string {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms >= Number.MAX_SAFE_INTEGER / 2) return "forever";
  if (ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const d = Math.floor(s / 86_400);
  const hrs = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d >= 2) return `${d}d ${hrs}h`;
  if (d >= 1 || hrs >= 1) return `${d * 24 + hrs}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  return `${duration(diff)} ago`;
}

const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

function rentRate(perDay: string): string {
  const yocto = BigInt(perDay);
  // Demo vigils run on seconds; real ones on days. Show whichever reads naturally.
  if (yocto >= 10n ** 26n) return `${near(yocto / 86_400n, 4)} N/s`;
  return `${near(yocto, 4)} N/day`;
}

function pill(el: HTMLElement, text: string) {
  el.textContent = text;
  el.dataset.tone =
    {
      Alive: "good",
      Watching: "good",
      Triggered: "warm",
      Fulfilled: "warm",
      Settled: "warm",
      Signed: "warm",
      Broadcast: "good",
      AwaitingSignature: "muted",
      Starved: "bad",
      Lapsed: "bad",
      StoodDown: "muted",
      Revoked: "muted",
    }[text] ?? "muted";
}

function notice(text: string | null, tone: "info" | "bad" = "info") {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.dataset.tone = tone;
}

// -------------------------------------------------------------------- state

const params = new URLSearchParams(location.search);
let contract = params.get("contract") ?? DEFAULT_CONTRACT;
let owner = params.get("owner") ?? DEFAULT_OWNER;
let snap: Snapshot | null = null;
let account: string | null = null;
let pollTimer = 0;
let activityTimer = 0;
let lastPlansKey = "";

// ------------------------------------------------------------------ render

/** Chain time now, advanced locally between polls so countdowns tick smoothly. */
const chainNow = () => (snap ? snap.chainNowMs + (Date.now() - snap.fetchedAtMs) : Date.now());

function renderLive() {
  if (!snap?.estate || !snap.status) return;
  const { estate, status } = snap;
  const elapsed = Date.now() - snap.fetchedAtMs;
  const alive = estate.agent.state === "Alive";
  const window = estate.check_in_interval_ms + estate.grace_period_ms;

  // The agent: balance drains continuously at the rent rate.
  // Rent accrues only while Watching: once silence is declared the contract
  // stops charging, so the agent keeps its balance to finish the settlement.
  const charging = alive && estate.status === "Watching";
  const runway = charging ? Math.max(0, status.runway_ms - elapsed) : 0;
  const effective = charging
    ? (BigInt(estate.agent.rent_per_day) * BigInt(Math.floor(runway))) / BigInt(MS_PER_DAY)
    : BigInt(estate.agent.balance);
  $("balance").textContent = near(effective);
  $("runway").textContent = charging ? duration(runway) : alive ? "rent paused" : "dead";
  const runwayFrac = charging ? (window > 0 ? Math.min(1, runway / window) : 1) : alive ? 1 : 0;
  const fill = $("runway-fill");
  fill.style.transform = `scaleX(${runwayFrac})`;
  fill.dataset.tone = !charging ? (alive ? "warm" : "bad") : runwayFrac < 0.34 ? "bad" : runwayFrac < 1 ? "warm" : "good";
  fill.parentElement!.setAttribute("aria-valuenow", String(Math.round(runwayFrac * 100)));

  // The owner: time until silence, in chain time.
  const untilSilent = status.silent_at_ms - chainNow();
  const silenceEl = $("silence");
  const label = $("silence-label");
  if (estate.status === "Watching") {
    silenceEl.textContent = untilSilent > 0 ? duration(untilSilent) : "silent";
    label.textContent = untilSilent > 0 ? "until silent" : "past the deadline";
  } else if (estate.status === "Triggered") {
    silenceEl.textContent = "silent";
    label.textContent = "plan committed";
  } else if (estate.status === "Lapsed") {
    silenceEl.textContent = "unwatched";
    label.textContent = "the agent starved";
  } else {
    silenceEl.textContent = estate.status.toLowerCase();
    label.textContent = "";
  }
  const windowFrac = estate.status === "Watching" && window > 0 ? Math.max(0, Math.min(1, untilSilent / window)) : 0;
  const wfill = $("window-fill");
  wfill.style.transform = `scaleX(${windowFrac})`;
  wfill.parentElement!.setAttribute("aria-valuenow", String(Math.round(windowFrac * 100)));
  $("last-check-in").textContent = ago(estate.last_check_in_ms + (Date.now() - chainNow()));
}

function renderStatic(estate: Estate) {
  pill($("agent-state"), estate.agent.state);
  pill($("estate-status"), estate.status);
  $("rent").textContent = rentRate(estate.agent.rent_per_day);
  $("rent-paid").textContent = `${near(estate.agent.total_rent_paid)} N`;
  $("yield").textContent = estate.yield_source
    ? `${near(estate.agent.total_yield_claimed)} N`
    : "no source";
  $("interval").textContent = duration(estate.check_in_interval_ms);
  $("grace").textContent = duration(estate.grace_period_ms);
  $("gas-cap").textContent = `${(Number(BigInt(estate.max_fee_per_gas_cap) / 1_000_000n) / 1000).toLocaleString()} gwei`;

  const isOwner = account === estate.owner;
  const checkinBtn = $<HTMLButtonElement>("checkin-btn");
  checkinBtn.disabled = !!account && (!isOwner || estate.agent.state !== "Alive");
  checkinBtn.title = !account
    ? "Connect the owner's wallet"
    : isOwner
      ? ""
      : `Only ${estate.owner} can check in`;
  $<HTMLButtonElement>("feed-btn").disabled = estate.agent.state !== "Alive";
  $<HTMLButtonElement>("tick-btn").disabled = estate.agent.state !== "Alive";

  const slots = $("slots");
  slots.replaceChildren(
    ...estate.slots.map((s) =>
      h(
        "div",
        { class: "slot" },
        h("div", { class: "slot-chain" }, chainName(s.chain.Evm.chain_id)),
        h(
          "a",
          { class: "mono addr", href: evmExplorer(s.chain.Evm.chain_id, s.address), target: "_blank", rel: "noreferrer" },
          s.address,
        ),
        h(
          "p",
          { class: "muted small" },
          "No private key exists for this address. It is the MPC root key tweaked by (",
          h("code", {}, contract),
          ", ",
          h("code", {}, s.derivation_path),
          ").",
        ),
      ),
    ),
  );

  $("heirs").replaceChildren(
    ...estate.heirs.map((heir) =>
      h(
        "li",
        {},
        h("span", { class: "heir-name" }, heir.label),
        h("span", { class: "mono muted" }, short(heir.evm_address ?? heir.near_account ?? "—", 8, 6)),
        h(
          "span",
          { class: "share" },
          h("span", { class: "share-bar", style: `--w:${heir.basis_points / 100}%` }),
          `${(heir.basis_points / 100).toFixed(heir.basis_points % 100 ? 2 : 0)}%`,
        ),
      ),
    ),
  );

  renderPlans(estate);
}

function renderPlans(estate: Estate) {
  // Re-render only on change, so an open verification result isn't wiped by a poll.
  const key = JSON.stringify(estate.plans);
  if (key === lastPlansKey) return;
  lastPlansKey = key;

  const has = estate.plans.length > 0;
  $("plan-empty").hidden = has;
  const signed = estate.plans.flatMap((p) => p.legs).filter((l) => l.signature).length;
  const total = estate.plans.flatMap((p) => p.legs).length;
  const planState = $("plan-state");
  planState.hidden = !has;
  if (has) {
    planState.textContent = `${signed}/${total} signed`;
    planState.dataset.tone = signed === total ? "good" : "warm";
  }

  $("plans").replaceChildren(
    ...estate.plans.map((plan) => {
      const slot = estate.slots[plan.legs[0]?.slot_index ?? 0];
      return h(
        "div",
        { class: "plan" },
        h(
          "p",
          { class: "muted small" },
          `Committed ${new Date(plan.committed_at_ms).toLocaleString()} against a reported ${eth(plan.total_reported)} ETH. Recipients and amounts can no longer change.`,
        ),
        h(
          "div",
          { class: "legs" },
          ...plan.legs.map((leg) => {
            const result = h("div", { class: "verify-result", "aria-live": "polite" });
            const btn = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Verify signature");
            btn.addEventListener("click", async () => {
              btn.setAttribute("disabled", "");
              result.textContent = "recovering signer…";
              result.dataset.tone = "";
              try {
                const signer = await recoverSigner(leg, slot, DEMO_FEES);
                const ok = signer === slot.address.toLowerCase();
                result.replaceChildren(
                  h("span", {}, ok ? "✓ signed by the estate address " : "✗ signer does not match: "),
                  h("code", {}, signer),
                );
                result.dataset.tone = ok ? "good" : "bad";
              } catch (e) {
                result.textContent = (e as Error).message;
                result.dataset.tone = "bad";
              } finally {
                btn.removeAttribute("disabled");
              }
            });
            const status = h("span", { class: "pill" });
            pill(status, leg.status);
            return h(
              "div",
              { class: "leg" },
              h(
                "div",
                { class: "leg-main" },
                h("span", { class: "heir-name" }, leg.heir_label),
                h("span", { class: "mono" }, `${eth(leg.value)} ETH`),
                h("span", { class: "mono muted" }, `→ ${short(leg.to, 8, 6)}`),
                status,
              ),
              leg.signature
                ? h(
                    "div",
                    { class: "leg-sig" },
                    h("code", { class: "sig", title: leg.signature }, short(leg.signature, 18, 12)),
                    btn,
                  )
                : h("p", { class: "muted small" }, "Awaiting the MPC network."),
              leg.tx_hash
                ? h(
                    "a",
                    { class: "link small", href: evmExplorer(slot.chain.Evm.chain_id, leg.tx_hash, "tx"), target: "_blank", rel: "noreferrer" },
                    `Broadcast ${short(leg.tx_hash, 10, 8)} ↗`,
                  )
                : null,
              result,
            );
          }),
        ),
      );
    }),
  );
}

function renderActivity(items: ActivityItem[]) {
  const list = $("activity");
  if (!items.length) {
    list.replaceChildren(h("li", { class: "muted" }, "No recent transactions found."));
    return;
  }
  list.replaceChildren(
    ...items.map((t) =>
      h(
        "li",
        { "data-ok": String(t.ok) },
        h("span", { class: "dot", "aria-hidden": "true" }),
        h("span", { class: "mono method" }, t.method),
        h("span", { class: "muted signer" }, t.signer),
        h("span", { class: "muted when" }, t.ok ? ago(t.timestampMs) : `refused · ${ago(t.timestampMs)}`),
        h("a", { class: "link mono", href: `${EXPLORER}/txns/${t.hash}`, target: "_blank", rel: "noreferrer" }, short(t.hash, 6, 4)),
      ),
    ),
  );
}

const chainName = (id: number) =>
  ({ 1: "Ethereum", 11155111: "Ethereum Sepolia", 8453: "Base", 84532: "Base Sepolia" })[id] ?? `EVM chain ${id}`;

function evmExplorer(chainId: number, value: string, kind: "address" | "tx" = "address") {
  const base =
    { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io", 8453: "https://basescan.org", 84532: "https://sepolia.basescan.org" }[
      chainId
    ] ?? "https://sepolia.etherscan.io";
  return `${base}/${kind}/${value}`;
}

// -------------------------------------------------------------------- loop

async function refresh() {
  try {
    snap = await snapshot(contract, owner);
    if (!snap.estate) {
      $("vigil").hidden = true;
      notice(`${owner} has no vigil on ${contract}.`);
      return;
    }
    notice(null);
    $("vigil").hidden = false;
    renderStatic(snap.estate);
    renderLive();
    $("updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    notice(`Could not read ${contract}: ${(e as Error).message}`, "bad");
  }
}

async function refreshActivity() {
  try {
    renderActivity(await activity(contract));
  } catch {
    /* explorer API is a nicety; the contract is the source of truth */
  }
}

function watch() {
  const url = new URL(location.href);
  url.searchParams.set("contract", contract);
  url.searchParams.set("owner", owner);
  history.replaceState(null, "", url);
  $<HTMLAnchorElement>("explorer").href = `${EXPLORER}/address/${contract}`;
  lastPlansKey = "";
  clearInterval(pollTimer);
  clearInterval(activityTimer);
  refresh();
  refreshActivity();
  pollTimer = window.setInterval(refresh, POLL_MS);
  activityTimer = window.setInterval(refreshActivity, ACTIVITY_POLL_MS);
  view<string>(contract, "get_mpc_signer").then((s) => ($("mpc").textContent = s)).catch(() => {});
  listOwners(contract)
    .then((owners) => $("owners").replaceChildren(...owners.map((o) => h("option", { value: o }))))
    .catch(() => {});
  wallet().then((w) => w.initWallet(contract, (acc) => {
    account = acc;
    $("wallet-btn").textContent = acc ? short(acc, 14, 0).replace(/…$/, "…") : "Connect wallet";
    $("wallet-btn").title = acc ? `${acc} — click to sign out` : "";
    if (snap?.estate) renderStatic(snap.estate);
  })).catch((e) => console.warn("wallet selector unavailable", e));
}

async function act(btn: HTMLButtonElement, label: string, fn: () => Promise<unknown>) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = `${label}…`;
  try {
    await fn();
    notice(`${label} sent.`);
    await refresh();
    refreshActivity();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg !== "connect a wallet first") notice(msg, "bad");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

// ----------------------------------------------------------------- wire up

$<HTMLInputElement>("in-contract").value = contract;
$<HTMLInputElement>("in-owner").value = owner;

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  contract = $<HTMLInputElement>("in-contract").value.trim();
  owner = $<HTMLInputElement>("in-owner").value.trim();
  if (contract && owner) watch();
});

$("wallet-btn").addEventListener("click", async () => {
  const w = await wallet();
  return account ? w.signOut() : w.showConnect();
});
$("checkin-btn").addEventListener("click", (e) =>
  act(e.currentTarget as HTMLButtonElement, "Checking in", async () => (await wallet()).checkIn()),
);
$("feed-btn").addEventListener("click", (e) =>
  act(e.currentTarget as HTMLButtonElement, "Feeding", async () =>
    {
      const w = await wallet();
      return w.feed(owner, w.nearToYocto($<HTMLInputElement>("feed-amount").value));
    },
  ),
);
$("tick-btn").addEventListener("click", (e) =>
  act(e.currentTarget as HTMLButtonElement, "Charging rent", async () => (await wallet()).tick(owner)),
);

let raf = 0;
const frame = () => {
  renderLive();
  raf = requestAnimationFrame(frame);
};
raf = requestAnimationFrame(frame);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelAnimationFrame(raf);
  else raf = requestAnimationFrame(frame);
});

watch();
