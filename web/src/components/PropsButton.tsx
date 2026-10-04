"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** Pulls player props for one game on demand. Costs 6 Odds API credits, so it is never automatic. */
export function PropsButton({ id, hasProps }: { id: string; hasProps: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const go = () =>
    start(async () => {
      setMsg(null);
      const res = await fetch("/api/odds/props", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(body.message ?? (res.ok ? "Done." : "Could not fetch props."));
      if (res.ok) router.refresh();
    });

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className="rounded border border-navy bg-white px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-navy hover:text-white disabled:opacity-60"
      >
        {pending ? "Fetching props" : hasProps ? "Refresh player props (6 credits)" : "Fetch player props (6 credits)"}
      </button>
      {msg && <span className="text-xs text-chalk-3">{msg}</span>}
    </span>
  );
}
