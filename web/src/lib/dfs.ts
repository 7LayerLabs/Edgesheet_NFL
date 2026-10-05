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
 * plus half of an Out or Doubtful teammate's average handed to the next man up.
 *
 * Defenses (DST): src/lib/dst.ts, from the defense's and the opponent's sack and turnover rates and the market's implied
 * opponent total (backtested in scripts/build-dfs-sim.mjs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kickoffTime } from "./format";
import { genGamelogs, genPlayers, genSchedule, genTeams, gamelogsStamp, type GenPlayer, type StatLine } from "./generated";
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

/** DK points each defense allows per game to QB, RB, WR, TE, from the game lines of the players who faced it. */
export const defenseVsPosition = () =>
  memoSync(`dfs:dvp:${gamelogsStamp()}`, 3600, () => {
    const logs = genGamelogs();
    const players = new Map(genPlayers().map((p) => [p.id, p]));
    const sums = new Map<string, Record<DkPos, number>>();
    const games = new Map<string, Set<string>>();
    if (logs) {
      for (const [gid, g] of Object.entries(logs.games)) {
        if (g.st !== "regular" || g.hp == null) continue;
        for (const t of [g.home, g.away]) games.set(t, (games.get(t) ?? new Set()).add(gid));
      }
      for (const [id, lines] of Object.entries(logs.players)) {
        const pg = players.get(id)?.pg as DkPos | undefined;
        if (!pg || !DK_POS.includes(pg)) continue;
        for (const l of lines) {
          if (l.st !== "regular") continue;
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

    // Out or Doubtful skill players with a real role: half their production goes to the next man up,
    // but only when the absence is new (he played the team's last game). When he already sat, the
    // backup's average already carries the bigger role, so the note stays and the points do not.
    // A quarterback never adds points: the backup's own average is the projection.
    const teamLastWk = Math.max(0, ...roster.map((p) => season.get(p.id)?.lines.at(-1)?.wk ?? 0));
    const bumps = new Map<string, DfsPlay["bump"]>();
    for (const pos of DK_POS) {
      const group = roster.filter((p) => p.pg === pos);
      for (const p of group) {
        const st = statusAt(p, dkByName.get(nameKey(p.n)));
        const sd = season.get(p.id);
        if (!isOut(st) || !sd || sd.avg < 6) continue;
        vacancies.push({ team: team.short, name: p.n, pos, status: st!, avg: sd.avg });
        const active = group
          .filter((q) => q.id !== p.id && !isOut(statusAt(q, dkByName.get(nameKey(q.n)))) && dkByName.has(nameKey(q.n)))
          .sort((a, b) => (a.dc?.rank ?? 99) - (b.dc?.rank ?? 99) || (b.u?.o ?? 0) - (a.u?.o ?? 0));
        const takers = pos === "WR" ? active.slice(0, 3) : active.slice(0, 1);
        const fresh = (sd.lines.at(-1)?.wk ?? 0) >= teamLastWk;
        const share = takers.length && fresh && pos !== "QB" ? round1((sd.avg * 0.5) / takers.length) : 0;
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
      else if (prior !== undefined) bits.push(`${round1(prior)} DK pts a game last season, no 2026 line yet`);
      if (pos === "RB" && (carries || targets)) bits.push(`${plural(carries ?? 0, "carry", "carries")} and ${plural(targets ?? 0, "target")} a game${snap ? `, ${snap}% of snaps` : ""}`);
      else if ((pos === "WR" || pos === "TE") && tshare) bits.push(`${tshare}% target share${snap ? `, ${snap}% of snaps` : ""}`);
      else if (pos === "QB" && gp && p?.s?.ry) bits.push(`${round1(p.s.ry / gp)} rush yards a game`);
      if (allowed) {
        if (allowed.rank <= 10) bits.push(`${opp.short} allow ${allowed.perGame} DK pts a game to ${POS_WORD[pos]}, ${ordinal(allowed.rank)} most`);
        else if (allowed.rank >= 23) bits.push(`${opp.short} allow ${allowed.perGame} DK pts a game to ${POS_WORD[pos]}, ${ordinal(33 - allowed.rank)} fewest`);
      }
      if (bump) bits.push(pos === "QB" ? `starts for ${bump.from} (${bump.status})` : bump.pts ? `${bump.from} is ${bump.status}: +${bump.pts} for the next man up` : `${bump.from} is ${bump.status} again (also missed the last game)`);
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
    const implied = impliedTotals(game.home.short, game.market?.spread, game.market?.total?.line);
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
      if (tkpg >= 5) {
        const why = [`${tkpg} tackles a game (${solopg} solo) over ${gp}`, base.snap ? `${base.snap}% of snaps` : ""]
          .concat(oc ? [`${opp.short} run ${oc.plays} plays a game, ${ordinal(oc.playsRank)} most${oc.rushRate && oc.rushRate >= 0.45 ? `, and run it ${pct(oc.rushRate)}% of the time` : ""}`] : [])
          .filter(Boolean);
        defense.push({ ...base, kind: "tackles", score: round1(tkpg * (oc ? oc.plays / ctx.avgPlays : 1)), line: propLine(props, p.n, "player_tackles_assists"), why: why.join("; ") + (st ? `; ${st}` : "") });
      }
      if (hits / gp >= 1 || sacks >= 2) {
        const why = [`${plural(sacks, "sack")} and ${plural(hits, "QB hit")} in ${gp} games`, base.snap ? `${base.snap}% of snaps` : ""]
          .concat(oc ? [`${opp.short} allow pressure on ${pct(oc.pressure)}% of dropbacks, ${ordinal(oc.pressureRank)} most`] : [])
          .filter(Boolean);
        defense.push({ ...base, kind: "pass rush", score: round1((hits / gp) * (oc && ctx.avgPress ? oc.pressure / ctx.avgPress : 1)), line: propLine(props, p.n, "player_sacks"), why: why.join("; ") + (st ? `; ${st}` : "") });
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
