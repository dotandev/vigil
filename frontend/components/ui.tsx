"use client";

import { useEffect, useRef, useState } from "react";
import { toneOf } from "@/lib/format";

export const Pill = ({ state, label }: { state: string; label?: string }) => (
  <span className="pill" data-tone={toneOf(state)}>
    {label ?? state}
  </span>
);

export function Bar({ frac, tone, label }: { frac: number; tone?: string; label: string }) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
      <div className="bar-fill" data-tone={tone} style={{ transform: `scaleX(${f})` }} />
    </div>
  );
}

/** Re-render the caller ~10x a second so countdowns move between polls. */
export function useTick(ms = 100) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => !document.hidden && set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked: the value is visible on screen anyway */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Skeleton({ h = 18, w = "100%" }: { h?: number; w?: number | string }) {
  return <span className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

/** A confirm dialog on the native <dialog> element: focus trap and Esc for free. */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <h3>{title}</h3>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? "btn btn-danger" : "btn btn-warm"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="flame flame-lg" aria-hidden="true" />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
