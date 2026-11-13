"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/providers";
import { CopyButton } from "@/components/ui";
import { view, type Estate, type Heir } from "@/lib/chain";
import { CHAINS, chainById, CONTRACT, MIN_RENT_PER_DAY_YOCTO, SEPOLIA_CHAIN_ID, YIELD_POOL } from "@/lib/config";
import { deriveEvmAddress, estatePath } from "@/lib/derive";
import { duration, near, short } from "@/lib/format";

// ------------------------------------------------------------------ model

type HeirRow = { label: string; evm: string; nearAcct: string; pct: string };

const SCHEDULES = [
  { id: "demo", label: "Demo", sub: "20 s / 10 s grace", interval: 20_000, grace: 10_000, rent: "864", endow: "3" },
  { id: "weekly", label: "Weekly", sub: "7 days / 3 days grace", interval: 7 * 864e5, grace: 3 * 864e5, rent: "0.01", endow: "5" },
  { id: "monthly", label: "Monthly", sub: "30 days / 14 days grace", interval: 30 * 864e5, grace: 14 * 864e5, rent: "0.01", endow: "5" },
  { id: "quarterly", label: "Quarterly", sub: "90 days / 30 days grace", interval: 90 * 864e5, grace: 30 * 864e5, rent: "0.005", endow: "5" },
] as const;

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const NEAR_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const STEPS = ["Heirs", "Schedule", "Endowment", "Review"] as const;

function toYocto(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * 10n ** 24n + BigInt(f.padEnd(24, "0"));
}

