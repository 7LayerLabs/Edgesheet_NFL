import Link from "next/link";
import Image from "next/image";
import { getSlate } from "@/lib/slate";
import { logoUrl, standings, teamByShort, CONFERENCES, DIVISIONS, type NflTeam, type Standing } from "@/lib/nfl";
import { kickoffTime } from "@/lib/format";
import { playoffTeamsFor, simulateSeason, standingsWithTiebreaks, type SeedRow, type TeamOdds } from "@/lib/seed";
import { FollowButton } from "@/components/FollowButton";
import type { Game } from "@/lib/types";

export const dynamic = "force-dynamic";

const RUNS = 10000;

/**
 * Standings from the nflverse schedule results (plus ESPN finals not yet ingested), ordered and seeded with the NFL's
 * tiebreaking procedures (src/lib/seed.ts, checked against every playoff field from 2019 to 2025 by
 * scripts/backtest-seed.mts). Playoff, division, and bye odds come from our Elo playing the rest of the season.
 */
export default async function StandingsPage() {
  const slate = await getSlate();
  const rows = standingsWithTiebreaks(slate.season, undefined, slate.finals);
  const extra = new Map(standings(slate.season, slate.finals).map((s) => [s.team.short, s]));
  const sim = simulateSeason(slate.season, { runs: RUNS, finals: slate.finals });
  const odds = new Map(sim.teams.map((t) => [t.team, t]));
  const byTeam = new Map<string, Game>();
  for (const g of slate.weekGames) {
    byTeam.set(g.home.short, g);
    byTeam.set(g.away.short, g);
  }
  const played = rows.some((r) => r.games > 0);
  const wildCards = playoffTeamsFor(slate.season) - 4;

  return (
    <div>
      <p className="eyebrow">{slate.week ? `${slate.season} · ${slate.week.label}` : "Standings"}</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">Standings</h1>
      <p className="mt-2 max-w-2xl text-sm text-chalk-3">
        Records from the nflverse schedule file. Division order and seeds follow the NFL&apos;s tiebreaking procedures, checked against every playoff field from 2019 to 2025 (all 96 teams and seeds matched). A note under a team says how a tie was settled, for division places and for seeds through the first team out. Follow a team and every game it plays lands in your watchlist.
      </p>
      <p className="mt-1 max-w-2xl text-xs text-chalk-3">
        Playoff, division, and bye odds: our Elo plays the {sim.remaining} remaining games {RUNS.toLocaleString("en-US")} times, each score drawn from a real final, with ratings updated as it goes. A model, not a pick.
      </p>

      {!played && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">No results yet this season</p>
          <p className="mt-1 text-sm text-chalk-3">Standings fill in after the first game is final and the schedule file is re-ingested.</p>
        </div>
      )}

      {CONFERENCES.map((conf) => (
        <section key={conf} className="mt-8">
          <div className="flex items-baseline gap-3">
            <h2 className="display text-3xl font-bold text-chalk">{conf}</h2>
            <span className="mono text-xs text-chalk-3">seeds: division winners 1 to 4, then {wildCards} wild cards</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="mt-3 grid gap-5 md:grid-cols-2">
            {DIVISIONS.map((div) => (
              <DivisionTable
                key={div}
                title={`${conf} ${div}`}
                rows={rows.filter((r) => r.conf === conf && r.div === div).sort((a, b) => a.divRank - b.divRank)}
                extra={extra}
                odds={odds}
                remaining={sim.remaining}
                playoffs={playoffTeamsFor(slate.season)}
                byTeam={byTeam}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Percent for an odds cell. 10,000 runs never prove a clinch, so the ends read "over 99%" and "under 1%". */
function pct(p: number, remaining: number): string {
  if (!remaining) return p >= 0.5 ? "Yes" : "No";
  if (p >= 0.995) return ">99%";
  if (p > 0 && p < 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

function DivisionTable({ title, rows, extra, odds, remaining, playoffs, byTeam }: { title: string; rows: SeedRow[]; extra: Map<string, Standing>; odds: Map<string, TeamOdds>; remaining: number; playoffs: number; byTeam: Map<string, Game> }) {
  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="display text-2xl font-bold text-chalk">{title}</h3>
      </div>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-chalk-3">
            <th className="py-1 pr-2 font-semibold">Team</th>
            <th className="py-1 pr-2 text-right font-semibold">W-L</th>
            <th className="hidden py-1 pr-2 text-right font-semibold sm:table-cell">Div</th>
            <th className="hidden py-1 pr-2 text-right font-semibold lg:table-cell">PF-PA</th>
            <th className="hidden py-1 pr-2 text-right font-semibold sm:table-cell">Strk</th>
            <th className="py-1 pr-2 text-right font-semibold" title="Share of simulated seasons that end in the playoffs">Playoffs</th>
            <th className="hidden py-1 pr-2 text-right font-semibold sm:table-cell" title="Share of simulated seasons that end with the division title">Div win</th>
            <th className="hidden py-1 pr-2 text-right font-semibold sm:table-cell" title="Share of simulated seasons that end with the 1 seed and the first-round bye">Bye</th>
            <th className="py-1 text-right font-semibold">Seed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const team = teamByShort(r.team) as NflTeam;
            const s = extra.get(r.team);
            const o = odds.get(r.team);
            const g = byTeam.get(r.team);
            const opp = g ? (g.home.short === r.team ? g.away : g.home) : undefined;
            const atHome = g ? g.home.short === r.team : false;
            // Division-place ties always; seed ties only through the first team out, where a tie decides who is in.
            const note = [r.divNote, r.seed <= playoffs + 1 ? r.seedNote : undefined].filter(Boolean).join(" ");
            return [
              <tr key={r.team} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-2">
                    <Image src={logoUrl(team.abbr)} alt="" width={22} height={22} className="h-[22px] w-[22px] object-contain" unoptimized />
                    <span className="min-w-0">
                      <span className="display block text-lg font-semibold leading-tight text-chalk">{r.team}</span>
                      {g && opp ? (
                        <Link href={`/game/${g.id}`} className="mono text-[11px] text-sky hover:text-chalk">
                          {atHome ? "vs" : "at"} {opp.short} · {kickoffTime(g.kickoff)} ET
                          {g.status === "final" && g.score && Number.isFinite(g.score.home) ? ` · Final ${atHome ? g.score.home : g.score.away}-${atHome ? g.score.away : g.score.home}` : ""}
                          {g.status === "live" ? " · in progress" : ""}
                        </Link>
                      ) : (
                        <span className="mono text-[11px] text-chalk-3">bye this week</span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="mono py-1.5 pr-2 text-right text-chalk">{r.w}-{r.l}{r.t ? `-${r.t}` : ""}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 sm:table-cell">{r.div3.w}-{r.div3.l}{r.div3.t ? `-${r.div3.t}` : ""}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 lg:table-cell">{r.pf}-{r.pa}</td>
                <td className={`mono hidden py-1.5 pr-2 text-right sm:table-cell ${s?.streak.startsWith("W") ? "text-turf" : s?.streak.startsWith("L") ? "text-brick" : "text-chalk-3"}`}>{s?.streak || "-"}</td>
                <td className="mono py-1.5 pr-2 text-right font-semibold text-chalk">{o ? pct(o.playoffs, remaining) : "-"}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 sm:table-cell">{o ? pct(o.division, remaining) : "-"}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 sm:table-cell">{o ? pct(o.bye, remaining) : "-"}</td>
                <td className="py-1.5 text-right">
                  <span className={`mono rounded px-1.5 py-0.5 text-[11px] ${r.seed <= 4 ? "bg-navy text-white" : r.seed <= playoffs ? "bg-sky/15 text-navy" : "text-chalk-3"}`}>{r.seed}</span>
                  <span className="ml-2 inline-block align-middle"><FollowButton kind="teams" id={r.team} label="Follow" size="sm" /></span>
                </td>
              </tr>,
              note ? (
                <tr key={`${r.team}-note`}>
                  <td colSpan={9} className="pb-1.5 pl-[30px] pr-2 text-[11px] leading-snug text-chalk-3">
                    Tiebreak: {note}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
