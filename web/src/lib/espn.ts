/**
 * ESPN public JSON (no key): live scores, clock, situation, win probability,
 * drives, scoring plays, and box score players for NFL games.
 *
 * Game ids are the `espn` column of the nflverse schedule and athlete ids are
 * nflverse espn_id, so the sources join on id with no name matching. Nothing here is invented: every
 * field below is read from a response or is undefined.
 *
 * Verified 2026-10-03 against live games:
 *   scoreboard?groups=80|81&dates=YYYYMMDD -> events[].status.{type.state,period,displayClock},
 *     competitions[0].{competitors[].{homeAway,score,team.{id,abbreviation}},situation,broadcasts}
 *   situation carries lastPlay.{text,probability.homeWinPercentage}, down, distance, yardLine,
 *     downDistanceText, possessionText, possession (team id, sometimes missing). homeWinProbability
 *     is NOT on the scoreboard; the current win prob lives in situation.lastPlay.probability.
 *   summary?event=<id> -> boxscore.players, drives.{previous,current}, winprobability[] (one row per
 *     play id, joined to drives[].plays for period and clock), scoringPlays, leaders, header.
 */
import { memo } from "./memo";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

/* ------------------------------------------------------------ raw shapes */

interface EspnTeamRef {
  id: string;
  abbreviation?: string;
  displayName?: string;
  shortDisplayName?: string;
  logo?: string;
  color?: string;
}

interface EspnCompetitor {
  id: string;
  homeAway: "home" | "away";
  score?: string;
  winner?: boolean;
  team: EspnTeamRef;
  linescores?: { value: number; displayValue?: string; period: number }[];
}

interface EspnStatus {
  clock?: number;
  displayClock?: string;
  period?: number;
  type: { id: string; name: string; state: "pre" | "in" | "post"; completed: boolean; description: string; detail: string; shortDetail: string };
}

interface EspnSituation {
  lastPlay?: {
    id?: string;
    text?: string;
    team?: { id: string };
    probability?: { homeWinPercentage?: number; awayWinPercentage?: number; secondsLeft?: number };
  };
  down?: number;
  distance?: number;
  yardLine?: number;
  isRedZone?: boolean;
  homeTimeouts?: number;
  awayTimeouts?: number;
  downDistanceText?: string;
  shortDownDistanceText?: string;
  possessionText?: string;
  possession?: string;
}

interface EspnEvent {
  id: string;
  date: string;
  name: string;
  shortName: string;
  status: EspnStatus;
  competitions: {
    competitors: EspnCompetitor[];
    situation?: EspnSituation;
    broadcasts?: { market?: string; names?: string[] }[];
    broadcast?: string;
    status?: EspnStatus;
  }[];
}

interface EspnScoreboard {
  events?: EspnEvent[];
}

interface EspnPlay {
  id: string;
  text?: string;
  period?: { number: number };
  clock?: { displayValue?: string; value?: number };
  homeScore?: number;
  awayScore?: number;
  scoringPlay?: boolean;
  type?: { text?: string; abbreviation?: string };
  team?: EspnTeamRef;
}

interface EspnDrive {
  id: string;
  description?: string;
  team?: EspnTeamRef;
  start?: { period?: { number: number }; clock?: { displayValue?: string }; yardLine?: number; text?: string };
  end?: { period?: { number: number }; clock?: { displayValue?: string }; yardLine?: number; text?: string };
  timeElapsed?: { displayValue?: string };
  yards?: number;
  isScore?: boolean;
  offensivePlays?: number;
  result?: string;
  shortDisplayResult?: string;
  displayResult?: string;
  plays?: EspnPlay[];
}

interface EspnSummary {
  header?: { competitions?: { status?: EspnStatus; competitors?: EspnCompetitor[]; situation?: EspnSituation }[] };
  boxscore?: {
    players?: {
      team: EspnTeamRef;
      homeAway?: "home" | "away";
      statistics: { name: string; keys: string[]; labels?: string[]; athletes: { athlete: { id: string; displayName: string; shortName?: string; jersey?: string }; stats: string[] }[] }[];
    }[];
    teams?: { team: EspnTeamRef; homeAway?: "home" | "away" }[];
  };
  drives?: { previous?: EspnDrive[]; current?: EspnDrive };
  winprobability?: { homeWinPercentage: number; tiePercentage?: number; playId: string }[];
  scoringPlays?: EspnPlay[];
  broadcasts?: { names?: string[] }[];
}

