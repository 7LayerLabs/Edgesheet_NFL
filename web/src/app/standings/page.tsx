import Link from "next/link";
import Image from "next/image";
import { getSlate } from "@/lib/slate";
import { logoUrl, standings, CONFERENCES, DIVISIONS, type Standing } from "@/lib/nfl";
import { kickoffTime } from "@/lib/format";
import { FollowButton } from "@/components/FollowButton";
import type { Game } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Standings from the nflverse schedule results. Order inside a division is win
 * percentage, then division record, then point differential. The NFL's full
 * tiebreak chain (head to head, common games, strength of victory) is not
 * applied, and the page says so.
 */
export default async function StandingsPage() {
  const slate = await getSlate();
  const rows = standings(slate.season, slate.finals);
  const byTeam = new Map<string, Game>();
  for (const g of slate.weekGames) {
    byTeam.set(g.home.short, g);
    byTeam.set(g.away.short, g);
  }
  const played = rows.some((r) => r.games > 0);

  return (
    <div>
      <p className="eyebrow">{slate.week ? `${slate.season} · ${slate.week.label}` : "Standings"}</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">Standings</h1>
      <p className="mt-2 max-w-2xl text-sm text-chalk-3">
        Records from the nflverse schedule file. Division order is win percentage, then division record, then point differential; the full NFL tiebreak chain is not applied. Follow a team and every game it plays lands in your watchlist.
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
            <span className="mono text-xs text-chalk-3">seed line: division winners first, then the next three by record</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="mt-3 grid gap-5 md:grid-cols-2">
            {DIVISIONS.map((div) => (
              <DivisionTable key={div} title={`${conf} ${div}`} rows={rows.filter((r) => r.team.conf === conf && r.team.div === div)} byTeam={byTeam} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DivisionTable({ title, rows, byTeam }: { title: string; rows: Standing[]; byTeam: Map<string, Game> }) {
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
            <th className="hidden py-1 pr-2 text-right font-semibold sm:table-cell">PF-PA</th>
            <th className="py-1 pr-2 text-right font-semibold">Strk</th>
            <th className="py-1 text-right font-semibold">Seed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const g = byTeam.get(r.team.short);
            const opp = g ? (g.home.short === r.team.short ? g.away : g.home) : undefined;
            const atHome = g ? g.home.short === r.team.short : false;
            return (
              <tr key={r.team.short} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-2">
                    <Image src={logoUrl(r.team.abbr)} alt="" width={22} height={22} className="h-[22px] w-[22px] object-contain" unoptimized />
                    <span className="min-w-0">
                      <span className="display block text-lg font-semibold leading-tight text-chalk">{r.team.short}</span>
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
                <td className="mono py-1.5 pr-2 text-right text-chalk">{r.record}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 sm:table-cell">{r.divW}-{r.divL}{r.divT ? `-${r.divT}` : ""}</td>
                <td className="mono hidden py-1.5 pr-2 text-right text-chalk-2 sm:table-cell">{r.pf}-{r.pa}</td>
                <td className={`mono py-1.5 pr-2 text-right ${r.streak.startsWith("W") ? "text-turf" : r.streak.startsWith("L") ? "text-brick" : "text-chalk-3"}`}>{r.streak || "-"}</td>
                <td className="py-1.5 text-right">
                  <span className={`mono rounded px-1.5 py-0.5 text-[11px] ${r.seed <= 4 ? "bg-navy text-white" : r.seed <= 7 ? "bg-sky/15 text-navy" : "text-chalk-3"}`}>{r.seed}</span>
                  <span className="ml-2 inline-block align-middle"><FollowButton kind="teams" id={r.team.short} label="Follow" size="sm" /></span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
