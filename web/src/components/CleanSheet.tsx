import Link from "next/link";
import Image from "next/image";
import type { Game, Team } from "@/lib/types";
import { kickoffTime, spreadText } from "@/lib/format";
import { sideTier, totalTier, tierLabel } from "@/lib/leans";
import { keyNotes } from "@/lib/keynotes";
import { StatusPill } from "./badges";

const ET = "America/New_York";
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: ET });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "long", month: "short", day: "numeric" });

/** Kickoff windows, ET (Derek: the morning game, the 1 PM games, the 4 PM games, prime time). */
const WINDOWS = ["Morning", "Early", "Late", "Prime time"] as const;
type SheetWindow = (typeof WINDOWS)[number];
function windowOf(iso: string): SheetWindow {
  const h = Number(new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: ET }));
  return h < 12 ? "Morning" : h < 15 ? "Early" : h < 19 ? "Late" : "Prime time";
}

/**
 * The clean sheet (Derek: every game, a brief summary under it, click for everything; no analysis paralysis). The
 * whole week grouped by day, each game in four short lines: the line, the model, what moves it, and who to watch.
 * Everything else lives on the game page.
 */
export function CleanSheet({ games }: { games: Game[] }) {
  const sorted = [...games].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const days = new Map<string, Game[]>();
  for (const g of sorted) days.set(dayKey(g.kickoff), [...(days.get(dayKey(g.kickoff)) ?? []), g]);
  return (
    <div className="grid gap-8">
      {[...days].map(([key, list]) => (
        <section key={key}>
          <div className="flex items-baseline gap-3">
            <h2 className="display text-3xl font-bold text-chalk">{dayLabel(list[0].kickoff)}</h2>
            <span className="mono text-xs text-chalk-3">{list.length} {list.length === 1 ? "game" : "games"}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {WINDOWS.map((w) => {
            const inW = list.filter((g) => windowOf(g.kickoff) === w);
            if (!inW.length) return null;
            const times = [...new Set(inW.map((g) => kickoffTime(g.kickoff)))].join(" / ");
            return (
              <div key={w} className="mt-4">
                <div className="flex items-baseline gap-2">
                  <h3 className={`display text-xl font-bold ${w === "Prime time" ? "text-flag" : "text-chalk-2"}`}>{w}</h3>
                  <span className="mono text-[11px] text-chalk-3">{times} ET · {inW.length} {inW.length === 1 ? "game" : "games"}</span>
                </div>
                <ul className="mt-2 grid gap-2.5 lg:grid-cols-2">
                  {inW.map((g) => (
                    <SheetRow key={g.id} game={g} />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ))}
      {!sorted.length && <p className="text-sm text-chalk-3">No games this week.</p>}
    </div>
  );
}

function SheetRow({ game }: { game: Game }) {
  const lines = summary(game);
  const final = game.status === "final";
  return (
    <li>
      <Link href={`/game/${game.id}`} className={`card group block h-full p-4 transition-colors hover:bg-panel-2 ${final ? "final-card" : ""}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="mono text-chalk-2">{kickoffTime(game.kickoff)} ET</span>
          <span className="text-chalk-3">{game.network}</span>
          <StatusPill status={game.status} clock={game.score?.clock} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Side team={game.away} score={game.score?.away} />
          <span className="text-chalk-3">@</span>
          <Side team={game.home} score={game.score?.home} />
        </div>
        <Numbers game={game} />
        {lines.length > 0 && (
          <ul className="mt-2 grid gap-1 text-sm leading-snug text-chalk-2">
            {lines.map((l) => (
              <li key={l.k} className="flex gap-2">
                <span className="mono w-14 shrink-0 pt-px text-[10px] font-semibold uppercase tracking-wider text-chalk-3">{l.k}</span>
                <span className="min-w-0">{l.text}</span>
              </li>
            ))}
          </ul>
        )}
        <span className="mt-2 block text-right text-xs font-semibold text-sky opacity-70 transition-opacity group-hover:opacity-100">Full breakdown</span>
      </Link>
    </li>
  );
}

function Side({ team, score }: { team: Team; score?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {team.logo ? (
        <Image src={team.logo} alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0 object-contain" unoptimized />
      ) : (
        <span className="inline-block h-3 w-1 shrink-0 rounded-sm" style={{ background: team.color }} aria-hidden />
      )}
      <span className="display truncate text-xl font-semibold text-chalk transition-colors group-hover:text-flag">{team.short}</span>
      {team.record && <span className="mono text-[11px] text-chalk-3">{team.record}</span>}
      {score !== undefined && Number.isFinite(score) && <span className="mono ml-1 text-lg font-semibold text-chalk">{score}</span>}
    </span>
  );
}

/** The market and the model on one line, and the gap between them when there is one (never called a pick). */
function Numbers({ game }: { game: Game }) {
  const s = game.market.spread;
  const t = game.market.total;
  const p = game.projection;
  const sTier = p ? sideTier(p.sideGap ?? 0) : undefined;
  const tTier = p && p.totalLean && p.totalLean !== "none" ? totalTier(p.totalGap ?? 0) : undefined;
  const sideLine = p?.modelSide && s ? (p.modelSide === s.team ? s.line : -s.line) : undefined;
  const gaps = [
    sTier && sideLine !== undefined ? `${p!.modelSide} ${sideLine > 0 ? "+" : ""}${sideLine}` : undefined,
    tTier && t ? `${p!.totalLean === "over" ? "Over" : "Under"} ${t.line}` : undefined,
  ].filter(Boolean);
  return (
    <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span className="text-chalk-2">
        <span className="text-chalk-3">Line </span>
        {s ? spreadText(s.team, s.line) : "none"}
        {t ? ` · O/U ${t.line}` : ""}
      </span>
      {p && (
        <span className="text-chalk-2">
          <span className="text-chalk-3">{game.status === "upcoming" ? "Model " : "Called "}</span>
          {p.winner} by {p.margin.toFixed(1)}
          {p.modelTotal ? ` · ${p.modelTotal}` : ""}
        </span>
      )}
      {gaps.length > 0 && game.status === "upcoming" && (
        <span className="font-semibold text-flag" title="The model disagrees with the market by this much. Backtests have not found a gap size that beats the closing line; a disagreement, not a pick.">
          {tierLabel(sTier ?? tTier)}: {gaps.join(", ")}
        </span>
      )}
    </div>
  );
}

/** Up to three short lines: what moves the game (QB, absences, weather), the biggest unit mismatch, and who to watch. */
function summary(game: Game): { k: string; text: string }[] {
  const out: { k: string; text: string }[] = [];
  const notes = keyNotes(game);
  if (notes.length) out.push({ k: game.status === "final" ? "Result" : "News", text: notes.slice(0, 2).join(". ") + "." });
  const m = game.matchups.find((x) => x.edge && x.edge !== "even");
  if (m && game.status !== "final") {
    const favors = m.edge === "offense" ? m.a.split(" ")[0] : m.b.split(" ")[0];
    out.push({ k: "Matchup", text: `${cap(m.a)} vs ${m.b}: favors the ${favors}.` });
  }
  const names = (game.offenseRadar ?? game.prospects).filter((p) => ["QB", "RB", "WR", "TE"].includes(p.radar?.group ?? p.pos)).slice(0, 3);
  // A questionable player stays on the list with his status next to his name (Derek's call).
  const injuryOf = (id: string) => {
    const st = game.availability?.home.statuses[id] ?? game.availability?.away.statuses[id];
    return st && st.absence > 0 ? st.status.toLowerCase() : undefined;
  };
  if (names.length && game.status !== "final") out.push({ k: "Watch", text: names.map((p) => `${p.name} (${[`${p.team} ${p.pos}`, injuryOf(p.id), p.tier === "Rookie" ? "rookie" : undefined, p.matchupSide === "against" ? "tough matchup" : undefined].filter(Boolean).join(", ")})`).join(", ") });
  return out.slice(0, 3);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