/* ------------------------------------------------------------ public types */

export type LiveState = "pre" | "in" | "post";

export interface LiveGame {
  id: string;
  state: LiveState;
  period: number;
  /** Display clock, "4:12". Empty at halftime or final. */
  clock: string;
  /** Short status for the pill: "2nd 4:12", "Halftime", "Final", "Final/OT". */
  detail: string;
  home: { id: string; abbr: string; score: number | null; winner?: boolean };
  away: { id: string; abbr: string; score: number | null; winner?: boolean };
  /** Abbreviation of the team with the ball, when the feed says. */
  possession?: string;
  down?: number;
  distance?: number;
  yardLine?: number;
  /** "2nd & 10 at AUB 33" exactly as the feed phrases it. */
  downDistance?: string;
  possessionText?: string;
  redZone?: boolean;
  lastPlay?: string;
  homeWinProb?: number;
  awayWinProb?: number;
  /** Change in home win probability over the last 10 to 15 minutes of readings, in probability points (-1..1). */
  swing?: number;
  /** How far the readings go back, in minutes, so the UI can say "last 12 min". */
  swingMinutes?: number;
  /** 0 (decided) to 1 (coin flip), from the current home win probability. */
  closeness?: number;
  broadcast?: string;
  asOf: string;
}

export interface LiveBoxLeader {
  id: string;
  name: string;
  category: string;
  headline: string;
  yards: number;
}

export interface LiveSummary {
  id: string;
  state: LiveState;
  detail: string;
  home: { id: string; abbr: string; score: number | null; linescores?: number[] };
  away: { id: string; abbr: string; score: number | null; linescores?: number[] };
  situation?: { downDistance?: string; possession?: string; lastPlay?: string; redZone?: boolean };
  /** Home win probability after each play, with the clock for the x axis. */
  winProb: { x: number; period: number; clock: string; home: number; scoring?: boolean; text?: string }[];
  scoringPlays: { period: number; clock: string; team: string; type: string; text: string; home: number; away: number }[];
  drives: {
    team: string;
    result: string;
    resultShort: string;
    plays: number;
    yards: number;
    time: string;
    start: string;
    end: string;
    period: number;
    clock: string;
    score: boolean;
    current?: boolean;
  }[];
  /** Box score leaders per side, in the same shape the nflverse box uses. */
  box: { homeAway: "home" | "away"; abbr: string; leaders: LiveBoxLeader[] }[];
  /** Every player's lines keyed by ESPN athlete id. */
  byPlayer: Record<string, { category: string; headline: string }[]>;
  playersSeen: number;
  /** Raw per-player stat rows (ESPN keys) so boxscore.ts can grade a final before nflverse posts the weekly file. */
  lines: { id: string; name: string; homeAway: "home" | "away"; category: string; stats: Record<string, string> }[];
  broadcast?: string;
  asOf: string;
}

/* ----------------------------------------------------------- ring buffer */

/** Win probability readings per game for the last 30 minutes, in process. Seeds the swing on the slate. */
const readings = new Map<string, { t: number; home: number }[]>();
const KEEP_MS = 30 * 60 * 1000;
const SWING_WINDOW_MS = 15 * 60 * 1000;
const SWING_MIN_MS = 2 * 60 * 1000;

function record(id: string, home: number, t: number) {
  const arr = readings.get(id) ?? [];
  const last = arr[arr.length - 1];
  // One reading per fetch; skip duplicates inside the same 20 seconds.
  if (last && t - last.t < 20_000) return;
  arr.push({ t, home });
  while (arr.length && t - arr[0].t > KEEP_MS) arr.shift();
  readings.set(id, arr);
}

/** Change in home win probability from the reading closest to 15 minutes ago. Needs at least 2 minutes of history. */
export function swingFor(id: string, now = Date.now()): { swing: number; minutes: number } | undefined {
  const arr = readings.get(id);
  if (!arr || arr.length < 2) return undefined;
  const cur = arr[arr.length - 1];
  const target = now - SWING_WINDOW_MS;
  let base = arr[0];
  for (const r of arr) {
    if (Math.abs(r.t - target) < Math.abs(base.t - target)) base = r;
  }
  if (cur.t - base.t < SWING_MIN_MS) return undefined;
  return { swing: cur.home - base.home, minutes: Math.round((cur.t - base.t) / 60_000) };
}

