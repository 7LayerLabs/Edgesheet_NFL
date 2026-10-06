import { Fragment } from "react";
import type { TrendNote, TrendRow, TrendWeek } from "@/lib/trends";

const pct = (x: number | undefined) => (x === undefined ? "" : `${Math.round(x * 100)}%`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A player's season week by week with his team (src/lib/trends.ts): snap share, targets and target share (attempts for a
 * quarterback), carries and carry share, air yards share, DK points, and the reason under each big change.
 */
export function PlayerWeeks({ weeks, heads, row, notes, qb }: { weeks: TrendWeek[]; heads: string[]; row: TrendRow; notes: TrendNote[]; qb: boolean }) {
  const noteFor = new Map(notes.map((n) => [n.wk, n]));
  // A carries column only for a player with a carry this season; the cell count follows it.
  const carries = row.cells.some((c) => c.status === "played" && (c.ra ?? 0) > 0);
  const cols = 4 + (carries ? 1 : 0) + (qb ? 0 : 1); // week, snaps, targets or attempts, DK, plus carries and air yards
  return (
    <div className="card scroll-x mt-2 px-3 py-1">
      <table className="min-w-max border-collapse text-sm">
        <thead>
          <tr className="mono text-left text-xs text-chalk-3">
            <th className="py-1 pr-3 font-normal">Week</th>
            <th className="px-2 py-1 font-normal">Snaps</th>
            <th className="px-2 py-1 font-normal">{qb ? "Attempts" : "Targets"}</th>
            {carries && <th className="px-2 py-1 font-normal">Carries</th>}
            {!qb && <th className="px-2 py-1 font-normal">Air yards</th>}
            <th className="px-2 py-1 font-normal">DK</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => {
            const c = row.cells[i];
            const n = noteFor.get(w.wk);
            if (c.status === "none") return null;
            const result = w.margin === null ? "" : w.margin > 0 ? ` W ${w.margin}` : w.margin < 0 ? ` L ${-w.margin}` : " T";
            return (
              <Fragment key={w.g}>
                <tr className={`border-t border-line ${n ? (n.to > n.from ? "bg-turf/10" : "bg-brick/10") : ""}`}>
                  <td className="mono py-1.5 pr-3 text-xs text-chalk-2">
                    {heads[i]}
                    <span className="text-chalk-3">{result}</span>
                  </td>
                  {c.status === "out" ? (
                    <td colSpan={cols - 1} className="px-2 py-1.5 text-chalk-3">
                      {c.moved ? `with the ${c.moved}` : "did not play"}
                      {c.listed && !c.moved ? ` (listed ${c.listed.toLowerCase()})` : ""}
                    </td>
                  ) : (
                    <>
                      <td className="mono px-2 py-1.5">{c.snaps === undefined ? <span className="text-chalk-3">n/a</span> : pct(c.snaps)}</td>
                      <td className="mono px-2 py-1.5">
                        {qb ? c.pa ?? 0 : c.tgt ?? 0}
                        {!qb && c.tshare ? <span className="text-chalk-3"> {pct(c.tshare)}</span> : null}
                      </td>
                      {carries && (
                        <td className="mono px-2 py-1.5">
                          {c.ra ?? 0}
                          {c.rshare ? <span className="text-chalk-3"> {pct(c.rshare)}</span> : null}
                        </td>
                      )}
                      {!qb && <td className="mono px-2 py-1.5">{c.air ? pct(c.air) : <span className="text-chalk-3">0%</span>}</td>}
                      <td className="mono px-2 py-1.5 font-semibold text-chalk">{(c.dk ?? 0).toFixed(1)}</td>
                    </>
                  )}
                </tr>
                {n && (
                  <tr className={n.to > n.from ? "bg-turf/10" : "bg-brick/10"}>
                    <td colSpan={cols} className="pb-1.5 pr-3 text-xs text-chalk-2">
                      <span className={n.to > n.from ? "text-turf" : "text-brick"}>
                        {n.metric === "snaps" ? "Snaps" : n.metric === "targets" ? "Target share" : "Carry share"} {pct(n.from)} to {pct(n.to)}
                      </span>
                      . {sentence(n.reason)}.
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {weeks.some((w, i) => !w.snapsPosted && row.cells[i].status === "played") && <p className="mb-1 mt-1 text-xs text-chalk-3">n/a: snap counts not posted yet for that week.</p>}
    </div>
  );
}
