/**
 * DraftKings DST (team defense) projections for the live app. The formula lives in dst-core.mjs, shared with the backtest
 * (scripts/build-dfs-sim.mjs, MAE 4.05 against 4.27 for the defense's season average on 2022 to 2025). Server-only.
 */
import { projectDst } from "./dst-core.mjs";
import { genTeams } from "./generated";

/** League-average team total, used when a game has no posted line. */
const LEAGUE_TEAM_TOTAL = 22.4;

/** Implied team totals from a posted spread (team and line, favorite negative) and total. */
export function impliedTotals(home: string, spread: { team: string; line: number } | undefined, total: number | undefined): { home: number; away: number } | undefined {
  if (!spread || total === undefined) return undefined;
  const homeMargin = spread.team === home ? -spread.line : spread.line; // home points minus away points
  return { home: (total + homeMargin) / 2, away: (total - homeMargin) / 2 };
}

export interface DstProjection {
  proj: number;
  sacks: number;
  takeaways: number;
  tds: number;
  paPoints: number;
  oppImplied: number;
  lined: boolean; // false when no posted line: points allowed uses the league-average team total
}

/** One defense against one opponent (nicknames). Undefined when either team has no DST counts. */
export function dstProjection(team: string, opp: string, oppImplied: number | undefined): DstProjection | undefined {
  const teams = genTeams();
  const t = teams.find((x) => x.team === team)?.dst;
  const o = teams.find((x) => x.team === opp)?.dst;
  if (!t || !o || (!t.now && !t.prev)) return undefined;
  const implied = oppImplied ?? LEAGUE_TEAM_TOTAL;
  const r = projectDst(t, o, implied);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return { proj: round1(r.proj), sacks: round1(r.sacks), takeaways: round1(r.takeaways), tds: Math.round(r.tds * 100) / 100, paPoints: round1(r.paPoints), oppImplied: round1(implied), lined: oppImplied !== undefined };
}
