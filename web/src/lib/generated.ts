/**
 * Reads the digests written by scripts/ingest.mjs (nflverse). Missing files are
 * not an error: the site degrades to schedule-level coverage and says so.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

const DIR = path.join(process.cwd(), "data", "generated");

/** Season stat line, compact keys. Passing: pa pc py ptd pint sks pepa pfd pay ypa cmp cpoe. Rushing: ra ry rtd repa rfd ypc.
 *  Receiving: rec tgt rcy rctd rcepa rays ryac rcfd ypr tshare ayshare wopr racr. Defense: tk solo ast tfl sk hur pd int inty dtd ff fr.
 *  Fumbles: fum fl. Kicking: fgm fga fglg fgp xpm xpa. Punting: pno pty ptlg pin20 ypp. Returns: pry kry sttd.
 *  gp = games with a stat row or an offensive/defensive snap. Last season (ps) is regular season only. */
export type StatLine = Record<string, number>;

export interface GenPlayer {
  id: string; // ESPN athlete id when nflverse has it, else the gsis id
  gsis: string;
  n: string; // name
  t: string; // team nickname ("Chiefs"), the join key used everywhere
  c: "nfl";
  cf: string | null; // conference
  dv: string | null; // division
  p: string | null; // position (QB, RB, WR, TE, OT, G, C, DE, DT, OLB, LB, CB, SAF, K, P, LS ...)
  pg: string | null; // roster position group (QB RB WR TE OL DL LB DB K P LS)
  y: number | null; // years in the league: 1 = rookie
  h: number | null; // inches
  w: number | null; // lbs
  j: number | null; // jersey
  g: number | null; // team games played
  s: StatLine | null; // this season
  ps: StatLine | null; // last season
  /** Snap shares: o = offense share per game, d = defense, st = special teams; gs = games with a snap row; os/ds = snap totals. */
  u: { o: number; d: number; st: number; gs: number; os: number; ds: number } | null;
  /** Draft and roster facts from nflverse. yr = rookie year, pk = overall pick (null = undrafted), club = drafting team nickname. */
  r: { yr: number | null; entry: number | null; pk: number | null; rd: number | null; club: string | null; exp: number; college: string | null; status: string; hs: string | null; born: string | null };
  /** Official injury report for the latest week: st = game status (Out, Doubtful, Questionable), pr = practice status. */
  inj: { st: string | null; pr: string | null; inj: string | null; wk: number } | null;
  /** Latest depth chart: slot label and rank (1 = starter). */
  dc: { pos: string; rank: number; grp: string } | null;
  /** Every team he has a regular-season game for, 2018 on, with the seasons: { "Falcons": [2023, 2024, 2025] }. */
  past?: Record<string, number[]>;
  home: string | null; // college
}

export interface GenUnit {
  plays: number; drives: number; ppa: number; sr: number; ex: number; power: number; stuff: number;
  /** Run game: rush EPA per carry (yards before contact are not in play-by-play, so this stands in for line yards). */
  ly: number; sly: number; ofy: number; ppo: number;
  havoc: number | null; havocF7: number | null; havocDB: number | null;
  sdSr: number | null; pdSr: number | null; pdEx: number | null;
  rushRate: number | null; rushSr: number | null; rushEx: number | null; rushPpa: number | null;
  passRate: number | null; passSr: number | null; passEx: number | null; passPpa: number | null;
  /** NFL extras from play-by-play and FTN charting. pressure = sacks plus QB hits per dropback. */
  pressure?: number | null; blitz?: number | null; playAction?: number | null; motion?: number | null;
  earlyPass?: number | null; neutralPass?: number | null; rzTd?: number | null; rzTrips?: number; pace?: number | null;
}

