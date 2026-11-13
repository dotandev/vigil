import { chainById } from "./config";

export const MS_PER_DAY = 86_400_000;

export function near(yocto: string | bigint, digits = 4): string {
  const v = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, digits);
  return `${whole.toLocaleString()}.${frac}`;
}

export function eth(wei: string): string {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function duration(ms: number): string {
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

export const ago = (ms: number) => {
  const diff = Date.now() - ms;
  return diff < 0 ? "just now" : `${duration(diff)} ago`;
};

export const short = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${tail ? s.slice(-tail) : ""}` : s;

/** Demo vigils run on seconds, real ones on days: show whichever reads naturally. */
export function rentRate(perDay: string): string {
  const yocto = BigInt(perDay);
  if (yocto >= 10n ** 26n) return `${near(yocto / 86_400n, 4)} N/s`;
  return `${near(yocto, 4)} N/day`;
}

export type Tone = "good" | "warm" | "bad" | "muted";

export const toneOf = (state: string): Tone =>
  (
    {
      Alive: "good",
      Watching: "good",
      Broadcast: "good",
      Triggered: "warm",
      Fulfilled: "warm",
      Settled: "warm",
      Signed: "warm",
      Starved: "bad",
      Lapsed: "bad",
    } as Record<string, Tone>
  )[state] ?? "muted";

export const chainName = (id: number) => chainById(id)?.name ?? `EVM chain ${id}`;

export function evmExplorer(chainId: number, value: string, kind: "address" | "tx" = "address") {
  return `${chainById(chainId)?.explorer ?? "https://sepolia.etherscan.io"}/${kind}/${value}`;
}
