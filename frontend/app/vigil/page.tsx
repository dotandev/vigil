"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { VigilView } from "@/components/VigilView";
import { DEMO_OWNER } from "@/lib/config";

function Inner() {
  const owner = useSearchParams().get("owner") ?? DEMO_OWNER;
  return <VigilView owner={owner} />;
}

export default function VigilPage() {
  return (
    <main className="page">
      <Suspense fallback={null}>
        <Inner />
      </Suspense>
    </main>
  );
}
