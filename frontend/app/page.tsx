import Link from "next/link";
import { NetworkStats } from "@/components/NetworkStats";
import { DEMO_OWNER, REPO } from "@/lib/config";

const STEPS = [
  {
    n: "01",
    title: "Name your heirs",
    body: "Who inherits, at which address, in what share. Frozen at opening: nobody, including the agent, can redirect a payment later.",
  },
  {
    n: "02",
    title: "Endow a watchman",
    body: "An agent watches for your check-ins and pays rent every second from its endowment. Anyone can feed it; it can earn its own keep.",
  },
  {
    n: "03",
    title: "Live, or don't",
    body: "Check in whenever you like. Go silent past the grace period and the estate settles to your heirs, signed by NEAR's MPC network.",
  },
];

const CHECKS = [
  ["Recipient", "must match the plan committed when silence was declared"],
  ["Amount", "must match the plan exactly, to the wei"],
  ["Chain", "must match the slot being settled"],
  ["Gas price", "must be under the cap the owner set"],
  ["Calldata", "must be empty: a settlement is a plain transfer, never a contract call"],
];

const FAQ = [
  [
    "Who holds the key to my estate?",
    "Nobody. The address is NEAR's MPC root key tweaked by this contract and a path namespaced to your account. Signing needs a threshold of NEAR validators, and they answer only this contract.",
  ],
  [
    "What if I'm alive but offline for a while?",
    "That is what the grace period is for, and it should be weeks, not minutes. Even after silence is declared, checking in discards the plan until the last signature lands.",
  ],
  [
    "What if nobody pays for the agent?",
    "It starves, publicly. A dead agent cannot distribute anything, even if you are provably silent. Your estate stays yours, and only you can revive the watch.",
  ],
  [
    "Can a compromised agent steal?",
    "No. It can delay a settlement or under-report a balance, which strands funds at a keyless address for a replacement agent to settle. It cannot move one wei to an address you did not name.",
  ],
];

export default function Landing() {
  return (
    <main className="page landing">
      <section className="hero">
        <span className="eyebrow">Keyless crypto inheritance on NEAR</span>
        <h1>
          A watchman that is paid by what it guards, <em>and dies when you do.</em>
        </h1>
        <p className="lede">
          No seed phrase in a drawer. No guardian committee voting on whether you are alive. Your estate sits at an address with no private key, and
          the only thing that can move it is your own silence.
        </p>
        <div className="cta">
          <Link className="btn btn-warm btn-lg" href="/new">
            Open a vigil
          </Link>
          <Link className="btn btn-lg" href={`/vigil?owner=${DEMO_OWNER}`}>
            Watch a live one
          </Link>
        </div>
        <NetworkStats />
      </section>

      <section className="section">
        <h2 className="section-title">How it works</h2>
        <div className="steps">
          {STEPS.map((s) => (
            <article className="step" key={s.n}>
              <span className="step-n mono">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Two ways for a watchman to die</h2>
        <p className="section-lede">The difference between them is the whole design.</p>
        <div className="contrast">
          <div>
            <h3>Starved</h3>
            <p>
              The agent ran out of money first. Nothing is distributed, the estate is untouched and still yours, and the lapse is announced publicly
              so your heirs learn the watch stopped instead of discovering it years later.
            </p>
          </div>
          <div>
            <h3>Fulfilled</h3>
            <p>
              You went silent past the grace period. The estate goes to the heirs you named, in amounts fixed when silence was declared, and the
              watchman&apos;s last act is its purpose.
            </p>
          </div>
        </div>
      </section>

      <section className="section split">
        <div>
          <h2 className="section-title">The contract never signs a hash it was handed</h2>
          <p className="section-lede">
            The agent submits transaction fields. The contract re-encodes them as EIP-1559 itself and asks the MPC network to sign the digest it
            computed, and only after these checks pass.
          </p>
        </div>
        <ul className="checks">
          {CHECKS.map(([k, v]) => (
            <li key={k}>
              <span className="check-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>{k}</strong> <span className="muted">{v}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="section-title">Questions</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="section final-cta">
        <h2>Leave something behind without leaving a key behind.</h2>
        <div className="cta">
          <Link className="btn btn-warm btn-lg" href="/new">
            Open a vigil
          </Link>
          <a className="btn btn-lg" href={REPO} target="_blank" rel="noreferrer">
            Read the code
          </a>
        </div>
      </section>
    </main>
  );
}
