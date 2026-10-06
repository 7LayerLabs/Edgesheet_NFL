"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Updated 3 min ago · Update now": re-pulls injuries and transactions and recomputes the game on demand (/api/refresh),
 * then redraws the page. The age is computed after mount so the server and client render the same first frame.
 */
export function UpdateNow({ id, asOf }: { id: string; asOf: string }) {
  const router = useRouter();
  const [now, setNow] = useState<number | undefined>();
  const [state, setState] = useState<"idle" | "busy" | "wait">("idle");

  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const mins = now === undefined ? undefined : Math.max(0, Math.round((now - Date.parse(asOf)) / 60_000));
  const age = mins === undefined ? "" : mins === 0 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} hr ago`;

  const update = async () => {
    setState("busy");
    const res = await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => undefined);
    if (res?.status === 429) {
      setState("wait");
      setTimeout(() => setState("idle"), 5000);
      return;
    }
    router.refresh();
    setTimeout(() => setState("idle"), 1500);
  };

  return (
    <span className="text-xs text-chalk-3">
      {age && <>Updated {age} · </>}
      <button type="button" onClick={update} disabled={state === "busy"} className="font-semibold text-sky hover:underline disabled:opacity-60">
        {state === "busy" ? "Updating…" : state === "wait" ? "Just updated, try again in a moment" : "Update now"}
      </button>
    </span>
  );
}
