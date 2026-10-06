/**
 * A player's past games for the player page: every game against this week's opponent, and every storyline game (a team
 * he played for, his birth city, his birth state, his college's state), each with DK points against his own average in
 * his other games that season. Server-only.
 *
 * Inputs: history-games.json (every QB/RB/WR/TE game since 2019 for current players), schedule.json (opponent,
 * home/away, stadium), players.json past (teams played for since 2018) and the draft (his drafting team), ESPN birthplace
 * and college (storylines.ts bios), places.ts (where each game was played). Whether any of this predicts the next game
 * is the backtests' call (scripts/backtest-stories.ts, scripts/backtest-splits.ts); this file only lists what happened.
 */
import { dkPoints } from "./dfs";
import { genHistoryGames, genSchedule, historyGamesStamp, scheduleStamp, type GenGame, type GenPlayer, type StatLine } from "./generated";
import { memoSync } from "./memo";
import { placeOf } from "./places";
import { bios, STATES } from "./storylines";

export interface PastGame {
  g: string;
  season: number;
  wk: number;
  post: boolean;
  team: string; // his team that day
  opp: string;
  ha: "home" | "away" | "neutral";
  dk: number;
  /** His DK average in his other games that season (two or more), and this game against it. */
  avg: number | null;
  diff: number | null;
}

export interface StoryGame {
  kind: "revenge" | "hometown" | "college" | "home-state";
  label: string;
  game: PastGame;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Every game of his since 2019, oldest first, with his average in his other games that season. */
export function pastGames(pid: string): PastGame[] {
  const hist = genHistoryGames();
  if (!hist?.players[pid]) return [];
  return memoSync(`pastgames:${pid}:${historyGamesStamp()}:${scheduleStamp()}`, 3600, () => {
    const sched = scheduleById();
    const raw: Omit<PastGame, "avg" | "diff">[] = [];
    for (const row of hist.players[pid]) {
      const v = Object.fromEntries(hist.cols.map((c, i) => [c, row[i]]));
      const g = sched.get(String(v.g));
      if (!g) continue;
      const team = String(v.t);
      const s = Object.fromEntries(Object.entries(v).filter(([k]) => k !== "g" && k !== "t")) as StatLine;
      raw.push({ g: g.id, season: g.season, wk: g.week, post: g.type === "POST", team, opp: g.home === team ? g.away : g.home, ha: g.neutral ? "neutral" : g.home === team ? "home" : "away", dk: dkPoints(s) });
    }
    raw.sort((a, b) => a.season - b.season || Number(a.post) - Number(b.post) || a.wk - b.wk);
    return raw.map((x) => {
      const others = raw.filter((y) => y.season === x.season && y.g !== x.g && !y.post);
      const avg = others.length >= 2 ? r1(others.reduce((t, y) => t + y.dk, 0) / others.length) : null;
      return { ...x, avg, diff: avg === null ? null : r1(x.dk - avg) };
    });
  });
}

const scheduleById = () => memoSync(`sched:byid:${scheduleStamp()}`, 3600, () => new Map(genSchedule().map((g) => [g.id, g] as [string, GenGame])));

/** His games against one opponent (a nickname), with the games count and the average difference against his average. */
export function vsOpponent(pid: string, opp: string): { games: PastGame[]; meanDiff: number | null } {
  const games = pastGames(pid).filter((x) => x.opp === opp);
  const d = games.map((x) => x.diff).filter((x): x is number => x !== null);
  return { games, meanDiff: d.length ? r1(d.reduce((t, x) => t + x, 0) / d.length) : null };
}

/** "his team from 2023 to 2025" */
function seasonsText(ys: number[]): string {
  const s = [...ys].sort((a, b) => a - b);
  if (s.length === 1) return `in ${s[0]}`;
  const run = s.every((y, i) => i === 0 || y === s[i - 1] + 1);
  return run ? `from ${s[0]} to ${s.at(-1)}` : `in ${s.slice(0, -1).join(", ")} and ${s.at(-1)}`;
}

/**
 * His storyline games, newest first. Revenge: a team he played for in the four seasons before, or the team that drafted
 * him. The place stories count road and neutral games only (a home game is home every other week), in the US: his birth
 * city, else his college's state, else his birth state.
 */
export async function storylineGames(p: GenPlayer): Promise<StoryGame[]> {
  const games = pastGames(p.id);
  if (!games.length) return [];
  const sched = scheduleById();
  const bio = /^\d+$/.test(p.id) ? (await bios([p.id])).get(p.id) : undefined;
  const out: StoryGame[] = [];
  for (const x of games) {
    // Revenge.
    const ys = (p.past?.[x.opp] ?? []).filter((y) => y < x.season && y >= x.season - 4);
    if (x.opp !== x.team && ys.length) out.push({ kind: "revenge", label: `Against the ${x.opp}, his team ${seasonsText(ys)}`, game: x });
    else if (x.opp !== x.team && p.r.club === x.opp && p.r.yr && p.r.yr < x.season && !(p.past?.[x.opp] ?? []).some((y) => y < x.season)) out.push({ kind: "revenge", label: `Against the ${x.opp}, who drafted him in ${p.r.yr}`, game: x });
    // Place.
    if (x.ha === "home" || !bio) continue;
    const g = sched.get(x.g);
    const place = g ? placeOf(g) : undefined;
    if (!place?.us) continue;
    const stateName = STATES[place.state] ?? place.state;
    const born = bio.born;
    const sameCity = Boolean(born?.city && born.state === place.state && born.city.toLowerCase() === place.city.toLowerCase());
    if (sameCity) out.push({ kind: "hometown", label: `In ${place.city}, where he was born`, game: x });
    else if (bio.college?.state === place.state) {
      const listed = p.r.college?.split(";")[0].trim();
      const school = listed && bio.college.name?.startsWith(listed) ? listed : bio.college.name;
      out.push({ kind: "college", label: `In ${stateName}, where he played college ball${school ? ` (${school})` : ""}`, game: x });
    } else if (born?.state === place.state) out.push({ kind: "home-state", label: `In ${stateName}, his birth state (born in ${born.city})`, game: x });
  }
  return out.reverse();
}
