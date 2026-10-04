import type { Coverage, GameStatus } from "@/lib/types";

export function CoverageBadge({ level }: { level: Coverage }) {
  const tone =
    level === "Full" ? "border-turf/40 bg-turf/10 text-turf" : level === "Standard" ? "border-sky/40 bg-sky/10 text-sky" : "border-line bg-ink-2 text-chalk-3";
  return (
    <span className={`mono inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}>
      <span aria-hidden>{level === "Full" ? "●●●" : level === "Standard" ? "●●○" : "●○○"}</span>
      {level}
    </span>
  );
}

export function StatusPill({ status, clock }: { status: GameStatus; clock?: string }) {
  if (status === "live")
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-turf">
        <span className="live-dot" /> Live · {clock}
      </span>
    );
  if (status === "final") return <span className="rounded bg-brick px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">Final</span>;
  return null;
}

export function DivisionTag({ d }: { d: string }) {
  return <span className="mono rounded border border-line bg-ink-2 px-1.5 py-0.5 text-[10px] tracking-wider text-chalk-2">{d}</span>;
}

export function Tier({ tier }: { tier: string }) {
  const tone: Record<string, string> = {
    Matchup: "bg-[#e8415b] text-white",
    Rookie: "bg-navy text-white",
    Breakout: "bg-turf text-white",
    Watch: "bg-ink-2 text-chalk-2",
  };
  const label: Record<string, string> = { Matchup: "On the spot", Rookie: "Rookie", Breakout: "Breakout", Watch: "Watch" };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone[tier] ?? "bg-panel-2 text-chalk-3"}`}>{label[tier] ?? tier}</span>;
}

export function Confidence({ level }: { level: "High" | "Medium" | "Low" }) {
  const dots = level === "High" ? "●●●" : level === "Medium" ? "●●○" : "●○○";
  return (
    <span className="mono text-[10px] text-chalk-3" title={`${level} confidence`}>
      {dots} {level}
    </span>
  );
}