export function closenessOf(homeWinProb: number): number {
  return Math.max(0, 1 - Math.abs(homeWinProb - 0.5) * 2);
}

/* ---------------------------------------------------------------- fetch */

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : n === 4 ? "4th" : n === 5 ? "OT" : `${n - 4}OT`);

function detailFor(st: EspnStatus): string {
  const state = st.type.state;
  const period = st.period ?? 0;
  if (state === "post") return period > 4 ? "Final/OT" : "Final";
  if (state === "pre") return "Scheduled";
  const name = st.type.name;
  if (name === "STATUS_HALFTIME" || /halftime/i.test(st.type.shortDetail)) return "Halftime";
  if (name === "STATUS_END_PERIOD" || /^end/i.test(st.type.shortDetail)) return `End ${ordinal(period)}`;
  if (name === "STATUS_DELAYED") return "Delayed";
  const clock = st.displayClock ?? "";
  return `${ordinal(period)} ${clock}`.trim();
}

/** Quarter scores. The summary header sometimes carries only displayValue, so read both. */
function lineVals(ls: EspnCompetitor["linescores"]): number[] | undefined {
  if (!ls?.length) return undefined;
  const vals = ls.map((l) => (typeof l.value === "number" ? l.value : num(l.displayValue)));
  return vals.some((v) => v != null) ? vals.map((v) => v ?? 0) : undefined;
}

const num = (s: string | undefined | null): number | null => (s == null || s === "" || Number.isNaN(Number(s)) ? null : Number(s));

function toLive(e: EspnEvent, now: number): LiveGame | undefined {
  const comp = e.competitions?.[0];
  if (!comp) return undefined;
  const st = comp.status ?? e.status;
  const homeC = comp.competitors.find((c) => c.homeAway === "home");
  const awayC = comp.competitors.find((c) => c.homeAway === "away");
  if (!homeC || !awayC) return undefined;
  const s = comp.situation;
  const state = st.type.state;
  const prob = s?.lastPlay?.probability;
  let homeWinProb: number | undefined = state === "in" && typeof prob?.homeWinPercentage === "number" ? prob.homeWinPercentage : undefined;
  if (state === "post") homeWinProb = homeC.winner ? 1 : awayC.winner ? 0 : undefined;
  const possession = s?.possession ? (s.possession === homeC.team.id ? homeC.team.abbreviation : s.possession === awayC.team.id ? awayC.team.abbreviation : undefined) : undefined;
  const bc = comp.broadcasts?.find((b) => b.names?.length)?.names?.[0] ?? comp.broadcast ?? undefined;
  if (state === "in" && homeWinProb !== undefined) record(e.id, homeWinProb, now);
  const sw = state === "in" ? swingFor(e.id, now) : undefined;
  const down = s?.down != null && s.down > 0 ? s.down : undefined;
  return {
    id: e.id,
    state,
    period: st.period ?? 0,
    clock: state === "in" ? st.displayClock ?? "" : "",
    detail: detailFor(st),
    home: { id: homeC.team.id, abbr: homeC.team.abbreviation ?? "HOME", score: num(homeC.score), winner: homeC.winner },
    away: { id: awayC.team.id, abbr: awayC.team.abbreviation ?? "AWAY", score: num(awayC.score), winner: awayC.winner },
    possession,
    down,
    distance: down ? s?.distance : undefined,
    yardLine: s?.yardLine,
    downDistance: s?.downDistanceText,
    possessionText: s?.possessionText,
    redZone: s?.isRedZone,
    lastPlay: s?.lastPlay?.text,
    homeWinProb,
    awayWinProb: homeWinProb === undefined ? undefined : 1 - homeWinProb,
    swing: sw?.swing,
    swingMinutes: sw?.minutes,
    closeness: homeWinProb === undefined ? undefined : closenessOf(homeWinProb),
    broadcast: bc,
    asOf: new Date(now).toISOString(),
  };
}

/** ESPN wants YYYYMMDD. Accepts YYYY-MM-DD too. */
export function espnDate(date: string): string {
  return date.replace(/-/g, "").slice(0, 8);
}

/**
 * Every FBS and FCS game on the date, keyed by game id (the CFBD id). Memoized
 * 30 seconds, so a 60-second poll never fetches more than twice a minute.
 * Returns an empty map when ESPN does not answer, never throws.
 */
