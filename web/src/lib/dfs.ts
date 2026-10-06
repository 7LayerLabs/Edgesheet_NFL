/**
 * DraftKings and player-prop lens for one game or a whole slate. Server-only.
 *
 * Salaries, DraftKings' own points per game, and its injury tags come from DraftKings'
 * public lobby JSON (getcontests, then getavailableplayers per draft group). Cached
 * 20 minutes in memory and on disk under data/dk/<date>.json; a failed fetch falls back
 * to the disk copy. The Classic group with the most games on the date supplies salaries;
 * a game outside it (London, Thursday, Monday) uses its Showdown FLEX salaries.
 *
 * Our DK points are scored from the nflverse game lines with DraftKings Classic rules:
 * 4 per pass TD, 1 per 25 pass yards, 3 for 300+, -1 per INT; 6 per rush or catch TD,
 * 1 per 10 rush or receiving yards, 3 for 100+ either way; 1 per catch; -1 per fumble
 * lost; 6 per return TD. Two-point conversions are not in the weekly file, so they are
 * left out. Nothing is invented: a player without a salary is not shown as a play.
 *
 * Projection (shown as "proj"): our average, blended with last season's per-game line at
 * weight 3 / (games + 3), times a quarter of the matchup factor (DK points the
 * opponent allows to the position against the league average, capped 0.7 to 1.35),
 * plus the next man up's share of an Out or Doubtful teammate's average (NEXT_MAN_UP_SHARE: RB 25%, TE 20%, WR none).
 *
 * Defenses (DST): src/lib/dst.ts, from the defense's and the opponent's sack and turnover rates and the market's implied
 * opponent total (backtested in scripts/build-dfs-sim.mjs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kickoffTime } from "./format";
import { extrasStamp, genExtras, genGamelogs, genPlayers, genSchedule, genTeams, gamelogsStamp, type GenPlayer, type StatLine } from "./generated";
import { memo, memoSync } from "./memo";
import { nflTeams, etDateOf, type NflTeam } from "./nfl";
import { findOddsFile, type PropRow } from "./odds";
import { absenceOf, espnInjuries, playerStatus, statusClock, type EspnInjury, type StatusClock } from "./availability";
import { dstProjection, impliedTotals } from "./dst";

export type DkPos = "QB" | "RB" | "WR" | "TE";
const DK_POS: DkPos[] = ["QB", "RB", "WR", "TE"];
/** Positions a DraftKings Classic lineup is built from: the skill positions plus the team defense. */
export type DfsPos = DkPos | "DST";

interface GameLike {
  id: string;
  kickoff: string;
  home: { short: string; abbr: string };
  away: { short: string; abbr: string };
  /** The posted line, for the defenses' implied opponent totals. */
  market?: { spread?: { team: string; line: number }; total?: { line: number } };
}

/* ------------------------------------------------------------ scoring */