const toBps = (pct: string) => {
  const n = Number(pct);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

// ------------------------------------------------------------------ page

export default function NewVigil() {
  const router = useRouter();
  const { account, connect, run, busy, ready } = useWallet();
  const [step, setStep] = useState(0);

  const [heirs, setHeirs] = useState<HeirRow[]>([
    { label: "", evm: "", nearAcct: "", pct: "100" },
  ]);
  const [scheduleId, setScheduleId] = useState<string>("weekly");
  const [rent, setRent] = useState("0.01");
  const [endow, setEndow] = useState("5");
  const [gasCap, setGasCap] = useState("100");
  const [useYield, setUseYield] = useState(false);
  const [chainIds, setChainIds] = useState<number[]>([SEPOLIA_CHAIN_ID]);
  const [existing, setExisting] = useState<Estate | null | undefined>(undefined);

  const schedule = SCHEDULES.find((s) => s.id === scheduleId)!;

  useEffect(() => {
    if (!account) return setExisting(undefined);
    view<Estate | null>(CONTRACT, "get_estate", { owner: account })
      .then(setExisting)
      .catch(() => setExisting(null));
  }, [account]);

  const pickSchedule = (id: string) => {
    const s = SCHEDULES.find((x) => x.id === id)!;
    setScheduleId(id);
    setRent(s.rent);
    setEndow(s.endow);
  };

  // ------------------------------------------------------------ validation

  const heirErrors = heirs.map((h) => {
    const e: Partial<Record<keyof HeirRow, string>> = {};
    if (!h.label.trim()) e.label = "Give this heir a name";
    if (!EVM_RE.test(h.evm.trim())) e.evm = "A 0x… address of 40 hex characters";
    if (h.nearAcct.trim() && !NEAR_RE.test(h.nearAcct.trim())) e.nearAcct = "Not a valid NEAR account id";
    const bps = toBps(h.pct);
    if (!(bps > 0)) e.pct = "More than 0%";
    return e;
  });
  const totalBps = heirs.reduce((s, h) => s + (toBps(h.pct) || 0), 0);
  const heirsOk = heirErrors.every((e) => Object.keys(e).length === 0) && totalBps === 10_000;

  const window = schedule.interval + schedule.grace;
  const rentY = toYocto(rent);
  const endowY = toYocto(endow);
  const runwayMs = rentY && endowY && rentY > 0n ? Number((endowY * 86_400_000n) / rentY) : 0;
  const rentOk = !!rentY && rentY >= MIN_RENT_PER_DAY_YOCTO;
  const endowOk = !!endowY && endowY > 0n && runwayMs >= window;
  const gasOk = /^\d+(\.\d+)?$/.test(gasCap) && Number(gasCap) > 0;
  const fundsOk = rentOk && endowOk && gasOk;
  const pathOk = chainIds.length > 0;

  // One keyless address per chain, each under a path namespaced to the owner.
  const slots = useMemo(
    () =>
      account
        ? chainIds.map((id) => {
            const chain = chainById(id)!;
            const path = estatePath(account, `${chain.key}-1`);
            return { chain, path, address: deriveEvmAddress(CONTRACT, path) };
          })
        : [],
    [account, chainIds],
  );
  const estateAddr = slots[0]?.address ?? null;
  const toggleChain = (id: number) =>
    setChainIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].sort((a, b) => CHAINS.findIndex((c) => c.id === a) - CHAINS.findIndex((c) => c.id === b))));

  const canNext = [heirsOk, true, fundsOk && pathOk, true][step];

  // -------------------------------------------------------------- actions

  const setHeir = (i: number, patch: Partial<HeirRow>) => setHeirs((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const addHeir = () => setHeirs((hs) => [...hs, { label: "", evm: "", nearAcct: "", pct: "0" }]);
  const removeHeir = (i: number) => setHeirs((hs) => hs.filter((_, j) => j !== i));
  const splitEvenly = () =>
    setHeirs((hs) => {
      const each = Math.floor(10_000 / hs.length);
      const rem = 10_000 - each * hs.length; // like the contract: rounding goes to the first heir
      return hs.map((h, i) => ({ ...h, pct: String((each + (i === 0 ? rem : 0)) / 100) }));
    });

  const submit = async () => {
    if (!account || !estateAddr || !rentY || !endowY) return;
    const args = {
      heirs: heirs.map<Heir>((h) => ({
        label: h.label.trim(),
        near_account: h.nearAcct.trim() || null,
        evm_address: h.evm.trim(),
        basis_points: toBps(h.pct),
      })),
      slots: slots.map((sl) => ({ chain: { Evm: { chain_id: sl.chain.id } }, derivation_path: sl.path, address: sl.address })),
      check_in_interval_ms: schedule.interval,
      grace_period_ms: schedule.grace,
      rent_per_day: rentY.toString(),
      max_fee_per_gas_cap: (BigInt(Math.round(Number(gasCap) * 1e9))).toString(),
      yield_source: useYield ? YIELD_POOL : null,
    };
    const ok = await run("Opening your vigil", (w) => w.openVigil(args, endowY), "Your vigil is open. The watch begins.");
    if (ok) router.push(`/vigil?owner=${encodeURIComponent(account)}`);
  };

  // -------------------------------------------------------------- render

  if (existing)
    return (
      <main className="page narrow">
        <div className="card">
          <h1 className="page-title">You already have a vigil</h1>
          <p className="muted">
            One vigil per account. To change heirs or schedule, revoke the current one from its page and open a new one.
          </p>
          <Link className="btn btn-warm" href={`/vigil?owner=${encodeURIComponent(account!)}`}>
            Go to your vigil
          </Link>
        </div>
      </main>
    );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Open a vigil</span>
          <h1 className="page-title">Set up your watchman</h1>
        </div>
      </div>

      <ol className="stepper" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} data-done={i < step}>
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
              <span className="stepper-n">{i < step ? "✓" : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="wizard">
        <section className="card wizard-main">
          {step === 0 && (
            <>
              <h2 className="wizard-title">Who inherits?</h2>
              <p className="muted">
                Each heir needs an Ethereum address for their share of the estate. A NEAR account is optional: it receives a share of whatever is left
                in the agent when the work is done.
              </p>
              <div className="heir-forms">
                {heirs.map((h, i) => (
                  <fieldset className="heir-form" key={i}>
                    <legend>Heir {i + 1}</legend>
                    <label className="field">
                      <span>Name</span>
                      <input value={h.label} onChange={(e) => setHeir(i, { label: e.target.value })} placeholder="Amina" />
                      {h.label && heirErrors[i].label && <em>{heirErrors[i].label}</em>}
                    </label>
                    <label className="field">
                      <span>Share</span>
                      <div className="input-group">
                        <input inputMode="decimal" value={h.pct} onChange={(e) => setHeir(i, { pct: e.target.value })} />
                        <span className="unit">%</span>
                      </div>
                      {heirErrors[i].pct && <em>{heirErrors[i].pct}</em>}
                    </label>
                    <label className="field field-wide">
                      <span>Ethereum address</span>
                      <input className="mono" value={h.evm} onChange={(e) => setHeir(i, { evm: e.target.value })} placeholder="0x…" spellCheck={false} />
                      {h.evm && heirErrors[i].evm && <em>{heirErrors[i].evm}</em>}
                    </label>
                    <label className="field field-wide">
                      <span>
                        NEAR account <span className="muted">(optional)</span>
                      </span>
                      <input className="mono" value={h.nearAcct} onChange={(e) => setHeir(i, { nearAcct: e.target.value })} placeholder="amina.testnet" spellCheck={false} />
                      {heirErrors[i].nearAcct && <em>{heirErrors[i].nearAcct}</em>}
                    </label>
                    {heirs.length > 1 && (
                      <button type="button" className="btn btn-ghost btn-sm heir-remove" onClick={() => removeHeir(i)}>
                        Remove
                      </button>
                    )}
                  </fieldset>
                ))}
              </div>
              <div className="actions">
                <button type="button" className="btn" onClick={addHeir} disabled={heirs.length >= 10}>
                  Add heir
                </button>
                {heirs.length > 1 && (
                  <button type="button" className="btn btn-ghost" onClick={splitEvenly}>
                    Split evenly
                  </button>
                )}
                <span className={totalBps === 10_000 ? "total ok" : "total"}>Total {(totalBps / 100).toFixed(2).replace(/\.00$/, "")}% of 100%</span>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="wizard-title">How often will you check in?</h2>
              <p className="muted">
                Miss a check-in and the grace period starts. Stay silent through it too, and the estate settles. Be generous with the grace period: it is
                what protects you when you are alive but unreachable.
              </p>
              <div className="choices" role="radiogroup" aria-label="Check-in schedule">
                {SCHEDULES.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={scheduleId === s.id} className="choice" onClick={() => pickSchedule(s.id)}>
                    <strong>{s.label}</strong>
                    <span className="muted small">{s.sub}</span>
                    {s.id === "demo" && <span className="tag">for trying it out</span>}
                  </button>
                ))}
              </div>
              <p className="small muted">
                Silence is declared {duration(window)} after your last check-in.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="wizard-title">Endow the watchman</h2>
              <p className="muted">
                The agent pays rent from this endowment every second it watches. When it runs out, it dies and can never touch your estate. It must at
                least outlast one window.
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>Endowment</span>
                  <div className="input-group">
                    <input inputMode="decimal" value={endow} onChange={(e) => setEndow(e.target.value)} />
                    <span className="unit">NEAR</span>
                  </div>
                  {!endowOk && endowY && <em>Too small: lasts {duration(runwayMs)}, the window is {duration(window)}</em>}
                </label>
                <label className="field">
                  <span>Rent</span>
                  <div className="input-group">
                    <input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} />
                    <span className="unit">NEAR/day</span>
                  </div>
                  {!rentOk && <em>At least {near(MIN_RENT_PER_DAY_YOCTO, 3)} NEAR/day</em>}
                </label>
                <label className="field">
                  <span>Gas price cap</span>
                  <div className="input-group">
                    <input inputMode="decimal" value={gasCap} onChange={(e) => setGasCap(e.target.value)} />
                    <span className="unit">gwei</span>
                  </div>
                  <small className="muted">The agent can never sign a settlement above this.</small>
                </label>
                <div className="field field-wide">
                  <span>Where the estate lives</span>
                  <div className="chain-picks">
                    {CHAINS.map((c) => (
                      <label key={c.id} className="chain-pick" data-on={chainIds.includes(c.id)}>
                        <input type="checkbox" checked={chainIds.includes(c.id)} onChange={() => toggleChain(c.id)} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                  {!pathOk ? <em>Pick at least one chain</em> : <small className="muted">One MPC key, one keyless address per chain. Each settles on its own.</small>}
                </div>
              </div>
              <div className="runway-box">
                <span className="muted small">Runway</span>
                <strong className="mono">{runwayMs ? duration(runwayMs) : "—"}</strong>
                <span className="muted small">{runwayMs && window ? `covers ${Math.floor(runwayMs / window)} full window${Math.floor(runwayMs / window) === 1 ? "" : "s"}` : ""}</span>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={useYield} onChange={(e) => setUseYield(e.target.checked)} />
                <span>
                  <strong>Let it earn its keep</strong>
                  <span className="muted small">
                    Harvest yield from <code>{YIELD_POOL}</code> into the agent&apos;s balance (a mock pool on demo timescales).
                  </span>
                </span>
              </label>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="wizard-title">Review and open</h2>
              {!account ? (
                <div className="callout">
                  <p>Connect the wallet that will own this vigil. The estate address is derived from it.</p>
                  <button type="button" className="btn btn-warm" onClick={connect} disabled={!ready}>
                    Connect wallet
                  </button>
                </div>
              ) : (
                <>
                  <dl className="review">
                    <div>
                      <dt>Owner</dt>
                      <dd className="mono">{account}</dd>
                    </div>
                    <div>
                      <dt>Heirs</dt>
                      <dd>
                        {heirs.map((h, i) => (
                          <div key={i}>
                            {h.label} · {toBps(h.pct) / 100}% · <span className="mono muted">{short(h.evm, 8, 6)}</span>
                            {h.nearAcct && <span className="mono muted"> · {h.nearAcct}</span>}
                          </div>
                        ))}
                      </dd>
                    </div>
                    <div>
                      <dt>Schedule</dt>
                      <dd>
                        Every {duration(schedule.interval)}, {duration(schedule.grace)} grace
                      </dd>
                    </div>
                    <div>
                      <dt>Endowment</dt>
                      <dd>
                        {endow} NEAR at {rent} NEAR/day · runway {duration(runwayMs)}
                      </dd>
                    </div>
                    <div>
                      <dt>Gas cap</dt>
                      <dd>{gasCap} gwei</dd>
                    </div>
                    <div>
                      <dt>Yield</dt>
                      <dd>{useYield ? YIELD_POOL : "none"}</dd>
                    </div>
                  </dl>
                  <div className="estate-preview">
                    <span className="eyebrow">Your keyless estate address{slots.length > 1 ? "es" : ""}</span>
                    {slots.map((sl) => (
                      <div className="preview-slot" key={sl.chain.id}>
                        <span className="muted small">{sl.chain.name}</span>
                        <div className="slot-addr">
                          <span className="mono addr">{sl.address}</span>
                          <CopyButton value={sl.address} />
                        </div>
                      </div>
                    ))}
                    <p className="muted small">
                      Derived from <code>{CONTRACT}</code> and paths under <code>{account}/</code>. No private key for them exists. Send what you
                      want to pass on here; only your silence can move it.
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          <div className="wizard-nav">
            {step > 0 ? (
              <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button type="button" className="btn btn-warm" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            ) : (
              <button type="button" className="btn btn-warm" disabled={!account || !estateAddr || !!busy || !heirsOk || !fundsOk} onClick={submit}>
                {busy ? "Opening…" : `Open vigil · ${endow} NEAR`}
              </button>
            )}
          </div>
        </section>

        <aside className="card wizard-side" aria-label="Summary">
          <h2>Summary</h2>
          <dl className="facts facts-1">
            <div>
              <dt>Heirs</dt>
              <dd>
                {heirs.length} · {(totalBps / 100).toFixed(2).replace(/\.00$/, "")}%
              </dd>
            </div>
            <div>
              <dt>Check in</dt>
              <dd>every {duration(schedule.interval)}</dd>
            </div>
            <div>
              <dt>Silent after</dt>
              <dd>{duration(window)}</dd>
            </div>
            <div>
              <dt>Runway</dt>
              <dd>{runwayMs ? duration(runwayMs) : "—"}</dd>
            </div>
            <div>
              <dt>Chains</dt>
              <dd>{chainIds.map((id) => chainById(id)!.short).join(", ") || "none"}</dd>
            </div>
            <div>
              <dt>Estate</dt>
              <dd className="mono">{estateAddr ? short(estateAddr, 8, 6) : "connect to derive"}</dd>
            </div>
          </dl>
          <p className="muted small">
            Heirs and shares are frozen once the vigil opens. Nobody can change who gets paid: not the agent, and not this app.
          </p>
        </aside>
      </div>
    </main>
  );
}
