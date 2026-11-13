"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { EXPLORER } from "@/lib/chain";

type WalletModule = typeof import("@/lib/wallet");
const loadWallet = () => import("@/lib/wallet");

// -------------------------------------------------------------------- toasts

export type Toast = {
  id: number;
  tone: "info" | "good" | "bad" | "pending";
  title: string;
  body?: string;
  href?: string;
};

const ToastCtx = createContext<{
  push: (t: Omit<Toast, "id">, ms?: number) => number;
  dismiss: (id: number) => void;
}>({ push: () => 0, dismiss: () => {} });

export const useToast = () => useContext(ToastCtx);

function Toaster({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <span className="toast-mark" aria-hidden="true" />
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body && <p>{t.body}</p>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer">
                View transaction ↗
              </a>
            )}
          </div>
          <button className="toast-x" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- wallet

type Run = (
  label: string,
  fn: (w: WalletModule) => Promise<{ hash: string | null }>,
  success?: string,
) => Promise<boolean>;

const WalletCtx = createContext<{
  account: string | null;
  ready: boolean;
  connect: () => void;
  disconnect: () => void;
  run: Run;
  busy: string | null;
  /** Bumped after every successful transaction, so views can refetch. */
  nonce: number;
}>({
  account: null,
  ready: false,
  connect: () => {},
  disconnect: () => {},
  run: async () => false,
  busy: null,
  nonce: 0,
});

export const useWallet = () => useContext(WalletCtx);

export function Providers({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">, ms = 7000) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss],
  );

  const [account, setAccount] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let off: (() => void) | undefined;
    loadWallet()
      .then((w) => w.initWallet(setAccount))
      .then((u) => {
        off = u;
        setReady(true);
      })
      .catch((e) => {
        console.warn("wallet selector unavailable", e);
        setReady(true);
      });

    // Redirect wallets come back with the hash in the URL.
    const url = new URL(window.location.href);
    const hashes = url.searchParams.get("transactionHashes");
    const err = url.searchParams.get("errorCode");
    if (hashes || err) {
      if (hashes) {
        const last = hashes.split(",").at(-1)!;
        push({ tone: "good", title: "Transaction confirmed", href: `${EXPLORER}/txns/${last}` });
      } else {
        push({ tone: "bad", title: "Transaction not sent", body: url.searchParams.get("errorMessage") ?? err ?? "" });
      }
      ["transactionHashes", "errorCode", "errorMessage"].forEach((k) => url.searchParams.delete(k));
      window.history.replaceState(null, "", url);
    }
    return () => off?.();
  }, [push]);

  const connect = useCallback(() => {
    loadWallet().then((w) => w.showConnect());
  }, []);
  const disconnect = useCallback(() => {
    loadWallet().then((w) => w.signOut());
  }, []);

  const run: Run = useCallback(
    async (label, fn, success) => {
      const w = await loadWallet();
      setBusy(label);
      const pending = push({ tone: "pending", title: label, body: "Confirm in your wallet…" }, 0);
      try {
        const { hash } = await fn(w);
        dismiss(pending);
        push({
          tone: "good",
          title: success ?? `${label}: done`,
          href: hash ? `${EXPLORER}/txns/${hash}` : undefined,
        });
        setNonce((n) => n + 1);
        return true;
      } catch (e) {
        dismiss(pending);
        if (!(e instanceof w.NeedsWallet)) push({ tone: "bad", title: `${label} failed`, body: w.explain(e) }, 10000);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [push, dismiss],
  );

  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      <WalletCtx.Provider value={{ account, ready, connect, disconnect, run, busy, nonce }}>
        {children}
        <Toaster toasts={toasts} dismiss={dismiss} />
      </WalletCtx.Provider>
    </ToastCtx.Provider>
  );
}