export function liveScoreboard(dateYYYYMMDD: string): Promise<Map<string, LiveGame>> {
  const d = espnDate(dateYYYYMMDD);
  return memo(`espn:sb:${d}`, 30, async () => {
    const now = Date.now();
    const pages = await Promise.all([getJson<EspnScoreboard>(`${BASE}/scoreboard?limit=100&dates=${d}`)]);
    const out = new Map<string, LiveGame>();
    for (const page of pages) {
      for (const e of page?.events ?? []) {
        const lg = toLive(e, now);
        if (lg) out.set(lg.id, lg);
      }
    }
    return out;
  });
}

/** One game's live row, or undefined when ESPN has no event with that id on that date. */
export async function liveGame(gameId: string, dateYYYYMMDD: string): Promise<LiveGame | undefined> {
  const m = await liveScoreboard(dateYYYYMMDD);
  return m.get(String(gameId));
}

/* -------------------------------------------------------------- summary */

const n0 = (v: string | undefined) => Number(v ?? 0) || 0;

/** Headline in the same voice as the nflverse box (src/lib/boxscore.ts) so the UI does not change by source. */
function headline(category: string, keys: string[], stats: string[]): { text: string; yards: number } | undefined {
  const get = (k: string) => stats[keys.indexOf(k)];
  switch (category) {
    case "passing": {
      const yds = n0(get("passingYards"));
      return { text: `${get("completions/passingAttempts") ?? ""}, ${yds} yds, ${n0(get("passingTouchdowns"))} TD, ${n0(get("interceptions"))} INT`, yards: yds };
    }
    case "rushing": {
      const yds = n0(get("rushingYards"));
      return { text: `${n0(get("rushingAttempts"))} car, ${yds} yds, ${n0(get("rushingTouchdowns"))} TD`, yards: yds };
    }
    case "receiving": {
      const yds = n0(get("receivingYards"));
      return { text: `${n0(get("receptions"))} rec, ${yds} yds, ${n0(get("receivingTouchdowns"))} TD`, yards: yds };
    }
    case "defensive": {
      const tot = n0(get("totalTackles"));
      const tfl = n0(get("tacklesForLoss"));
      const sacks = n0(get("sacks"));
      const pd = n0(get("passesDefended"));
      return { text: `${tot} tkl, ${tfl} TFL, ${sacks} sacks${pd ? `, ${pd} PD` : ""}`, yards: tot * 8 + tfl * 15 + sacks * 25 };
    }
    case "interceptions": {
      const ints = n0(get("interceptions"));
      return { text: `${ints} INT, ${n0(get("interceptionYards"))} yds`, yards: ints * 40 };
    }
    default:
      return undefined;
  }
}

