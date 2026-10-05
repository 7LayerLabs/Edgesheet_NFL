import type { Game } from "@/lib/types";
import { asOf } from "@/lib/format";
import { WinBar } from "./LiveLine";

/**
 * Live and postgame detail from ESPN for the game page: situation and last
 * play, a win probability chart, scoring plays, and the drive chart. Renders
 * nothing when the game has no ESPN overlay yet, so the section's own
 * fallback text stays in charge.
 */
export function LivePanel({ game }: { game: Game }) {
  const l = game.live;
  const d = game.liveDetail;
  if (!l && !d) return null;
  const isLive = game.status === "live";
  const homeWp = d?.winProb.at(-1)?.home ?? l?.homeWinProb;
  const periods = Math.max(d?.home.linescores?.length ?? 0, d?.away.linescores?.length ?? 0);

  return (
    <div className="mt-3 grid grid-cols-1 gap-3">
      {/* Situation */}
      <div className={`card p-4 ${isLive ? "border-l-4 border-l-turf" : "border-l-4 border-l-brick"}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="display text-2xl font-bold text-chalk">
            {game.away.abbr} {game.score?.away ?? "–"} <span className="text-chalk-3">@</span> {game.home.abbr} {game.score?.home ?? "–"}
            <span className={`ml-3 text-base font-semibold ${isLive ? "text-turf" : "text-brick"}`}>{game.score?.clock ?? l?.clock}</span>
          </p>
          <span className="mono text-xs text-chalk-3">
            ESPN feed{l?.broadcast ? ` · ${l.broadcast}` : ""} · as of {asOf(d?.asOf ?? l!.asOf)}
          </span>
        </div>
        {periods > 0 && (
          <table className="mono mt-2 text-xs text-chalk-2">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-chalk-3">
                <th className="pr-3 text-left font-normal"></th>
                {Array.from({ length: periods }, (_, i) => (
                  <th key={i} className="w-8 text-right font-normal">{i < 4 ? `${i + 1}` : i === 4 ? "OT" : `${i - 3}OT`}</th>
                ))}
                <th className="w-10 text-right font-normal">T</th>
              </tr>
            </thead>
            <tbody>
              {[game.away, game.home].map((t, idx) => {
                const ls = idx === 0 ? d?.away.linescores : d?.home.linescores;
                const total = idx === 0 ? game.score?.away : game.score?.home;
                return (
                  <tr key={t.id}>
                    <td className="pr-3 text-chalk">{t.abbr}</td>
                    {Array.from({ length: periods }, (_, i) => (
                      <td key={i} className="text-right">{ls?.[i] ?? "–"}</td>
                    ))}
                    <td className="text-right font-medium text-chalk">{total ?? "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {isLive && (
          <div className="mt-3 grid gap-1 text-sm">
            <p className="text-chalk">
              <span className="eyebrow mr-2">Situation</span>
              {l?.possession ? `${l.possession} ball` : ""}
              {l?.downDistance ? `${l?.possession ? ", " : ""}${l.downDistance}` : l?.possession ? "" : "between plays"}
            </p>
            {l?.lastPlay && (
              <p className="text-chalk-2">
                <span className="eyebrow mr-2">Last play</span>
                {l.lastPlay}
              </p>
            )}
          </div>
        )}
        {homeWp !== undefined && (
          <div className="mt-3 flex items-center gap-3">
            <span className="mono w-16 text-right text-xs text-chalk">{game.home.abbr} {Math.round(homeWp * 100)}%</span>
            <WinBar home={homeWp} homeColor={game.home.color} awayColor={game.away.color} tall />
            <span className="mono w-16 text-xs text-chalk">{game.away.abbr} {Math.round((1 - homeWp) * 100)}%</span>
          </div>
        )}
        {l?.swing !== undefined && isLive && (
          <p className="mono mt-1 text-xs text-chalk-3">
            {game.home.abbr} win probability {l.swing >= 0 ? "up" : "down"} {Math.abs(Math.round(l.swing * 100))} points over the last {l.swingMinutes} min of readings.
          </p>
        )}
      </div>

      {d && d.winProb.length > 1 && <WinProbChart game={game} />}

      {/* Live, the scoring plays and drives are the feed; after the final they fold, so the box score sits close to the top. */}
      <Fold open={isLive} label="Scoring plays and drive chart">
        {d && d.scoringPlays.length > 0 && (
          <div className="card p-4">
            <p className="eyebrow">Scoring plays</p>
            <ul className="mt-2 grid gap-1.5">
              {d.scoringPlays.map((p, i) => (
                <li key={i} className="grid grid-cols-[3.5rem_3rem_1fr_4rem] items-baseline gap-2 text-sm">
                  <span className="mono text-[11px] text-chalk-3">{periodLabel(p.period)} {p.clock}</span>
                  <span className="mono text-xs font-medium" style={{ color: p.team === game.home.abbr ? game.home.color : game.away.color }}>{p.team}</span>
                  <span className="text-chalk-2">
                    <span className={`mr-1.5 rounded px-1 py-px text-[10px] font-bold uppercase tracking-wider ${p.type === "TD" ? "bg-turf text-white" : "bg-ink-2 text-chalk"}`}>{p.type}</span>
                    {p.text}
                  </span>
                  <span className="mono text-right text-xs text-chalk">{p.away}-{p.home}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {d && d.drives.length > 0 && <DriveChart game={game} />}
      </Fold>
    </div>
  );
}

const periodLabel = (n: number) => (n <= 4 ? `Q${n}` : n === 5 ? "OT" : `${n - 4}OT`);

/** Inline SVG, light theme. Home win probability over game time with quarter lines and scoring plays marked. */
function WinProbChart({ game }: { game: Game }) {
  const d = game.liveDetail!;
  const W = 640;
  const H = 180;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const lastX = d.winProb[d.winProb.length - 1].x;
  const maxX = Math.max(3600, lastX);
  const sx = (x: number) => padL + (x / maxX) * (W - padL - padR);
  const sy = (p: number) => padT + (1 - p) * (H - padT - padB);
  const pts = d.winProb.map((r) => `${sx(r.x).toFixed(1)},${sy(r.home).toFixed(1)}`).join(" ");
  const mid = sy(0.5);
  // Fill between the line and the midline: home color above 50, away color below.
  const areaHome = `M${sx(d.winProb[0].x)},${mid} ` + d.winProb.map((r) => `L${sx(r.x).toFixed(1)},${Math.min(mid, sy(r.home)).toFixed(1)}`).join(" ") + ` L${sx(lastX)},${mid} Z`;
  const areaAway = `M${sx(d.winProb[0].x)},${mid} ` + d.winProb.map((r) => `L${sx(r.x).toFixed(1)},${Math.max(mid, sy(r.home)).toFixed(1)}`).join(" ") + ` L${sx(lastX)},${mid} Z`;
  const quarters = [900, 1800, 2700, 3600].filter((q) => q < maxX);
  const scoring = d.winProb.filter((r) => r.scoring);
  const last = d.winProb[d.winProb.length - 1];
  const low = d.winProb.reduce((m, r) => (r.home < m.home ? r : m), d.winProb[0]);
  const high = d.winProb.reduce((m, r) => (r.home > m.home ? r : m), d.winProb[0]);
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">Win probability, play by play</p>
        <p className="mono text-xs text-chalk-3">
          {d.winProb.length} plays · {game.home.abbr} peaked at {Math.round(high.home * 100)}% ({periodLabel(high.period)} {high.clock}), bottomed at {Math.round(low.home * 100)}% ({periodLabel(low.period)} {low.clock})
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full" role="img" aria-label={`${game.home.abbr} win probability over the game`}>
        <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} fill="var(--panel-2, #f5f6f8)" />
        <path d={areaHome} fill={game.home.color} opacity={0.18} />
        <path d={areaAway} fill={game.away.color} opacity={0.18} />
        {quarters.map((q) => (
          <g key={q}>
            <line x1={sx(q)} x2={sx(q)} y1={padT} y2={H - padB} stroke="#d7dbe2" strokeWidth={1} />
            <text x={sx(q) - 3} y={H - 7} fontSize={10} textAnchor="end" fill="#8b95a0" fontFamily="var(--font-plex-mono)">{q === 3600 ? "End 4th" : `End ${q / 900}${q / 900 === 1 ? "st" : q / 900 === 2 ? "nd" : "rd"}`}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={mid} y2={mid} stroke="#8b95a0" strokeWidth={1} strokeDasharray="4 4" />
        {[1, 0.75, 0.5, 0.25, 0].map((p) => (
          <text key={p} x={padL - 6} y={sy(p) + 3.5} fontSize={10} textAnchor="end" fill="#8b95a0" fontFamily="var(--font-plex-mono)">
            {p === 1 ? `${game.home.abbr} 100` : p === 0 ? `${game.away.abbr} 100` : `${Math.round(p * 100)}`}
          </text>
        ))}
        <polyline points={pts} fill="none" stroke="#0d1f3c" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {scoring.map((r, i) => (
          <circle key={i} cx={sx(r.x)} cy={sy(r.home)} r={3.5} fill="#ffffff" stroke="#0d1f3c" strokeWidth={1.5}>
            <title>{`${periodLabel(r.period)} ${r.clock}: ${r.text ?? "score"}`}</title>
          </circle>
        ))}
        <circle cx={sx(last.x)} cy={sy(last.home)} r={4.5} fill={game.status === "live" ? "#1d9a5b" : "#c43d3d"} />
      </svg>
      <p className="mt-1 text-xs text-chalk-3">ESPN&apos;s model. Dots are scoring plays. The shaded side shows who was favored at that point in the game.</p>
    </div>
  );
}

function DriveChart({ game }: { game: Game }) {
  const d = game.liveDetail!;
  const tone = (r: string) => {
    const u = r.toUpperCase();
    if (u === "TD" || u === "TOUCHDOWN") return "bg-turf text-white";
    if (u === "FG" || u === "FIELD GOAL") return "bg-navy text-white";
    if (/FUMBLE|INT|DOWNS|MISSED|SF|SAFETY|BLOCK/.test(u)) return "bg-brick text-white";
    if (u === "IN PROGRESS") return "bg-turf/15 text-turf";
    return "bg-ink-2 text-chalk-2";
  };
  const colorOf = (abbr: string) => (abbr === game.home.abbr ? game.home.color : game.away.color);
  const counts = new Map<string, { drives: number; yards: number; scores: number }>();
  for (const dr of d.drives) {
    const c = counts.get(dr.team) ?? { drives: 0, yards: 0, scores: 0 };
    c.drives++;
    c.yards += dr.yards;
    if (dr.score) c.scores++;
    counts.set(dr.team, c);
  }
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">Drive chart</p>
        <p className="mono text-xs text-chalk-3">
          {[game.away, game.home]
            .map((t) => {
              const c = counts.get(t.abbr);
              return c ? `${t.abbr} ${c.scores} scores on ${c.drives} drives, ${c.yards} yds` : `${t.abbr} no drives yet`;
            })
            .join(" · ")}
        </p>
      </div>
      <ol className="mt-2 grid gap-1">
        {[...d.drives].reverse().map((dr, i) => (
          <li key={i} className={`grid grid-cols-[3rem_2.5rem_5.5rem_minmax(0,1fr)] items-center gap-2 rounded px-1 py-1 text-xs sm:grid-cols-[3.5rem_3rem_6rem_minmax(0,1fr)_11rem] ${dr.current ? "bg-turf/5" : ""}`}>
            <span className="mono text-[11px] text-chalk-3">{dr.period ? periodLabel(dr.period) : ""} {dr.clock}</span>
            <span className="mono font-medium" style={{ color: colorOf(dr.team) }}>{dr.team}</span>
            <span className={`w-fit rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wider ${tone(dr.current ? "In progress" : dr.resultShort || dr.result)}`}>
              {dr.current ? "In progress" : dr.resultShort || dr.result}
            </span>
            <span className="flex items-center gap-2">
              <span className="relative h-2 w-full max-w-40 overflow-hidden rounded-sm bg-ink-2" aria-hidden>
                <span className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, Math.max(0, dr.yards))}%`, background: colorOf(dr.team), opacity: dr.score ? 1 : 0.5 }} />
              </span>
              <span className="mono text-chalk-2 sm:whitespace-nowrap">{dr.plays} plays, {dr.yards} yds{dr.time ? `, ${dr.time}` : ""}</span>
            </span>
            <span className="mono hidden truncate text-[11px] text-chalk-3 sm:block">{dr.start}{dr.end ? ` to ${dr.end}` : ""}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-xs text-chalk-3">Most recent drive first. Bar length is yards gained out of 100.</p>
    </div>
  );
}

/** Shows its children as they are when open; otherwise behind a disclosure with the given label. */
function Fold({ open, label, children }: { open: boolean; label: string; children: React.ReactNode }) {
  if (open) return <>{children}</>;
  return (
    <details>
      <summary className="cursor-pointer select-none text-sm font-semibold text-sky">{label}</summary>
      <div className="mt-3 grid grid-cols-1 gap-3">{children}</div>
    </details>
  );
}
