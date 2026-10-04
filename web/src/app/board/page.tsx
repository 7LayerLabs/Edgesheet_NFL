import Link from "next/link";
import { allGraded } from "@/lib/grades";
import { radarPlayer } from "@/lib/radar";
import { BoardClient, type BoardRow } from "./BoardClient";

export const dynamic = "force-dynamic";

/**
 * My board: every player Derek has graded, his score next to the radar score
 * and the draft forecast, with the gap called out. Filters, a blend slider,
 * and a CSV export live in the client table.
 */
export default function BoardPage() {
  const graded = allGraded();
  const rows: BoardRow[] = graded.map((g) => {
    const r = radarPlayer(g.id);
    const hint = g.grades.find((x) => x.name) ?? g.last;
    const radar = r?.score ?? null;
    return {
      id: g.id,
      name: r?.name ?? hint.name ?? `Player ${g.id}`,
      team: r?.team ?? hint.team ?? "",
      pos: r?.pos ?? hint.pos ?? "",
      group: r?.group ?? (hint.pos ?? "").toUpperCase() ?? "",
      cls: r?.cls ?? hint.cls ?? "",
      draftClass: r?.draftClass ?? null,
      games: g.grades.length,
      avgGrade: Math.round(g.avgGrade * 10) / 10,
      myScore: g.myScore,
      radar,
      tier: r?.tier ?? null,
      band: r?.vsSlot !== null && r?.vsSlot !== undefined ? (r.vsSlot >= 10 ? "Above slot" : r.vsSlot <= -10 ? "Below slot" : "On slot") : null,
      estPick: r?.eqPick ?? null,
      delta: radar === null ? null : g.myScore - radar,
      lastDate: g.last.date,
      notes: g.grades.map((x) => ({ date: x.date, gameId: x.gameId, grade: x.grade, note: x.note })),
    };
  });

  return (
    <div>
      <p className="eyebrow">My board</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">Your eyes vs the model</h1>
      <p className="mt-2 max-w-3xl text-base text-chalk-3">
        Every player you have graded, ranked by your average grade (1 star = 0, 5 stars = 100) next to the radar score and, for rookies and second-year players, the pick his production looks like.
        The delta is yours minus the model&apos;s. Grade players from any live or final game page, or from a player page.
      </p>

      {rows.length === 0 ? (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-3xl text-chalk">Nothing graded yet</p>
          <p className="mt-1 text-base text-chalk-3">
            Open a <Link href="/" className="text-sky">live or final game</Link> and tap the stars under a prospect, or grade from a <Link href="/radar" className="text-sky">player page</Link>.
          </p>
        </div>
      ) : (
        <BoardClient rows={rows} />
      )}
    </div>
  );
}
