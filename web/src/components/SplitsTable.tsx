import type { SplitRow } from "@/lib/splits";

const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;

/**
 * Situational splits since 2019: the situation's average against every other game (the other side of the split), each
 * with its games count. "diff" rows are differences (DK against his own average, points against the line); "level"
 * rows are plain averages (a defense's DK points a game). Rows matching this week's game are marked.
 */
export function SplitsTable({ rows, mode, unit }: { rows: SplitRow[]; mode: "diff" | "level"; unit: string }) {
  const shown = rows.filter((r) => r.n > 0);
  if (!shown.length) return <p className="text-sm text-chalk-3">No games since 2019 to split.</p>;
  const fmt = (x: number | null) => (x === null ? "–" : mode === "diff" ? signed(x) : x.toFixed(1));
  const tone = (x: number | null) => (x === null || mode === "level" ? "text-chalk" : x >= 1.5 ? "text-turf" : x <= -1.5 ? "text-brick" : "text-chalk");
  return (
    <div>
      <p className="mono text-[11px] text-chalk-3">{unit}</p>
      <ul className="mt-1 divide-y divide-line">
        {shown.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5 text-sm">
            <span className="min-w-0 text-chalk-2">
              {r.label}
              {r.now && <span className="ml-2 rounded bg-ink-2 px-1.5 py-0.5 text-[11px] font-semibold text-chalk">this week</span>}
            </span>
            <span className="mono text-right">
              <span className={`font-semibold ${tone(r.mean)}`}>{fmt(r.mean)}</span>
              <span className="text-xs text-chalk-3"> ({r.n})</span>
              <span className="ml-2 text-xs text-chalk-3">
                other {fmt(r.rest)} ({r.restN})
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