export interface GenTeam {
  team: string; // nickname
  code?: string;
  conf: string | null;
  dv?: string;
  c: "nfl" | "fbs" | "fcs" | "ii" | "iii" | null;
  games: number | null;
  off: GenUnit;
  def: GenUnit;
  /** DST counts this season and last (src/lib/dst-core.mjs seasonRates): games, sacks, takeaways, TDs, safeties, giveaways, sacks taken, DK DST points. */
  dst?: { now?: import("./dst-core.mjs").DstSeason; prev?: import("./dst-core.mjs").DstSeason };
  /** Play calling by week (offense): pass rate, neutral-situation pass rate, and pass rate over expected, in points. */
  calls?: { wk: number; g: string; opp: string; plays: number; pass: number; neutral: number | null; neutralPlays: number; proe: number | null }[];
}

export interface GenDraftPick {
  year: number; round: number; pick: number; overall: number; name: string; pos: string; college: string | null; conf: string | null;
  nfl: string; nflCode?: string; h: number | null; w: number | null; grade: number | null; prerank: number | null; collegeAthleteId: number | null;
  gsis?: string | null; id?: string | null; age?: number | null; cfbId?: string | null;
}

export interface GenMeta {
  ingestedAt: string;
  season: number;
  week?: number;
  statsThroughWeek?: number;
  /** The newest week in the stats: how many of its games are posted against how many have a final score. */
  latestWeek?: { week: number; posted: number; final: number };
  pbpThroughWeek?: number;
  players: number;
  teams: number;
  draftPicks: number;
  recruits: number;
  injuries?: number;
  ftn?: boolean;
  plays?: number;
  source?: string;
}

export interface GenInjury {
  team: string; // nickname
  gsis: string;
  id: string;
  name: string;
  pos: string;
  status: string | null; // Out, Doubtful, Questionable
  practice: string | null;
  injury: string | null;
  week: number;
  seasonType: string;
}

export interface GenElo {
  asOf: string;
  k: number;
  home: number;
  perPoint: number;
  teams: Record<string, number>;
  pregame: Record<string, { home: number; away: number }>;
}

export interface GenGame {
  id: string; // ESPN game id (or nv-<gid> when nflverse has no ESPN id)
  gid: string;
  season: number;
  type: "REG" | "POST";
  round: string;
  week: number;
  kickoff: string; // ISO
  date: string; // YYYY-MM-DD (ET)
  time: string | null;
  away: string; // nickname
  home: string;
  awayCode: string;
  homeCode: string;
  as: number | null;
  hs: number | null;
  played: boolean;
  result: number | null;
  total: number | null;
  ot: boolean;
  location: string;
  neutral: boolean;
  /** nflverse spread_line: positive = home favored by that many. */
  spread: number | null;
  totalLine: number | null;
  aml: number | null;
  hml: number | null;
  divGame: boolean;
  roof: string | null;
  surface: string | null;
  temp: number | null;
  wind: number | null;
  stadium: string | null;
  stadiumId: string | null;
  awayRest: number | null;
  homeRest: number | null;
  awayQb: string | null;
  homeQb: string | null;
  awayCoach: string | null;
  homeCoach: string | null;
  referee: string | null;
}

