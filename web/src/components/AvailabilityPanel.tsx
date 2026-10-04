import type { GameAvailability, TeamAvailability } from "@/lib/availability";
import type { Game, Team } from "@/lib/types";

const signed = (n: number) => (n > 0 ? `+${n}` : n === 0 ? "0" : String(n));
const tone = (n: number) => (n <= -1 ? "text-brick" : n >= 1 ? "text-turf" : "text-chalk-2");
const KIND: Record<string, string> = { out: "", left: "Left", arrived: "New", qb: "QB" };

/**
 * Who is playing, and what it is worth: the expected quarterback against the ones whose snaps built
 * the team's numbers, every starter out or doubtful, players traded away or signed, and the last
 * week of roster moves. The projection above already includes these points.
 */
export function AvailabilityPanel({ game, a }: { game: Game; a: GameAvailability }) {
  const sides: [Team, TeamAvailability][] = [
    [game.away, a.away],
    [game.home, a.home],
  ];
  const net = Math.round((a.home.total - a.away.total) * 10) / 10;
  return (
    <div className="mt-3">
      <p className="max-w-3xl text-sm text-chalk-2">
        {net === 0
          ? "Nothing on either injury list moves the margin."
          : `Net ${Math.abs(net)} points to the ${net > 0 ? game.home.short : game.away.short} once the lineups are priced in. The projection above already includes it.`}
      </p>
      <div className="mt-3 grid gap-2.5 md:grid-cols-2">
        {sides.map(([t, av]) => (
          <div key={t.id} className="card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-block h-4 w-1 rounded-sm" style={{ background: t.color }} />
                <span className="display text-2xl font-bold">{t.short}</span>
              </div>
              <span className={`mono text-lg font-semibold ${tone(av.total)}`}>{signed(av.total)} pts</span>
            </div>
            <p className="mono mt-0.5 text-xs text-chalk-3">
              offense {signed(av.offense)} · defense {signed(av.defense)}
            </p>

            {av.qb && (
              <div className="mt-3 rounded border border-line bg-panel-2 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm">
                    <span className="eyebrow mr-2">QB</span>
                    <span className="font-semibold text-chalk">{av.qb.expected}</span>
                    {av.qb.uncertain && <span className="mono ml-2 text-xs font-semibold text-warn">questionable</span>}
                  </span>
                  <span className={`mono text-sm font-semibold ${tone(av.qb.pts)}`}>{signed(av.qb.pts)}</span>
                </div>
                <p className="mt-0.5 text-xs leading-snug text-chalk-3">{av.qb.note}</p>
              </div>
            )}

            <ul className="mt-2 divide-y divide-line">
              {av.items
                .filter((i) => i.kind !== "qb")
                .map((i) => (
                  <li key={`${i.kind}-${i.id}`} className="py-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${i.kind === "arrived" ? "bg-turf text-white" : i.absence >= 0.85 ? "bg-brick text-white" : "bg-warn text-chalk"}`}>{KIND[i.kind] || i.status}</span>
                      <span className="font-medium text-chalk">{i.name}</span>
                      <span className="mono text-xs text-chalk-3">
                        {i.pos}
                        {i.kind !== "out" ? ` · ${i.status}` : i.source ? ` · ${i.source}` : ""}
                        {!i.measured ? " · assumed value" : ""}
                      </span>
                      <span className={`mono ml-auto text-sm font-semibold ${tone(i.pts)}`}>{signed(i.pts)}</span>
                    </div>
                    <p className="text-xs leading-snug text-chalk-3">{i.note}</p>
                  </li>
                ))}
              {av.items.filter((i) => i.kind !== "qb").length === 0 && <li className="py-1.5 text-sm text-chalk-3">No starter out, doubtful, traded, or newly signed.</li>}
            </ul>

            {av.moves.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-chalk-2">Roster moves, latest first</summary>
                <ul className="mt-1 grid gap-1">
                  {av.moves.map((m, idx) => (
                    <li key={idx} className="text-xs text-chalk-2">
                      <span className="mono text-chalk-3">{m.date.slice(5, 10)}</span> {m.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-chalk-3">
        Sources: {a.sources.join(", ")}. QB: expected starter's EPA a play (this season plus half of last, shrunk toward replacement) against the QBs whose snaps built the team's numbers (this season and last), times QB plays a game, times 0.75 (backtest fit on 2022 to 2025). Skill players: EPA a touch or target above the 25th percentile at the position, half credit. Linemen and defenders: fixed starter values times snap share (assumed, not measured). Weighted by games played and the chance he sits (Questionable 25%, 50% with no practice on the final day).
        {a.notes.length ? ` ${a.notes.join(" ")}` : ""}
      </p>
    </div>
  );
}
