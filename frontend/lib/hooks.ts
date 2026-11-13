"use client";

import { useCallback, useEffect, useState } from "react";
import { activity, listOwners, snapshot, statuses, type ActivityItem, type Snapshot, type Status } from "./chain";
import { CONTRACT } from "./config";
import { useWallet } from "@/components/providers";

/** Poll one vigil. Refetches immediately after any transaction the user sends. */
export function useVigil(owner: string | null, pollMs = 3000) {
  const { nonce } = useWallet();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!owner) return;
    try {
      setSnap(await snapshot(CONTRACT, owner));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    setSnap(null);
    setLoading(!!owner);
    if (!owner) return;
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [owner, load, pollMs]);

  useEffect(() => {
    if (nonce) {
      // The chain needs a moment to finalise; read now and again shortly.
      load();
      const t = setTimeout(load, 2500);
      return () => clearTimeout(t);
    }
  }, [nonce, load]);

  return { snap, error, loading, reload: load };
}

/** Every vigil on the contract with its status. */
export function useAllVigils(pollMs = 15000) {
  const { nonce } = useWallet();
  const [rows, setRows] = useState<Status[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const owners = await listOwners(CONTRACT);
        const s = await statuses(CONTRACT, owners);
        if (live) {
          setRows(s);
          setError(null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollMs, nonce]);

  return { rows, error };
}

export function useActivity(pollMs = 15000) {
  const { nonce } = useWallet();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      activity(CONTRACT)
        .then((a) => live && setItems(a))
        .catch(() => live && setItems((x) => x ?? []));
    load();
    const id = setInterval(load, pollMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollMs, nonce]);
  return items;
}