function readJson<T>(file: string, fallback: T): T {
  const f = path.join(DIR, file);
  if (!existsSync(f)) return fallback;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Cache key includes the file mtime so a fresh ingest is picked up without a restart. The mtime is re-read
 * at most every 5 seconds: one page build asks a few thousand times.
 */
const stamps = new Map<string, { at: number; value: string }>();
function stamp(file: string) {
  const hit = stamps.get(file);
  const now = Date.now();
  if (hit && now - hit.at < 5000) return hit.value;
  let value: string;
  try {
    value = String(statSync(path.join(DIR, file)).mtimeMs);
  } catch {
    value = "missing";
  }
  stamps.set(file, { at: now, value });
  return value;
}

export const genMeta = (): GenMeta | undefined => memoSync(`gen:meta:${stamp("meta.json")}`, 300, () => readJson<GenMeta | undefined>("meta.json", undefined));
export const genPlayers = (): GenPlayer[] => memoSync(`gen:players:${stamp("players.json")}`, 3600, () => readJson<GenPlayer[]>("players.json", []));
export const genTeams = (): GenTeam[] => memoSync(`gen:teams:${stamp("teams.json")}`, 3600, () => readJson<GenTeam[]>("teams.json", []));
export const genDraft = (): GenDraftPick[] => memoSync(`gen:draft:${stamp("draft.json")}`, 3600, () => readJson<GenDraftPick[]>("draft.json", []));
export const genInjuries = (): GenInjury[] => memoSync(`gen:inj:${stamp("injuries.json")}`, 3600, () => readJson<{ rows: GenInjury[] }>("injuries.json", { rows: [] }).rows);
export const genElo = (): GenElo | undefined => memoSync(`gen:elo:${stamp("elo.json")}`, 3600, () => readJson<GenElo | undefined>("elo.json", undefined));
export const genSchedule = (): GenGame[] => memoSync(`gen:sched:${stamp("schedule.json")}`, 3600, () => readJson<GenGame[]>("schedule.json", []));
export const scheduleStamp = () => stamp("schedule.json");
export const teamsStamp = () => stamp("teams.json");
export const playersStamp = () => stamp("players.json");
export const generatedLoaded = () => genMeta() !== undefined && genPlayers().length > 0;

/* ---------------------------------------------------- game logs (scripts/ingest.mjs) */

export interface GenGameLine {
  g: string; // ESPN game id
  wk: number;
  st: string; // regular | postseason
  t: string; // his team nickname
  opp: string; // opponent nickname
  ha: "home" | "away";
  s: StatLine; // compact stat keys, same as GenPlayer.s, plus rshare (carry share in this game)
  /** This game's snaps: o/d/st = share of the team's offense, defense, special teams snaps (0 to 1); os/ds = snap counts. */
  sn?: { o?: number; d?: number; st?: number; os?: number; ds?: number };
}

export interface GenGameLogs {
  meta: { ingestedAt: string; season: number; weeks: string[]; games: number; players: number; lines: number };
  games: Record<string, { wk: number; st: string; home: string; away: string; hp: number | null; ap: number | null; hc: string | null; ac: string | null; long?: { home: number | null; away: number | null } }>;
  players: Record<string, GenGameLine[]>;
}

export const genGamelogs = (): GenGameLogs | undefined => memoSync(`gen:gamelogs:${stamp("gamelogs.json")}`, 3600, () => readJson<GenGameLogs | undefined>("gamelogs.json", undefined));
export const gamelogsStamp = () => stamp("gamelogs.json");

/** Seasons before last for QB and skill players (compact totals), plus last season's QB plays and EPA by team. */
export interface GenHistory {
  seasons: number[];
  players: Record<string, Record<string, StatLine>>;
  teamQb: Record<string, Record<string, Record<string, { n: number; e: number; name: string }>>>;
}
export const genHistory = (): GenHistory | undefined => memoSync(`gen:history:${stamp("history.json")}`, 3600, () => readJson<GenHistory | undefined>("history.json", undefined));
export const historyStamp = () => stamp("history.json");

/**
 * Every QB/RB/WR/TE game since 2019 for current players (scripts/ingest.mjs "history games"): compact rows in `cols`
 * order, g = ESPN game id (look it up in schedule.json), t = his team nickname, then the dkPoints stat keys plus tgt, ra, pa.
 */
export interface GenHistoryGames {
  cols: string[];
  seasons: number[];
  players: Record<string, (string | number)[][]>;
  /** Team defenses (nickname): [ESPN game id, DraftKings DST points] per game. */
  dst?: Record<string, [string, number][]>;
}
export const genHistoryGames = (): GenHistoryGames | undefined => memoSync(`gen:histgames:${stamp("history-games.json")}`, 3600, () => readJson<GenHistoryGames | undefined>("history-games.json", undefined));
export const historyGamesStamp = () => stamp("history-games.json");
