"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the server-rendered page on an interval while a game is live.
 * Pauses when the tab is hidden. Renders a small "live, updating" indicator
 * so the reader knows the numbers move on their own.
 */
export function LivePoller({ active, intervalMs = 60_000, label = "live, updating" }: { active: boolean; intervalMs?: number; label?: string }) {
  const router = useRouter();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refresh();
      setTick((t) => t + 1);
    }, intervalMs);
    // Coming back to the tab refreshes once, unless the last refresh was under 30 seconds ago.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= 30_000) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs, router]);

  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-turf" title={`Refreshes every ${Math.round(intervalMs / 1000)} seconds${tick ? `, ${tick} so far` : ""}`}>
      <span className="live-dot" />
      {label}
    </span>
  );
}
