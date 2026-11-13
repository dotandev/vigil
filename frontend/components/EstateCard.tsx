"use client";

import { useEffect, useState } from "react";
import { evmBalance, signerDerivedKey, type ChainSlot, type Estate } from "@/lib/chain";
import { chainById, CONTRACT, MPC_SIGNER } from "@/lib/config";
import { addressFromNearKey, deriveEvmAddress } from "@/lib/derive";
import { chainName, eth, evmExplorer, short } from "@/lib/format";
import { ethToWei, explainEvm, fundEstate, hasEvmWallet } from "@/lib/evm-wallet";
import { CopyButton, Skeleton } from "./ui";
import { useToast } from "./providers";

function useBalance(chainId: number, address: string) {
  const [wei, setWei] = useState<bigint | null | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const chain = chainById(chainId);
    if (!chain) return setWei(null);
    let live = true;
    const load = () => evmBalance(chain.rpc, address).then((b) => live && setWei(b));
    load();
    const id = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [chainId, address, nonce]);
  return { wei, refresh: () => setNonce((n) => n + 1) };
}

type Check = { state: "idle" | "checking" | "ok" | "bad" | "error"; detail?: string };

/** Three independent answers to "whose address is this?" that must agree. */
function KeylessCheck({ slot }: { slot: ChainSlot }) {
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const run = async () => {
    setCheck({ state: "checking" });
    try {
      const fromSigner = addressFromNearKey(await signerDerivedKey(MPC_SIGNER, CONTRACT, slot.derivation_path));
      const fromBrowser = deriveEvmAddress(CONTRACT, slot.derivation_path);
      const stored = slot.address.toLowerCase();
      const ok = fromSigner === stored && fromBrowser === stored;
      setCheck({
        state: ok ? "ok" : "bad",
        detail: ok
          ? `${MPC_SIGNER} confirms it signs for this address only when ${CONTRACT} asks.`
          : `Signer says ${fromSigner}, this browser derives ${fromBrowser}, the contract stores ${stored}.`,
      });
    } catch (e) {
      setCheck({ state: "error", detail: (e as Error).message });
    }
  };
  return (
    <div className="keyless">
      <button type="button" className="btn btn-ghost btn-sm" onClick={run} disabled={check.state === "checking"}>
        {check.state === "checking" ? "Asking the MPC signer…" : check.state === "ok" ? "Verified keyless ✓" : "Verify keyless"}
      </button>
      {check.detail && (
        <span className="small" data-tone={check.state === "ok" ? "good" : "bad"}>
          {check.detail}
        </span>
      )}
    </div>
  );
}

function Fund({ slot, onSent }: { slot: ChainSlot; onSent: () => void }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("0.01");
  const [sending, setSending] = useState(false);
  const chain = chainById(slot.chain.Evm.chain_id);
  if (!chain) return null;

  const send = async () => {
    setSending(true);
    try {
      const hash = await fundEstate(chain, slot.address, ethToWei(amt));
      push({ tone: "good", title: `Sent ${amt} ETH to the estate`, href: `${chain.explorer}/tx/${hash}` });
      setOpen(false);
      setTimeout(onSent, 4000);
    } catch (e) {
      push({ tone: "bad", title: "Funding failed", body: explainEvm(e) }, 10000);
    } finally {
      setSending(false);
    }
  };

  if (!open)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Fund
      </button>
    );
  return (
    <div className="fund">
      {hasEvmWallet() ? (
        <>
          <div className="input-group">
            <input className="amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount of ETH" />
            <span className="unit">ETH</span>
          </div>
          <button type="button" className="btn btn-warm btn-sm" onClick={send} disabled={sending}>
            {sending ? "Confirm in wallet…" : "Send"}
          </button>
        </>
      ) : (
        <span className="muted small">No Ethereum wallet detected. Send test ETH to the address above from any wallet.</span>
      )}
      <a className="link small" href={chain.faucet} target="_blank" rel="noreferrer">
        Get {chain.short} test ETH ↗
      </a>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function Slot({ slot }: { slot: ChainSlot }) {
  const chainId = slot.chain.Evm.chain_id;
  const { wei, refresh } = useBalance(chainId, slot.address);
  return (
    <div className="slot">
      <div className="slot-top">
        <span className="slot-chain">{chainName(chainId)}</span>
        <span className="slot-bal mono">{wei === undefined ? <Skeleton w={90} /> : wei === null ? "—" : `${eth(wei.toString())} ETH`}</span>
      </div>
      <div className="slot-addr">
        <a className="mono addr" href={evmExplorer(chainId, slot.address)} target="_blank" rel="noreferrer">
          {slot.address}
        </a>
        <CopyButton value={slot.address} />
        <Fund slot={slot} onSent={refresh} />
      </div>
      <p className="muted small">
        No private key exists for this address. It is NEAR&apos;s MPC root key tweaked by (<code>{CONTRACT}</code>,{" "}
        <code>{slot.derivation_path}</code>).
      </p>
      <KeylessCheck slot={slot} />
    </div>
  );
}

export function EstateCard({ estate }: { estate: Estate }) {
  return (
    <article className="card">
      <header className="card-head">
        <h2>The estate</h2>
        <span className="muted small">
          {estate.slots.length} chain{estate.slots.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="slots">
        {estate.slots.map((s) => (
          <Slot slot={s} key={s.derivation_path} />
        ))}
      </div>
      <h3 className="sub">Heirs</h3>
      <ul className="heirs">
        {estate.heirs.map((h, i) => (
          <li key={`${h.label}-${i}`}>
            <span className="heir-name">{h.label}</span>
            <span className="heir-addrs">
              {h.evm_address && <span className="mono muted">{short(h.evm_address, 8, 6)}</span>}
              {h.near_account && <span className="mono muted">{h.near_account}</span>}
            </span>
            <span className="share">
              <span className="share-bar" style={{ "--w": `${h.basis_points / 100}%` } as React.CSSProperties} />
              {(h.basis_points / 100).toFixed(h.basis_points % 100 ? 2 : 0)}%
            </span>
          </li>
        ))}
      </ul>
      {estate.yield_source && (
        <p className="muted small">
          Earns its keep from <code>{estate.yield_source}</code>.
        </p>
      )}
    </article>
  );
}
