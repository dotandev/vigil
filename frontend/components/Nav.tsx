"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "./providers";
import { short } from "@/lib/format";
import { CONTRACT, REPO } from "@/lib/config";

const LINKS = [
  { href: "/explore", label: "Explore" },
  { href: "/dashboard", label: "My vigil" },
  { href: "/new", label: "Open a vigil" },
];

export function Nav() {
  const path = usePathname();
  const { account, ready, connect, disconnect } = useWallet();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  return (
    <header className="top">
      <Link className="brand" href="/">
        <span className="flame" aria-hidden="true" />
        Vigil
        <span className="net">testnet</span>
      </Link>
      <nav className="nav-links" aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="nav-link" aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="top-actions" ref={ref}>
        <a className="link hide-sm" href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
        {account ? (
          <div className="account">
            <button className="btn btn-ghost account-btn" type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
              <span className="avatar" aria-hidden="true">
                {account.slice(0, 1).toUpperCase()}
              </span>
              {short(account, 16, 0)}
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <span className="muted small">Signed in as</span>
                  <span className="mono small">{account}</span>
                </div>
                <Link role="menuitem" href="/dashboard" onClick={() => setMenu(false)}>
                  My vigil
                </Link>
                <a role="menuitem" href={`https://testnet.nearblocks.io/address/${account}`} target="_blank" rel="noreferrer">
                  Account on explorer ↗
                </a>
                <a role="menuitem" href={`https://testnet.nearblocks.io/address/${CONTRACT}`} target="_blank" rel="noreferrer">
                  Contract on explorer ↗
                </a>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    disconnect();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="btn btn-warm" type="button" onClick={connect} disabled={!ready}>
            {ready ? "Connect wallet" : "Loading…"}
          </button>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <span>
        Vigil · NEAR testnet · contract <code>{CONTRACT}</code> · chain signatures via <code>v1.signer-prod.testnet</code>
      </span>
      <span>
        <a className="link" href={REPO} target="_blank" rel="noreferrer">
          Source
        </a>{" "}
        · MIT
      </span>
    </footer>
  );
}