/** DraftKings Classic points for one stat line (no two-point conversions). */
export function dkPoints(s: StatLine | null | undefined): number {
  if (!s) return 0;
  const n = (k: string) => s[k] ?? 0;
  const py = n("py"), ry = n("ry"), rcy = n("rcy");
  const pts =
    py * 0.04 + n("ptd") * 4 - n("pint") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rtd") * 6 + (ry >= 100 ? 3 : 0) +
    n("rec") + rcy * 0.1 + n("rctd") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fl") + n("sttd") * 6;
  return Math.round(pts * 10) / 10;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
/** Backtest fits (scripts/backtest-dfs.mjs): last season counts as 3 games; the matchup factor at a quarter (half was worse than none). */
const PRIOR_GAMES = 3;
const MATCHUP_WEIGHT = 0.25;
/**
 * Share of an Out player's DK average the next man up gains, by position. scripts/backtest-nextman.mjs on 2022 to 2025
 * (595 new absences, 303 repeat): backups gained 28% of a back's average (35% on a second straight absence), 23% of a
 * tight end's, and 3% of a receiver's split three ways, i.e. nothing. The old flat half ran 1.8 points a taker too high.
 * The gain is lopsided (median 6% at RB): most weeks little, some weeks a breakout, so it is a tournament angle, not cash.
 */
export const NEXT_MAN_UP_SHARE: Record<DkPos, number> = { QB: 0, RB: 0.25, TE: 0.2, WR: 0 };

/**
 * Weight of expected fantasy points (ffverse ffopportunity: what a player's targets, carries, and field position were
 * worth) in the projection base. scripts/backtest-xfp.mjs on 2022 to 2025 (8,209 player-weeks): miss 6.52 DK points
 * with none, 6.46 at half (best), 6.50 with expected points alone; correlation 0.397 to 0.404.
 */
const XFP_WEIGHT = 0.5;

/** League sacks per PFR pressure this season (last season while this one is thin), for the pass-rush lens. */
const sackPerPressure = () =>
  memoSync(`dfs:skpr:${extrasStamp()}`, 3600, () => {
    const ex = genExtras();
    if (!ex) return 0.13;
    const sum = (y: number) => {
      let sk = 0, pr = 0;
      for (const e of Object.values(ex.players)) {
        const d = e.adv?.[String(y)]?.def;
        if (d) { sk += d.sk ?? 0; pr += d.press ?? 0; }
      }
      return { sk, pr };
    };
    const now = sum(ex.season);
    const use = now.pr >= 500 ? now : sum(ex.season - 1);
    return use.pr ? use.sk / use.pr : 0.13;
  });

/** DraftKings points over ffopportunity points this season across everyone with both (DK adds yardage bonuses). */
const xfpScale = () =>
  memoSync(`dfs:xfpScale:${gamelogsStamp()}:${extrasStamp()}`, 3600, () => {
    const logs = genGamelogs();
    const ex = genExtras();
    if (!logs || !ex) return 1;
    let dk = 0, fp = 0;
    for (const [id, e] of Object.entries(ex.players)) {
      if (!e.xfp) continue;
      const lines = logs.players[id];
      if (!lines) continue;
      for (const [y, wk, , f] of e.xfp) {
        if (y !== ex.season) continue;
        const l = lines.find((x) => x.wk === wk && x.st === "regular");
        if (l) { dk += dkPoints(l.s); fp += f; }
      }
    }
    return fp > 0 ? dk / fp : 1;
  });

/**
 * One short line of this season's tracking and charting for a skill player, from the extras feed: blocking and
 * rush yards over expected for backs, separation and drops for receivers, pressure for quarterbacks. Shown only
 * with a real sample; never a guess.
 */
export function advPhrase(id: string, pos: DkPos): string | undefined {
  const ex = genExtras();
  const e = ex?.players[id];
  if (!ex || !e) return undefined;
  const adv = e.adv?.[ex.season];
  const ngs = e.ngs?.[ex.season];
  const out: string[] = [];
  if (pos === "RB") {
    const r = adv?.rush;
    if (r?.att && r.att >= 20 && r.ybc !== undefined) out.push(`${round1(r.ybc / r.att)} yards before contact a carry (blocking) and ${round1((r.yac ?? 0) / r.att)} after`);
    if (ngs?.rush?.ryoePer !== undefined && (ngs.rush.att ?? 0) >= 20) out.push(`${ngs.rush.ryoePer > 0 ? "+" : ""}${round1(ngs.rush.ryoePer)} rush yards over expected a carry`);
  } else if (pos === "WR" || pos === "TE") {
    if (ngs?.rec?.sep !== undefined && (ngs.rec.tgt ?? 0) >= 12) out.push(`${round1(ngs.rec.sep)} yards of separation at the catch point`);
    const d = adv?.rec?.drops ?? 0;
    if (d >= 2) out.push(`${d} drops`);
  } else if (pos === "QB") {
    const ps = adv?.pass;
    const pl = genPlayers().find((x) => x.id === id);
    const dropbacks = (pl?.s?.pa ?? 0) + (pl?.s?.sks ?? 0);
    if (ps?.press !== undefined && dropbacks >= 40) out.push(`pressured on ${Math.round((ps.press / dropbacks) * 100)}% of dropbacks`);
    if (ngs?.pass?.ttt !== undefined) out.push(`${round1(ngs.pass.ttt)} seconds to throw`);
  }
  return out.length ? out.join(", ") : undefined;
}

/** What his usage was worth a game, on DK's scale: this season blended with last season the way the projection blends points. */
export function usageWorth(id: string): { now: number; base: number; games: number } | undefined {
  const ex = genExtras();
  const lines = ex?.players[id]?.xfp;
  if (!ex || !lines?.length) return undefined;
  const now = lines.filter((l) => l[0] === ex.season);
  if (!now.length) return undefined;
  const last = lines.filter((l) => l[0] === ex.season - 1);
  const avg = (xs: typeof lines) => xs.reduce((a, b) => a + b[2], 0) / xs.length;
  const xNow = avg(now);
  const blended = last.length >= 4 ? (now.length * xNow + PRIOR_GAMES * avg(last)) / (now.length + PRIOR_GAMES) : xNow;
  const s = xfpScale();
  return { now: round1(xNow * s), base: blended * s, games: now.length };
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x: number | undefined | null) => (x == null ? undefined : Math.round(x * 100));
const ordinal = (n: number) => `No. ${n}`;

/* -------------------------------------------------------- DraftKings */

export interface DkRow {
  name: string;
  team: string; // our nickname
  pos: string; // QB RB WR TE DST K
  salary: number;
  dkPpg?: number;
  status?: string; // O, Q, D, IR as DraftKings tags it
  slate: "classic" | "showdown";
  group: number;
}

export interface DkSlate {
  date: string;
  fetchedAt: string;
  groups: { id: number; slate: "classic" | "showdown"; label: string; games: number }[];
  rows: DkRow[];
  error?: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const DK_DIR = path.join(process.cwd(), "data", "dk");
const TTL_MIN = 20;

let teamIndex: Map<string, NflTeam> | undefined;
/** DraftKings abbreviations match either the ESPN abbr (LAR) or the nflverse code (WAS). */
function teamFromDk(abbr: string): NflTeam | undefined {
  if (!teamIndex) {
    teamIndex = new Map();
    for (const t of nflTeams()) {
      teamIndex.set(t.abbr, t);
      teamIndex.set(t.code, t);
    }
  }
  return teamIndex.get(abbr);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`DraftKings answered ${res.status}`);
  return (await res.json()) as T;
}

interface LobbyGroup { DraftGroupId: number; GameTypeId: number; GameCount: number; StartDateEst: string; ContestStartTimeSuffix?: string | null }
interface DkPlayer { fn: string; ln: string; pn: string; s: number; ppg?: string; i?: string; tid: number; htid: number; atid: number; htabbr: string; atabbr: string }

async function playersFor(groupId: number, slate: "classic" | "showdown"): Promise<DkRow[]> {
  const j = await getJson<{ playerList?: DkPlayer[] }>(`https://www.draftkings.com/lineup/getavailableplayers?draftGroupId=${groupId}`);
  const out: DkRow[] = [];
  for (const p of j.playerList ?? []) {
    const abbr = p.tid === p.htid ? p.htabbr : p.atabbr;
    const team = teamFromDk(abbr);
    if (!team || !p.s) continue;
    const ppg = p.ppg ? Number(p.ppg) : undefined;
    out.push({ name: `${p.fn} ${p.ln}`.trim(), team: team.short, pos: p.pn, salary: p.s, dkPpg: Number.isFinite(ppg) ? ppg : undefined, status: p.i || undefined, slate, group: groupId });
  }
  return out;
}

async function fetchDkSlate(date: string): Promise<DkSlate> {
  const lobby = await getJson<{ DraftGroups?: LobbyGroup[] }>("https://www.draftkings.com/lobby/getcontests?sport=NFL");
  const onDate = (lobby.DraftGroups ?? []).filter((g) => String(g.StartDateEst).startsWith(date));
  const classic = onDate.filter((g) => g.GameTypeId === 1).sort((a, b) => b.GameCount - a.GameCount)[0];
  const groups: DkSlate["groups"] = [];
  const rows: DkRow[] = [];
  if (classic) {
    rows.push(...(await playersFor(classic.DraftGroupId, "classic")));
    groups.push({ id: classic.DraftGroupId, slate: "classic", label: `Classic${classic.ContestStartTimeSuffix ? classic.ContestStartTimeSuffix : ""}`.trim(), games: classic.GameCount });
  }
  const covered = new Set(rows.map((r) => r.team));
  const showdowns = onDate.filter((g) => g.GameTypeId === 96);
  // Every game on the date from the schedule, not the caller's list: the result is cached by date alone.
  for (const g of genSchedule().filter((x) => etDateOf(x.kickoff) === date)) {
    if (covered.has(g.home) && covered.has(g.away)) continue;
    const want = [teamOf(g.home), teamOf(g.away)].filter(Boolean) as NflTeam[];
    const sd = showdowns.find((s) => want.every((t) => new RegExp(`\\b(${t.abbr}|${t.code})\\b`).test(s.ContestStartTimeSuffix ?? "")));
    if (!sd) continue;
    rows.push(...(await playersFor(sd.DraftGroupId, "showdown")));
    groups.push({ id: sd.DraftGroupId, slate: "showdown", label: `Showdown${sd.ContestStartTimeSuffix ?? ""}`.trim(), games: 1 });
  }
  return { date, fetchedAt: new Date().toISOString(), groups, rows };
}

const teamOf = (short: string) => nflTeams().find((t) => t.short === short);

function readDisk(date: string): DkSlate | undefined {
  try {
    const f = path.join(DK_DIR, `${date}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as DkSlate) : undefined;
  } catch {
    return undefined;
  }
}

/** Salaries for a date: the main Classic group plus a Showdown for each game outside it. Never throws: on failure returns the disk copy or an empty slate with the reason. */
export function dkSlate(date: string): Promise<DkSlate> {
  return memo(`dk:${date}`, TTL_MIN * 60, async () => {
    const disk = readDisk(date);
    if (disk && Date.now() - Date.parse(disk.fetchedAt) < TTL_MIN * 60_000 && disk.rows.length) return disk;
    try {
      const fresh = await fetchDkSlate(date);
      if (fresh.rows.length) {
        mkdirSync(DK_DIR, { recursive: true });
        writeFileSync(path.join(DK_DIR, `${date}.json`), JSON.stringify(fresh));
        return fresh;
      }
      return disk ?? { ...fresh, error: "DraftKings has no NFL salaries posted for this date." };
    } catch (err) {
      return disk ?? { date, fetchedAt: new Date().toISOString(), groups: [], rows: [], error: `DraftKings salaries unavailable: ${(err as Error).message}` };
    }
  });
}

/* ----------------------------------------------------------- joins */

export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Status, freshest first: the DraftKings tag, then ESPN and the official report as the availability model reads them (dated to this game). */
const statusOf = (p: GenPlayer | undefined, dk: DkRow | undefined, espn: EspnInjury | undefined, clock: StatusClock | undefined): string | undefined => {
  const st = p && clock ? playerStatus(p, espn, clock) : undefined;
  const raw = dk?.status || (st && st.status !== "Active" ? st.status : undefined) || undefined;
  if (!raw) return undefined;
  const map: Record<string, string> = { O: "Out", D: "Doubtful", Q: "Questionable", IR: "IR", PUP: "PUP", NFI: "NFI", SUSP: "Suspended" };
  return map[raw.toUpperCase()] ?? raw;
};
const isOut = (st: string | undefined) => absenceOf(st) >= 0.85;

/** Per player: DK points per game this season from the game lines. */
const seasonDk = () =>
  memoSync(`dfs:season:${gamelogsStamp()}`, 3600, () => {
    const logs = genGamelogs();
    const out = new Map<string, { games: number; avg: number; last?: number; high: number; lines: { wk: number; pts: number; opp: string }[] }>();
    if (!logs) return out;
    for (const [id, lines] of Object.entries(logs.players)) {
      const reg = lines.filter((l) => l.st === "regular").sort((a, b) => a.wk - b.wk);
      if (!reg.length) continue;
      const pts = reg.map((l) => ({ wk: l.wk, pts: dkPoints(l.s), opp: l.opp }));
      const sum = pts.reduce((a, b) => a + b.pts, 0);
      out.set(id, { games: pts.length, avg: round1(sum / pts.length), last: pts[pts.length - 1]?.pts, high: Math.max(...pts.map((p) => p.pts)), lines: pts });
    }
    return out;
  });

export interface PosAllowed {
  perGame: number;
  rank: number; // 1 = most DK points allowed to the position
  games: number;
}

/**
 * DK points each defense allows per game to QB, RB, WR, TE, from the game lines of the players who faced it. With
 * `lastN`, only each defense's last N regular-season games (the game page's "last 4" column).
 */
export const defenseVsPosition = (lastN?: number) =>
  memoSync(`dfs:dvp:${lastN ?? "season"}:${gamelogsStamp()}`, 3600, () => {
    const logs = genGamelogs();
    const players = new Map(genPlayers().map((p) => [p.id, p]));
    const sums = new Map<string, Record<DkPos, number>>();
    const games = new Map<string, Set<string>>();
    if (logs) {
      const byTeam = new Map<string, { gid: string; wk: number }[]>();
      for (const [gid, g] of Object.entries(logs.games)) {
        if (g.st !== "regular" || g.hp == null) continue;
        for (const t of [g.home, g.away]) (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push({ gid, wk: g.wk });
      }
      for (const [t, gs] of byTeam) games.set(t, new Set(gs.sort((a, b) => a.wk - b.wk).slice(lastN ? -lastN : 0).map((x) => x.gid)));
      for (const [id, lines] of Object.entries(logs.players)) {
        const pg = players.get(id)?.pg as DkPos | undefined;
        if (!pg || !DK_POS.includes(pg)) continue;
        for (const l of lines) {
          if (l.st !== "regular" || !games.get(l.opp)?.has(l.g)) continue;
          const row = sums.get(l.opp) ?? { QB: 0, RB: 0, WR: 0, TE: 0 };
          row[pg] += dkPoints(l.s);
          sums.set(l.opp, row);
        }
      }
    }
    const table = new Map<string, Record<DkPos, PosAllowed>>();
    const league: Record<DkPos, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pos of DK_POS) {
      const rows = [...sums.entries()].map(([team, r]) => ({ team, per: r[pos] / Math.max(1, games.get(team)?.size ?? 1), n: games.get(team)?.size ?? 0 }));
      rows.sort((a, b) => b.per - a.per);
      rows.forEach((r, i) => {
        const t = table.get(r.team) ?? ({} as Record<DkPos, PosAllowed>);
        t[pos] = { perGame: round1(r.per), rank: i + 1, games: r.n };
        table.set(r.team, t);
      });
      league[pos] = rows.length ? round1(rows.reduce((a, b) => a + b.per, 0) / rows.length) : 0;
    }
    return { table, league };
  });

/* ------------------------------------------------------------ props */

interface LineSummary { market: string; point?: number; books: number; over?: number; under?: number }

function propLine(rows: PropRow[] | undefined, name: string, market: string): LineSummary | undefined {
  if (!rows?.length) return undefined;
  const key = nameKey(name);
  const hit = rows.filter((r) => r.market === market && nameKey(r.player) === key);
  if (!hit.length) return undefined;
  const pts = hit.map((r) => r.point).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const mid = Math.floor(pts.length / 2);
  const point = pts.length ? (pts.length % 2 ? pts[mid] : (pts[mid - 1] + pts[mid]) / 2) : undefined;
  const dk = hit.find((r) => r.book === "draftkings");
  return { market, point, books: hit.length, over: dk?.overPrice, under: dk?.underPrice };
}

/* ------------------------------------------------------------ lenses */

export interface DfsPlay {
  id?: string;
  name: string;
  team: string;
  teamAbbr: string;
  opp: string;
  oppAbbr: string;
  pos: DfsPos;
  salary: number;
  slate: "classic" | "showdown";
  dkPpg?: number;
  avg?: number;
  games: number;
  last?: number;
  high?: number;
  proj: number;
  value: number; // projected points per $1,000
  oppRank?: number;
  oppAllowed?: number;
  snap?: number; // percent
  tshare?: number; // percent
  carries?: number; // per game
  targets?: number; // per game
  bump?: { from: string; status: string; pts: number; fresh: boolean };
  status?: string;
  prop?: LineSummary;
  why: string;
  gameId: string;
  kickoff: string;
  matchup: string;
}

export interface DefProp {
  id: string;
  name: string;
  team: string;
  teamAbbr: string;
  opp: string;
  oppAbbr: string;
  pos: string;
  kind: "tackles" | "pass rush";
  games: number;
  /** Pass rush: model chance (0-100) of half a sack or more this game, from pressures (PFR). */
  sackChance?: number;
  /** Pass rush: PFR pressures this season. */
  pressures?: number;
  tkpg: number;
  solopg: number;
  sacks: number;
  hits: number;
  ints: number;
  pds: number;
  snap?: number;
  oppPlays?: number;
  oppPlaysRank?: number;
  oppPressure?: number;
  oppPressureRank?: number;
  score: number;
  status?: string;
  line?: LineSummary;
  why: string;
  gameId: string;
  kickoff: string;
  matchup: string;
}

export interface GameDfs {
  gameId: string;
  plays: DfsPlay[];
  defense: DefProp[];
  vacancies: { team: string; name: string; pos: string; status: string; avg: number }[];
  source?: string;
  note?: string;
}

const POS_WORD: Record<DkPos, string> = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };

function teamContext() {
  return memoSync(`dfs:teams:${gamelogsStamp()}`, 3600, () => {
    const teams = genTeams().filter((t) => t.games);
    const plays = teams.map((t) => ({ team: t.team, v: t.off.plays / Math.max(1, t.games ?? 1) })).sort((a, b) => b.v - a.v);
    const press = teams.map((t) => ({ team: t.team, v: t.off.pressure ?? 0 })).sort((a, b) => b.v - a.v);
    const avgPlays = plays.reduce((a, b) => a + b.v, 0) / Math.max(1, plays.length);
    const avgPress = press.reduce((a, b) => a + b.v, 0) / Math.max(1, press.length);
    const byTeam = new Map<string, { plays: number; playsRank: number; pressure: number; pressureRank: number; rushRate?: number }>();
    for (const t of teams) {
      byTeam.set(t.team, {
        plays: round1(t.off.plays / Math.max(1, t.games ?? 1)),
        playsRank: plays.findIndex((p) => p.team === t.team) + 1,
        pressure: t.off.pressure ?? 0,
        pressureRank: press.findIndex((p) => p.team === t.team) + 1,
        rushRate: t.off.rushRate ?? undefined,
      });
    }
    return { byTeam, avgPlays, avgPress };
  });
}

/** Both teams' DraftKings plays and defensive prop names for one game. */
export async function gameDfs(game: GameLike): Promise<GameDfs> {
  const date = etDateOf(game.kickoff);
  const [dk, inj] = await Promise.all([dkSlate(date), espnInjuries()]);
  return buildGame(game, dk, new Map(inj.rows.map((r) => [r.id, r])));
}

function buildGame(game: GameLike, dk: DkSlate, espn: Map<string, EspnInjury>): GameDfs {
  const clocks = new Map([game.home.short, game.away.short].map((t) => [t, statusClock(t, game.kickoff)]));
  const statusAt = (p: GenPlayer | undefined, row: DkRow | undefined) => statusOf(p, row, p ? espn.get(p.id) : undefined, p ? clocks.get(p.t) : undefined);
  const players = genPlayers();
  const season = seasonDk();
  const { table, league } = defenseVsPosition();
  const ctx = teamContext();
  const props = findOddsFile(game.id)?.props?.rows;
  const kick = kickoffTime(game.kickoff);
  const matchup = `${game.away.abbr} at ${game.home.abbr}`;
  const sides = [
    { team: game.away, opp: game.home },
    { team: game.home, opp: game.away },
  ];
  const plays: DfsPlay[] = [];
  const defense: DefProp[] = [];
  const vacancies: GameDfs["vacancies"] = [];

  for (const { team, opp } of sides) {
    const roster = players.filter((p) => p.t === team.short);
    const dkRows = dk.rows.filter((r) => r.team === team.short);
    const dkByName = new Map(dkRows.map((r) => [nameKey(r.name), r]));
    const rosterByName = new Map(roster.map((p) => [nameKey(p.n), p]));

    // Out or Doubtful skill players with a real role: the next man up gets a share of his average, by position
    // (NEXT_MAN_UP_SHARE: backs 25%, tight ends 20%, receivers nothing), whether the absence is new or not.
    // A quarterback never adds points: the backup's own average is the projection, and the bump only marks him
    // as the starter.
    const teamLastWk = Math.max(0, ...roster.map((p) => season.get(p.id)?.lines.at(-1)?.wk ?? 0));
    const bumps = new Map<string, DfsPlay["bump"]>();
    for (const pos of DK_POS) {
      const group = roster.filter((p) => p.pg === pos);
      for (const p of group) {
        const st = statusAt(p, dkByName.get(nameKey(p.n)));
        const sd = season.get(p.id);
        if (!isOut(st) || !sd || sd.avg < 6) continue;
        vacancies.push({ team: team.short, name: p.n, pos, status: st!, avg: sd.avg });
        if (pos === "WR") continue; // a receiver's targets scatter: no measured lift for any one teammate
        const active = group
          .filter((q) => q.id !== p.id && !isOut(statusAt(q, dkByName.get(nameKey(q.n)))) && dkByName.has(nameKey(q.n)))
          .sort((a, b) => (a.dc?.rank ?? 99) - (b.dc?.rank ?? 99) || (b.u?.o ?? 0) - (a.u?.o ?? 0));
        const takers = active.slice(0, 1);
        const fresh = (sd.lines.at(-1)?.wk ?? 0) >= teamLastWk;
        const share = takers.length && pos !== "QB" ? round1(sd.avg * NEXT_MAN_UP_SHARE[pos]) : 0;
        for (const q of takers) {
          const prev = bumps.get(q.id);
          bumps.set(q.id, prev && prev.pts >= share ? prev : { from: p.n, status: st!, pts: share, fresh });
        }
      }
    }

    for (const row of dkRows) {
      if (!DK_POS.includes(row.pos as DkPos)) continue;
      const pos = row.pos as DkPos;
      const p = rosterByName.get(nameKey(row.name));
      const st = statusAt(p, row);
      if (isOut(st)) continue;
      // A backup quarterback only plays when the starter is out, and then he carries the bump.
      if (pos === "QB" && p?.dc && p.dc.rank > 1 && !bumps.has(p.id)) continue;
      const sd = p ? season.get(p.id) : undefined;
      // Last season per game from season totals (no 100- and 300-yard bonuses), blended in at 3 / (games + 3):
      // scripts/backtest-dfs.mjs on 2024 and 2025 (4,121 player-weeks) cut the miss from 6.72 to 6.59 DK points.
      const prior = p?.ps?.gp && p.ps.gp >= 4 ? dkPoints(p.ps) / p.ps.gp : undefined;
      let base: number | undefined;
      if (sd && prior !== undefined) base = (sd.avg * sd.games + prior * PRIOR_GAMES) / (sd.games + PRIOR_GAMES);
      else base = sd?.avg ?? prior ?? row.dkPpg;
      if (base === undefined) continue;
      // Half what he scored, half what his usage was worth (expected fantasy points, same last-season blend, on DK's scale).
      const usage = p ? usageWorth(p.id) : undefined;
      if (usage !== undefined) base = (1 - XFP_WEIGHT) * base + XFP_WEIGHT * usage.base;
      const allowed = table.get(opp.short)?.[pos];
      const factor = allowed && league[pos] ? Math.min(1.35, Math.max(0.7, allowed.perGame / league[pos])) : 1;
      const bump = p ? bumps.get(p.id) : undefined;
      const proj = round1(base * (1 + MATCHUP_WEIGHT * (factor - 1)) + (bump?.pts ?? 0));
      const gp = p?.s?.gp ?? sd?.games ?? 0;
      const snap = pct(p?.u?.o);
      const tshare = pct(p?.s?.tshare);
      const carries = gp && p?.s?.ra ? round1(p.s.ra / gp) : undefined;
      const targets = gp && p?.s?.tgt ? round1(p.s.tgt / gp) : undefined;

      const bits: string[] = [];
      if (sd) bits.push(`${sd.avg} DK pts a game over ${sd.games}${sd.last !== undefined ? ` (${sd.last} last time out)` : ""}${prior !== undefined ? `, ${round1(prior)} last season` : ""}`);
      if (sd && usage) {
        const gap = round1(sd.avg - usage.now);
        if (gap >= 3) bits.push(`scoring ${gap} a game above what his usage is worth (${usage.now}), the kind of gap touchdowns tend to close`);
        else if (gap <= -3) bits.push(`his usage is worth ${usage.now} a game, ${Math.abs(gap)} more than he has scored`);
      }
      const adv = p ? advPhrase(p.id, pos) : undefined;
      if (adv) bits.push(adv);
      else if (prior !== undefined) bits.push(`${round1(prior)} DK pts a game last season, no 2026 line yet`);
      if (pos === "RB" && (carries || targets)) bits.push(`${plural(carries ?? 0, "carry", "carries")} and ${plural(targets ?? 0, "target")} a game${snap ? `, ${snap}% of snaps` : ""}`);
      else if ((pos === "WR" || pos === "TE") && tshare) bits.push(`${tshare}% target share${snap ? `, ${snap}% of snaps` : ""}`);
      else if (pos === "QB" && gp && p?.s?.ry) bits.push(`${round1(p.s.ry / gp)} rush yards a game`);
      if (allowed) {
        if (allowed.rank <= 10) bits.push(`${opp.short} allow ${allowed.perGame} DK pts a game to ${POS_WORD[pos]}, ${ordinal(allowed.rank)} most`);
        else if (allowed.rank >= 23) bits.push(`${opp.short} allow ${allowed.perGame} DK pts a game to ${POS_WORD[pos]}, ${ordinal(33 - allowed.rank)} fewest`);
      }
      if (bump) bits.push(pos === "QB" ? `starts for ${bump.from} (${bump.status})` : `${bump.from} is ${bump.status}: +${bump.pts} for the next man up, a tournament angle (backups usually gain little, sometimes a lot)`);
      if (st) bits.push(st);

      const market = pos === "QB" ? "player_pass_yds" : pos === "RB" ? "player_rush_yds" : "player_reception_yds";
      plays.push({
        id: p?.id,
        name: p?.n ?? row.name,
        team: team.short,
        teamAbbr: team.abbr,
        opp: opp.short,
        oppAbbr: opp.abbr,
        pos,
        salary: row.salary,
        slate: row.slate,
        dkPpg: row.dkPpg,
        avg: sd?.avg,
        games: sd?.games ?? 0,
        last: sd?.last,
        high: sd?.high,
        proj,
        value: round1(proj / (row.salary / 1000)),
        oppRank: allowed?.rank,
        oppAllowed: allowed?.perGame,
        snap,
        tshare,
        carries,
        targets,
        bump,
        status: st,
        prop: propLine(props, p?.n ?? row.name, market) ?? propLine(props, row.name, market),
        why: bits.join("; "),
        gameId: game.id,
        kickoff: kick,
        matchup,
      });
    }

    // The team defense: sacks, takeaways, TDs, and points allowed against the opponent's implied total.
    const dstRow = dkRows.find((r) => r.pos === "DST");
    // The spread is filed under the favorite's abbreviation: the home ABBREVIATION decides the sign (passing the nickname
    // swapped the two totals whenever the home team was favored).
    const implied = impliedTotals(game.home.abbr, game.market?.spread, game.market?.total?.line);
    const d = dstRow ? dstProjection(team.short, opp.short, implied ? (opp.short === game.home.short ? implied.home : implied.away) : undefined) : undefined;
    if (dstRow && d) {
      plays.push({
        name: `${team.short} DST`,
        team: team.short,
        teamAbbr: team.abbr,
        opp: opp.short,
        oppAbbr: opp.abbr,
        pos: "DST",
        salary: dstRow.salary,
        slate: dstRow.slate,
        dkPpg: dstRow.dkPpg,
        games: genTeams().find((x) => x.team === team.short)?.dst?.now?.g ?? 0,
        proj: d.proj,
        value: round1(d.proj / (dstRow.salary / 1000)),
        why: `${d.sacks} sacks and ${d.takeaways} takeaways expected; the ${opp.short} are implied for ${d.oppImplied} points${d.lined ? "" : " (league average: no posted line)"}, worth ${d.paPoints} on the points-allowed scale`,
        gameId: game.id,
        kickoff: kick,
        matchup,
      });
    }

    // Defensive names for props: tackle volume against play volume, pass rush against pressure allowed.
    const oc = ctx.byTeam.get(opp.short);
    for (const p of roster) {
      if (!p.pg || !["DL", "LB", "DB"].includes(p.pg) || !p.s) continue;
      const gp = p.s.gp ?? 0;
      if (gp < 2 || (p.u?.d ?? 0) < 0.5) continue;
      const st = statusAt(p, undefined);
      if (isOut(st)) continue;
      const tk = p.s.tk ?? (p.s.solo ?? 0) + (p.s.ast ?? 0) + (p.s.tast ?? 0);
      const tkpg = round1(tk / gp);
      const solopg = round1((p.s.solo ?? 0) / gp);
      const sacks = p.s.sk ?? 0;
      const hits = p.s.hur ?? 0;
      const base = {
        id: p.id,
        name: p.n,
        team: team.short,
        teamAbbr: team.abbr,
        opp: opp.short,
        oppAbbr: opp.abbr,
        pos: p.p ?? p.pg,
        games: gp,
        tkpg,
        solopg,
        sacks,
        hits,
        ints: p.s.int ?? 0,
        pds: p.s.pd ?? 0,
        snap: pct(p.u?.d),
        oppPlays: oc?.plays,
        oppPlaysRank: oc?.playsRank,
        oppPressure: oc ? pct(oc.pressure) : undefined,
        oppPressureRank: oc?.pressureRank,
        status: st,
        gameId: game.id,
        kickoff: kick,
        matchup,
      };
      // PFR charting this season (pressures, missed tackles); absent until PFR posts the weeks.
      const pfr = genExtras()?.players[p.id]?.adv?.[String(genExtras()!.season)]?.def;
      if (tkpg >= 5) {
        const mtk = pfr?.mtk !== undefined && pfr.tk ? `${plural(pfr.mtk, "missed tackle")} on ${pfr.tk + pfr.mtk} chances (PFR)` : "";
        const why = [`${tkpg} tackles a game (${solopg} solo) over ${gp}`, base.snap ? `${base.snap}% of snaps` : "", mtk]
          .concat(oc ? [`${opp.short} run ${oc.plays} plays a game, ${ordinal(oc.playsRank)} most${oc.rushRate && oc.rushRate >= 0.45 ? `, and run it ${pct(oc.rushRate)}% of the time` : ""}`] : [])
          .filter(Boolean);
        defense.push({ ...base, kind: "tackles", score: round1(tkpg * (oc ? oc.plays / ctx.avgPlays : 1)), line: propLine(props, p.n, "player_tackles_assists"), why: why.join("; ") + (st ? `; ${st}` : "") });
      }
      // Pass rush: pressures predict next week's sacks better than sacks do (scripts/backtest-pressure.mjs, 2022 to
      // 2025, 12,394 rusher-weeks: Brier on "half a sack or more" 0.196 from sacks, 0.179 from pressures at the league
      // sacks-per-pressure rate with the opponent's pressure allowed at half weight). Falls back to QB hits before PFR posts.
      const press = pfr?.press ?? 0;
      const pfrGames = pfr?.g ?? 0;
      const usePress = pfrGames >= 2 && press >= 2;
      if (usePress || hits / gp >= 1 || sacks >= 2) {
        const oppF = oc && ctx.avgPress ? Math.min(1.3, Math.max(0.75, oc.pressure / ctx.avgPress)) : 1;
        const rate = usePress ? (press / pfrGames) * sackPerPressure() * (1 + 0.5 * (oppF - 1)) : undefined;
        const chance = rate !== undefined ? Math.round((1 - Math.exp(-rate)) * 100) : undefined;
        const why = [
          usePress ? `${plural(press, "pressure")} in ${pfrGames} games charted by PFR; ${plural(sacks, "sack")} in ${gp}` : `${plural(sacks, "sack")} and ${plural(hits, "QB hit")} in ${gp} games`,
          base.snap ? `${base.snap}% of snaps` : "",
          chance !== undefined ? `${chance}% chance of half a sack or more by our model (not tested against book prices)` : "",
        ]
          .concat(oc ? [`${opp.short} allow pressure on ${pct(oc.pressure)}% of dropbacks, ${ordinal(oc.pressureRank)} most`] : [])
          .filter(Boolean);
        const score = Math.round((rate ?? (hits / gp) * (oc && ctx.avgPress ? oc.pressure / ctx.avgPress : 1) * 0.1) * 100) / 100;
        defense.push({ ...base, kind: "pass rush", score, sackChance: chance, pressures: usePress ? press : undefined, line: propLine(props, p.n, "player_sacks"), why: why.join("; ") + (st ? `; ${st}` : "") });
      }
    }
  }

  plays.sort((a, b) => b.proj - a.proj);
  defense.sort((a, b) => b.score - a.score);
  const gameRows = dk.rows.filter((r) => r.team === game.home.short || r.team === game.away.short);
  const slate = gameRows[0]?.slate;
  const group = dk.groups.find((g) => g.id === gameRows[0]?.group);
  return {
    gameId: game.id,
    plays,
    defense,
    vacancies,
    source: slate ? `DraftKings ${slate === "classic" ? "Classic" : "Showdown FLEX"} salaries${group ? `, draft group ${group.id}` : ""}, pulled ${new Date(dk.fetchedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET` : undefined,
    note: !gameRows.length ? (dk.error ?? "DraftKings has no salaries for this game yet.") : undefined,
  };
}

/** Every play on a date's main Classic slate (skill players and defenses), for the simulator. Empty with a note when there is no Classic slate. */
export async function classicPool(date: string, games: GameLike[]): Promise<{ plays: DfsPlay[]; fetchedAt: string; source?: string; note?: string }> {
  const [dk, inj] = await Promise.all([dkSlate(date), espnInjuries()]);
  const classic = dk.groups.find((g) => g.slate === "classic");
  if (!classic) return { plays: [], fetchedAt: dk.fetchedAt, note: dk.error ?? "DraftKings has no Classic slate posted for this date yet." };
  const espn = new Map(inj.rows.map((r) => [r.id, r]));
  const plays = games.flatMap((g) => buildGame(g, dk, espn).plays).filter((p) => p.slate === "classic");
  return { plays, fetchedAt: dk.fetchedAt, source: `DraftKings ${classic.label}, ${classic.games} games, salaries pulled ${new Date(dk.fetchedAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })} ET` };
}

/** The slate view: best DraftKings values and the strongest defensive prop names across a date's games. */
export interface ShowdownGame {
  matchup: string;
  kickoff: string;
  plays: DfsPlay[];
}

export async function slateDfs(date: string, games: GameLike[]): Promise<{ plays: DfsPlay[]; showdown: ShowdownGame[]; tackles: DefProp[]; rush: DefProp[]; note?: string; source?: string }> {
  if (!games.length) return { plays: [], showdown: [], tackles: [], rush: [] };
  const [dk, inj] = await Promise.all([dkSlate(date), espnInjuries()]);
  const espn = new Map(inj.rows.map((r) => [r.id, r]));
  const all = games.map((g) => buildGame(g, dk, espn));
  const usable = (p: DfsPlay) => p.proj >= 10 && (p.games >= 2 || Boolean(p.bump));
  // Showdown salaries run on a higher scale than Classic, so those games get their own line instead of a value rank.
  const hasClassic = all.some((g) => g.plays.some((p) => p.slate === "classic"));
  const plays = all
    .flatMap((g) => g.plays)
    .filter((p) => usable(p) && (!hasClassic || p.slate === "classic"))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const showdown: ShowdownGame[] = hasClassic
    ? all
        .filter((g) => g.plays.length && g.plays.every((p) => p.slate === "showdown"))
        .map((g) => {
          // Top three by projection, plus any next man up (the angle a Showdown slate turns on), five at most.
          const top = g.plays.filter(usable).slice(0, 3);
          const nextUp = g.plays.filter((p) => usable(p) && p.bump && !top.includes(p));
          return { matchup: g.plays[0].matchup, kickoff: g.plays[0].kickoff, plays: [...top, ...nextUp].slice(0, 5) };
        })
        .filter((g) => g.plays.length)
    : [];
  const def = all.flatMap((g) => g.defense);
  const tackles = def.filter((d) => d.kind === "tackles").sort((a, b) => b.score - a.score).slice(0, 6);
  const rush = def.filter((d) => d.kind === "pass rush").sort((a, b) => b.score - a.score).slice(0, 6);
  const classic = dk.groups.find((g) => g.slate === "classic");
  return {
    plays,
    showdown,
    tackles,
    rush,
    note: dk.rows.length ? undefined : (dk.error ?? "DraftKings has no salaries for this date yet."),
    source: dk.rows.length ? `DraftKings ${classic ? `${classic.label}, ${classic.games} games` : "Showdown"}${dk.groups.some((g) => g.slate === "showdown") && classic ? ", plus Showdown FLEX for games outside it" : ""}` : undefined,
  };
}