function clockSeconds(display: string | undefined): number {
  const m = (display ?? "").match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Seconds of game time elapsed, for the win probability x axis. Overtime periods count 10 minutes each for spacing only. */
function elapsed(period: number, clock: string | undefined): number {
  const q = Math.max(1, period);
  const left = clockSeconds(clock);
  if (q <= 4) return (q - 1) * 900 + (900 - left);
  return 3600 + (q - 5) * 600 + 300;
}

function toSummary(id: string, s: EspnSummary, now: number): LiveSummary | undefined {
  const comp = s.header?.competitions?.[0];
  const homeC = comp?.competitors?.find((c) => c.homeAway === "home");
  const awayC = comp?.competitors?.find((c) => c.homeAway === "away");
  if (!comp || !homeC || !awayC || !comp.status) return undefined;
  const st = comp.status;
  const abbrOf = (t: EspnTeamRef | undefined) => (t?.id === homeC.team.id ? homeC.team.abbreviation : t?.id === awayC.team.id ? awayC.team.abbreviation : t?.abbreviation) ?? "";

  // Plays by id, to put a clock on each win probability row.
  const plays = new Map<string, EspnPlay>();
  const allDrives = [...(s.drives?.previous ?? []), ...(s.drives?.current ? [s.drives.current] : [])];
  for (const d of allDrives) for (const p of d.plays ?? []) plays.set(p.id, p);

  const winProb = (s.winprobability ?? [])
    .map((w) => {
      const p = plays.get(w.playId);
      const period = p?.period?.number ?? 0;
      const clock = p?.clock?.displayValue ?? "";
      return { x: p ? elapsed(period, clock) : -1, period, clock, home: w.homeWinPercentage, scoring: p?.scoringPlay || undefined, text: p?.scoringPlay ? p.text : undefined };
    })
    .filter((r) => r.x >= 0);

  const scoringPlays = (s.scoringPlays ?? []).map((p) => ({
    period: p.period?.number ?? 0,
    clock: p.clock?.displayValue ?? "",
    team: abbrOf(p.team),
    type: p.type?.abbreviation ?? p.type?.text ?? "",
    text: p.text ?? "",
    home: p.homeScore ?? 0,
    away: p.awayScore ?? 0,
  }));

  const drives = allDrives
    .filter((d) => d.team)
    .map((d, i, arr) => ({
      team: abbrOf(d.team),
      result: d.displayResult ?? d.result ?? (i === arr.length - 1 && s.drives?.current?.id === d.id ? "In progress" : "Unknown"),
      resultShort: d.shortDisplayResult ?? d.result ?? "",
      plays: d.offensivePlays ?? d.plays?.length ?? 0,
      yards: d.yards ?? 0,
      time: d.timeElapsed?.displayValue ?? "",
      start: d.start?.text ?? "",
      end: d.end?.text ?? "",
      period: d.start?.period?.number ?? 0,
      clock: d.start?.clock?.displayValue ?? "",
      score: !!d.isScore,
      current: s.drives?.current?.id === d.id ? true : undefined,
    }));

  const byPlayer: Record<string, { category: string; headline: string }[]> = {};
  const box: LiveSummary["box"] = [];
  const rawLines: LiveSummary["lines"] = [];
  let playersSeen = 0;
  for (const side of s.boxscore?.players ?? []) {
    const homeAway: "home" | "away" = side.homeAway ?? (side.team.id === homeC.team.id ? "home" : "away");
    const lines: LiveBoxLeader[] = [];
    for (const cat of side.statistics) {
      for (const a of cat.athletes) {
        rawLines.push({ id: a.athlete.id, name: a.athlete.displayName, homeAway, category: cat.name, stats: Object.fromEntries(cat.keys.map((k, i) => [k, a.stats[i] ?? ""])) });
        const h = headline(cat.name, cat.keys, a.stats);
        if (!h) continue;
        playersSeen++;
        const line = { id: a.athlete.id, name: a.athlete.displayName, category: cat.name, headline: h.text, yards: h.yards };
        lines.push(line);
        (byPlayer[a.athlete.id] ??= []).push({ category: cat.name, headline: h.text });
      }
    }
    const leaders = ["passing", "rushing", "receiving", "defensive", "interceptions"]
      .flatMap((c) => lines.filter((l) => l.category === c).sort((a, b) => b.yards - a.yards).slice(0, c === "receiving" || c === "defensive" ? 2 : 1))
      .filter((l) => l.yards > 0);
    box.push({ homeAway, abbr: abbrOf(side.team), leaders });
  }

  const sit = comp.situation;
  const bc = s.broadcasts?.find((b) => b.names?.length)?.names?.[0];
  return {
    id,
    state: st.type.state,
    detail: detailFor(st),
    home: { id: homeC.team.id, abbr: homeC.team.abbreviation ?? "HOME", score: num(homeC.score), linescores: lineVals(homeC.linescores) },
    away: { id: awayC.team.id, abbr: awayC.team.abbreviation ?? "AWAY", score: num(awayC.score), linescores: lineVals(awayC.linescores) },
    situation: sit
      ? {
          downDistance: sit.downDistanceText,
          possession: sit.possession ? abbrOf({ id: sit.possession }) || undefined : undefined,
          lastPlay: sit.lastPlay?.text,
          redZone: sit.isRedZone,
        }
      : undefined,
    winProb,
    scoringPlays,
    drives,
    box,
    byPlayer,
    playersSeen,
    lines: rawLines,
    broadcast: bc,
    asOf: new Date(now).toISOString(),
  };
}

/**
 * Drives, scoring plays, win probability series, and box score players for one
 * game. Memoized 60 seconds. Undefined when ESPN has no summary for the id.
 */
export function liveSummary(gameId: string): Promise<LiveSummary | undefined> {
  const id = String(gameId);
  return memo(`espn:sum:${id}`, 60, async () => {
    const raw = await getJson<EspnSummary>(`${BASE}/summary?event=${id}`);
    if (!raw) return undefined;
    return toSummary(id, raw, Date.now());
  });
}

/** ESPN headshot URL for a CFBD/ESPN athlete id. Many ids 404; the Avatar falls back on error. */
export function headshotUrl(athleteId: string | number): string {
  return `https://a.espncdn.com/i/headshots/nfl/players/full/${athleteId}.png`;
}
