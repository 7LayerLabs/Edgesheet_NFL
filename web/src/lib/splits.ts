/**
 * Situational splits since 2019 (regular season), shown next to what the backtest found (scripts/backtest-splits.mts).
 * Server-only.
 *
 *   Player: DK points against his own average in his other games that season, at home or away, in division games,
 *     in primetime (kickoff 7 PM ET or later), on a short week (4 or fewer days of rest).
 *   Team: points scored against the closing implied team total ((total +/- spread) / 2), in the same situations.
 *   Defense: DraftKings DST points a game in the situation against its other games (history-games.json dst).
 *
 * Each row carries its games count; `now` marks the rows that match this week's game. The verdict text comes from
 * backtest-notes.ts: only a player's own home/away split carried over (weakly); no team or defense split did.
 */
import { genHistoryGames, genSchedule, historyGamesStamp, scheduleStamp, type GenGame } from "./generated";
import { memoSync } from "./memo";
import { pastGames } from "./player-history";

export type SplitKey = "home" | "away" | "division" | "primetime" | "short";

export interface SplitRow {
  key: SplitKey;
  label: string;
  n: number;
  mean: number | null; // in the situation
  restN: number;
  rest: number | null; // in every other game (the other side of the split)
  now: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((t, x) => t + x, 0) / xs.length) : null);
const schedById = () => memoSync(`splits:sched:${scheduleStamp()}`, 3600, () => new Map(genSchedule().map((g) => [g.id, g] as [string, GenGame])));

/** The situations of one side of a scheduled game. */
export function situation(g: GenGame, team: string): Record<SplitKey, boolean> {
  const home = !g.neutral && g.home === team;
  const away = !g.neutral && g.away === team;
  const rest = g.home === team ? g.homeRest : g.awayRest;
  return { home, away, division: g.divGame, primetime: (g.time ?? "") >= "19:00", short: rest !== null && rest !== undefined && rest <= 4 };
}

const LABEL: Record<SplitKey, string> = { home: "At home", away: "On the road", division: "Division games", primetime: "Primetime", short: "Short week" };

function rows(items: { sit: Record<SplitKey, boolean>; v: number }[], now?: Record<SplitKey, boolean>): SplitRow[] {
  return (["home", "away", "division", "primetime", "short"] as const).map((k) => {
    const inS = items.filter((x) => x.sit[k]).map((x) => x.v);
    // Home's other side is away games and the reverse (neutral games are in neither); the rest are in or out.
    const other = k === "home" ? items.filter((x) => x.sit.away) : k === "away" ? items.filter((x) => x.sit.home) : items.filter((x) => !x.sit[k]);
    return { key: k, label: LABEL[k], n: inS.length, mean: avg(inS), restN: other.length, rest: avg(other.map((x) => x.v)), now: Boolean(now?.[k]) };
  });
}

/** A player's splits: DK points against his own average in his other games that season; `team` is his team now. */
export function playerSplits(pid: string, gameId?: string, team?: string): SplitRow[] {
  const sched = schedById();
  const g = gameId ? sched.get(gameId) : undefined;
  const items = pastGames(pid)
    .filter((x) => !x.post && x.diff !== null)
    .map((x) => ({ sched: sched.get(x.g), x }))
    .filter((y): y is { sched: GenGame; x: (typeof y)["x"] } => Boolean(y.sched))
    .map((y) => ({ sit: situation(y.sched, y.x.team), v: y.x.diff! }));
  return rows(items, g && team ? situation(g, team) : undefined);
}

/** A team's splits: points against the closing implied team total, regular season since 2019. */
export function teamSplits(team: string, gameId?: string): SplitRow[] {
  return memoSync(`splits:team:${team}:${gameId ?? ""}:${scheduleStamp()}`, 3600, () => {
    const sched = schedById();
    const items: { sit: Record<SplitKey, boolean>; v: number }[] = [];
    for (const g of sched.values()) {
      if (g.type !== "REG" || !g.played || g.spread === null || g.totalLine === null || (g.home !== team && g.away !== team)) continue;
      const impliedHome = (g.totalLine + g.spread) / 2;
      const v = g.home === team ? g.hs! - impliedHome : g.as! - (g.totalLine - impliedHome);
      items.push({ sit: situation(g, team), v });
    }
    const g = gameId ? sched.get(gameId) : undefined;
    return rows(items, g ? situation(g, team) : undefined);
  });
}

/** A defense's DraftKings points a game in each situation, and at home against a division rival. */
export function dstSplits(team: string, gameId?: string): { rows: SplitRow[]; homeDivision: { n: number; mean: number | null; restN: number; rest: number | null; now: boolean } } {
  return memoSync(`splits:dst:${team}:${gameId ?? ""}:${historyGamesStamp()}:${scheduleStamp()}`, 3600, () => {
    const sched = schedById();
    const items: { sit: Record<SplitKey, boolean>; v: number }[] = [];
    for (const [gid, pts] of genHistoryGames()?.dst?.[team] ?? []) {
      const g = sched.get(gid);
      if (!g || g.type !== "REG") continue;
      items.push({ sit: situation(g, team), v: pts });
    }
    const g = gameId ? sched.get(gameId) : undefined;
    const now = g ? situation(g, team) : undefined;
    const hd = items.filter((x) => x.sit.home && x.sit.division).map((x) => x.v);
    const restHd = items.filter((x) => !(x.sit.home && x.sit.division)).map((x) => x.v);
    return { rows: rows(items, now), homeDivision: { n: hd.length, mean: avg(hd), restN: restHd.length, rest: avg(restHd), now: Boolean(now?.home && now.division) } };
  });
}
