import { fourthDownsFor, fourthMethodNote, type FourthDown } from "@/lib/fourth";

const fmt = (x?: number) => (x === undefined ? "n/a" : `${x}%`);

/**
 * Fourth-down decisions for a live or final game: each call next to the model's, with the win probability of each
 * option and what the call cost. Server component; renders nothing until nflverse posts the game's play-by-play.
 */
export function FourthDowns({ gameId }: { gameId: string }) {
  const rows = fourthDownsFor(gameId);
  if (!rows.length) return null;
  const teams = [...new Set(rows.map((r) => r.team))];
  const note = fourthMethodNote();
  return (
    <div className="mt-3">
      <div className="grid gap-2.5 md:grid-cols-2">
        {teams.map((t) => {
          const mine = rows.filter((r) => r.team === t);
          const given = Math.round(mine.reduce((a, r) => a + r.cost, 0) * 10) / 10;
          const costly = mine.filter((r) => r.cost >= 3).length;
          return (
            <div key={t} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="display text-2xl font-bold text-chalk">{t}</span>
                <span className="mono text-xs text-chalk-3">
                  {mine.length} fourth {mine.length === 1 ? "down" : "downs"} · {given > 0 ? `${given} pts of win probability given up` : "no win probability given up"}
                  {costly ? ` · ${costly} costly` : ""}
                </span>
              </div>
              <ul className="mt-2 divide-y divide-line">
                {mine.map((r) => (
                  <Row key={r.playId} r={r} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-2 max-w-3xl text-xs leading-relaxed text-chalk-3">
        Each option scored as the win probability after the play: go for it (the conversion chance, then a first down or a turnover on downs at the spot), a field goal (make chance by distance, from 63 yards in), or a punt (the average start for the other team from that spot). Cost is the best option minus the call made; under 1.5 points between the top two is a toss-up. Penalties, kneels, overtime, and decided games are left out. {note ?? ""}
      </p>
    </div>
  );
}

function Row({ r }: { r: FourthDown }) {
  const ranked = (Object.entries(r.wp).filter(([, v]) => v !== undefined) as [string, number][]).sort((a, b) => b[1] - a[1]);
  const clearRight = r.call === r.modelCall && !r.tossUp && ranked.length > 1 && ranked[0][1] - ranked[1][1] >= 3;
  const tag = r.cost >= 3 ? { text: `cost ${r.cost} pts`, cls: "bg-brick text-white" } : clearRight ? { text: "right call", cls: "bg-turf text-white" } : r.tossUp ? { text: "toss-up", cls: "bg-ink-2 text-chalk-2" } : r.call === r.modelCall ? { text: "model agrees", cls: "bg-ink-2 text-chalk-2" } : { text: `cost ${r.cost} pts`, cls: "bg-warn text-chalk" };
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tag.cls}`}>{tag.text}</span>
        <span className="text-sm text-chalk">{r.situation}</span>
      </div>
      <p className="mt-0.5 text-sm text-chalk-2">
        They chose to {r.callWord} ({r.result}).{r.call !== r.modelCall ? ` The model says ${r.modelWord}.` : ""}
      </p>
      <p className="mono mt-0.5 text-xs text-chalk-3">
        win probability: go {fmt(r.wp.go)} ({r.pConvert}% to convert){r.wp.kick !== undefined ? ` · kick ${fmt(r.wp.kick)} (${r.pMake}% to make)` : ""}
        {r.wp.punt !== undefined ? ` · punt ${fmt(r.wp.punt)}` : ""}
      </p>
    </li>
  );
}
