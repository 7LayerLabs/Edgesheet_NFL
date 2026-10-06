/**
 * Builds the slate from the nflverse digests (schedule, tendencies, radar,
 * injuries, Elo), the ESPN public feed (live scores, broadcasts, FPI), The Odds
 * API snapshots (current lines), and the National Weather Service.
 *
 * Every field that the UI shows is either (a) a fact from a source with an
 * as-of time, (b) a rule-based derivation from those facts, or (c) explicitly
 * labeled as unavailable. Nothing here invents a player, a scheme, or a line.
 */
import { calendar, espnWeek, etDateOf, eloCurrent, fpiRatings, eloPregame, gameById, gamesForWeek, logoUrl, NATIONAL_WINDOWS, roofState, scheduleLoaded, standingFor, teamByShort, venueFor, type EspnWeekRow, type Finals, type NflWeek, type Standing } from "./nfl";
import { forecastAtKickoff, forecastMany } from "./nws";
import { generatedLoaded, genInjuries, genMeta, genPlayers, type GenGame, type GenInjury, type GenPlayer } from "./generated";
import { groupOf, matchupPlayer, radarForGame, radarForTeam, radarPlayer, statLine, type EdgeAxis, type PosGroup, type RadarPlayer } from "./radar";

/** The game page splits its radar: offense (the betting side, kickers listed apart) and defense (its own section). */
const OFFENSE_GROUPS = new Set<PosGroup>(["QB", "RB", "WR", "TE"]);
const DEFENSE_GROUPS = new Set<PosGroup>(["DL", "EDGE", "LB", "CB", "S"]);

/** A kicker in one line: field goals and extra points this season, and last season while this one is thin. */
function kickerLine(k: GenPlayer): string {
  const part = (s: GenPlayer["s"], label: string) => (s?.fga || s?.xpa ? `${label}: ${s.fgm ?? 0} of ${s.fga ?? 0} field goals${s.fglg ? ` (long ${s.fglg})` : ""}, ${s.xpm ?? 0} of ${s.xpa ?? 0} extra points` : "");
  return [part(k.s, "this season"), (k.s?.fga ?? 0) < 6 ? part(k.ps, "last season") : ""].filter(Boolean).join("; ") || "no kicks on record";
}
import { leagueMeans, pressurePoint, styleContrast, styleFor, unitEdges, type UnitEdge } from "./tendencies";
import { gameCues, situationsFor } from "./situational";
import { lockedProjection, projectGame } from "./projection";
import { buildConsensus } from "./consensus";
import { absentWords, gameAvailability, type GameAvailability } from "./availability";
import { dkPoints } from "./dfs";
import { gameStories } from "./storylines";
import { riserShort, shareText, vacatedFor } from "./vacated";
import type { Venue } from "./nfl";
import { boxScore } from "./boxscore";
import { memo } from "./memo";
import { slateTtlSeconds } from "./cache-policy";
import { liveGame, liveSummary } from "./espn";
import { gradePostgame, lockPregame, readEntry } from "./archive";
import { gameOdds, latestLine } from "./odds";
import { evaluateWeather } from "./weather";
import type { Coverage, DefenseProfile, Division, Game, Market, Matchup, OffenseProfile, Prospect, ScoreComponents, Team, WeatherInput } from "./types";

const ET = "America/New_York";

export function etDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00-04:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return etDate(d);
}

export interface SlateDay {
  date: string;
  count: number;
}

export interface RankedTeam {
  rank: number;
  team: Team;
  gameId?: string;
  movement?: "first-place-votes";
  firstPlaceVotes?: number;
}

export interface Poll {
  name: string;
  division: Division;
  teams: RankedTeam[];
}

export interface Slate {
  source: "live" | "sample";
  polls: Poll[];
  season: number;
  week?: NflWeek;
  date: string;
  days: SlateDay[];
  games: Game[];
  /** Every game in the week, all days. Used by the watchlist. */
  weekGames: Game[];
  notes: string[];
  /** ESPN finals for the week, so /standings counts games the ingest has not caught yet. */
  finals?: Finals;
}

/* ------------------------------------------------------------------ week */

function seasonFor(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return m <= 2 ? y - 1 : y;
}

function pickWeek(cal: NflWeek[], date: string): NflWeek | undefined {
  const t = new Date(`${date}T12:00:00-04:00`).getTime();
  const hit = cal.find((w) => new Date(w.startDate).getTime() <= t && t < new Date(w.endDate).getTime());
  if (hit) return hit;
  if (!cal.length) return undefined;
  return t < new Date(cal[0].startDate).getTime() ? cal[0] : cal[cal.length - 1];
}

/* ------------------------------------------------------------ raw bundle */

interface Bundle {
  season: number;
  week: NflWeek;
  games: GenGame[];
  espn: Map<string, EspnWeekRow>;
  /** Finals ESPN has posted this week, for records that include games the ingest has not caught yet. */
  finals: Finals;
}

async function loadWeek(season: number, week: NflWeek, gamesOverride?: GenGame[]): Promise<Bundle> {
  const games = gamesOverride ?? gamesForWeek(season, week.week, week.seasonType);
  // Last week's scoreboard too: a game that went final after the ingest (Sunday night, Monday night) still counts in this week's records.
  const none = () => new Map<string, EspnWeekRow>();
  const [espn, prev] = await Promise.all([
    espnWeek(season, week.week, week.seasonType).catch(none),
    week.seasonType === "regular" && week.week > 1 ? espnWeek(season, week.week - 1, "regular").catch(none) : Promise.resolve(none()),
  ]);
  const finals: Finals = Object.fromEntries([...prev, ...espn].flatMap(([id, r]) => (r.final ? [[id, r.final]] : [])));
  return { season, week, games, espn, finals };
}

/* --------------------------------------------------------------- helpers */

function median(nums: number[]): number | undefined {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
void median;

const half = (n: number) => Math.round(n * 2) / 2;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;

function mkTeam(short: string, season: number, finals?: Finals): Team {
  const t = teamByShort(short);
  const st: Standing | undefined = t ? standingFor(season, short, finals) : undefined;
  return {
    id: t?.espnId ?? short,
    name: t?.name ?? short,
    short,
    abbr: t?.abbr ?? short.slice(0, 3).toUpperCase(),
    record: st?.record ?? "",
    conference: t ? `${t.conf} ${t.div}` : "",
    color: t?.color ?? "#8b95a0",
    logo: t ? logoUrl(t.abbr) : undefined,
    code: t?.code,
    div: t?.div,
    standing: st && st.games ? `${ordinal(st.divRank)} in the ${t!.conf} ${t!.div}` : undefined,
    seed: st?.seed,
  };
}

/**
 * Market: the nflverse schedule line (closing line once the game is played, the
 * current posted line before it) is the opening reference, and the newest Odds
 * API snapshot is the current number when one exists.
 */
function mkMarket(raw: GenGame, home: Team, away: Team, asOf: string): Market {
  const openHome = raw.spread != null ? -raw.spread : undefined; // nflverse: positive = home favored; ours: negative = home favored
  const cur = latestLine(raw.season, raw.id);
  const homeSpread = cur?.spread ?? openHome;
  if (homeSpread === undefined) return { asOf };
  const favHome = homeSpread <= 0;
  const team = favHome ? home.abbr : away.abbr;
  const line = half(favHome ? homeSpread : -homeSpread);
  const open = openHome === undefined ? line : half(favHome ? openHome : -openHome);
  const total = cur?.total ?? raw.totalLine ?? undefined;
  const totalOpen = raw.totalLine ?? total;
  const mlHome = cur?.mlHome ?? raw.hml ?? undefined;
  const mlAway = cur?.mlAway ?? raw.aml ?? undefined;
  return {
    spread: { team, line, open },
    total: total !== undefined ? { line: half(total), open: half(totalOpen ?? total) } : undefined,
    moneyline: mlHome !== undefined && mlAway !== undefined ? { home: mlHome, away: mlAway } : undefined,
    books: cur?.books ?? 1,
    asOf: cur?.at ?? asOf,
  };
}

function winPct(t: Team): number | undefined {
  const m = t.record.match(/^(\d+)-(\d+)/);
  if (!m) return undefined;
  const w = Number(m[1]);
  const l = Number(m[2]);
  return w + l ? w / (w + l) : undefined;
}

function gamesPlayed(t: Team): number {
  const m = t.record.match(/^(\d+)-(\d+)(?:-(\d+))?/);
  return m ? Number(m[1]) + Number(m[2]) + Number(m[3] ?? 0) : 0;
}

/* ------------------------------------------------------- radar bridge */

const ft = (inches: number | null) => (inches ? `${Math.floor(inches / 12)}-${inches % 12}` : "");

export function radarToProspect(r: RadarPlayer, abbr: string): Prospect {
  return {
    id: r.id,
    name: r.name,
    team: abbr,
    jersey: r.jersey ?? 0,
    pos: r.pos,
    cls: r.cls,
    ht: ft(r.height),
    wt: r.weight ?? 0,
    draftYear: r.draftClass,
    eligibilityConfidence: "High",
    tier: r.tier,
    projected: r.slot ? `Pick No. ${r.slot}, ${r.draftClass}` : `Undrafted, ${r.draftClass}`,
    sourceCount: 0,
    projectionConfidence: r.score >= 70 ? "High" : r.score >= 50 ? "Medium" : "Low",
    traits: r.evidence.map((e) => e.label),
    weakness: r.size === false ? "Under NFL size norms for the position" : undefined,
    watchFor: r.watch,
    stat: r.stat,
    radar: r,
    injury: r.injury?.status ? { status: r.injury.status, practice: r.injury.practice, injury: r.injury.injury, week: r.injury.week } : undefined,
    lensNote: r.lensNote,
    headshot: r.headshot ?? undefined,
  };
}

function toProfiles(team: string): { off: OffenseProfile; def: DefenseProfile } {
  const st = styleFor(team);
  if (!st) {
    return {
      off: { label: "Unavailable", sample: "unavailable" },
      def: { label: "Unavailable", sample: "unavailable" },
    };
  }
  return {
    off: { label: st.offense.label, sample: st.offense.sample, summary: st.offense.summary, metrics: st.offense.metrics },
    def: { label: st.defense.label, sample: st.defense.sample, summary: st.defense.summary, metrics: st.defense.metrics },
  };
}

function shortStyle(label: string) {
  return label.split(",")[0].trim();
}

function axisOf(e: UnitEdge): EdgeAxis {
  const t = e.title.toLowerCase();
  if (t.includes("ground game")) return "line";
  if (t.includes("run game")) return "rush";
  if (t.includes("pass game") || t.includes("deep passing")) return "pass";
  return "pd";
}

/** "offense 0.49 (No. 3/32), defense 0.41 (No. 29/32)" -> ranks. */
function ranksOf(e: UnitEdge): { off?: number; def?: number; of?: number } {
  const m = e.evidence.match(/offense [^(]+\(No\. (\d+)\/(\d+)\), defense [^(]+\(No\. (\d+)\/\d+\)/);
  return m ? { off: Number(m[1]), of: Number(m[2]), def: Number(m[3]) } : {};
}

/** Every stat in an edge's evidence: "pass explosiveness: offense 1.18 (No. 27/32), defense 1.29 (No. 14/32), ...". */
function statsOf(e: UnitEdge): { stat: string; off: number; def: number }[] {
  return [...e.evidence.matchAll(/([a-z][a-z -]*): offense [^(]+\(No\. (\d+)(?:\/\d+)?\), defense [^(]+\(No\. (\d+)(?:\/\d+)?\)/g)].map((m) => ({ stat: m[1].trim(), off: Number(m[2]), def: Number(m[3]) }));
}

/**
 * The radar line for the offensive player a unit matchup runs through, with both units' ranks so the reader can see
 * who the matchup leans to and why (a weak offense against an average defense reads very differently from a good
 * defense). Rank 1 is the best unit on both sides.
 */
function matchupNote(e: UnitEdge, axis: EdgeAxis, offTeam: string, defTeam: string): string {
  const role = ROLE[axis];
  const st = statsOf(e).slice(0, 2);
  if (!st.length) return `The ${offTeam} ${role.off}: the ${role.unitOff} against the ${defTeam} ${role.unitDef} leans ${e.edge === "offense" ? `the ${offTeam}` : `the ${defTeam}`}.`;
  const of = ranksOf(e).of ?? 32;
  const offLine = st.map((s, i) => `No. ${s.off}${i === 0 ? ` of ${of}` : ""} in ${s.stat}`).join(" and ");
  const defLine = st.map((s) => `No. ${s.def} in ${s.stat}`).join(" and ");
  const [a] = st;
  const lean = e.edge === "offense" ? offTeam : defTeam;
  const why = e.edge === "offense"
    ? a.off <= 10 && a.def >= 23 ? "a good unit against a weak one" : a.off <= 10 ? `mostly because the ${offTeam} ${role.unitOff} is good` : `mostly because the ${defTeam} ${role.unitDef} has been poor`
    : a.def <= 10 && a.off >= 23 ? "a good unit against a weak one" : a.def <= 10 ? `mostly because the ${defTeam} ${role.unitDef} is good` : `mostly because the ${offTeam} ${role.unitOff} has been poor, not because the ${defTeam} are stingy`;
  const so = e.edge === "offense"
    ? `As the ${role.off}, he is the one the matchup sets up.`
    : `He is here because, as the ${role.off}, his line is the one this matchup squeezes: a tough spot, not a play. If he produces anyway, he is matchup-proof.`;
  return `${offTeam} ${role.unitOff}: ${offLine}. ${defTeam} ${role.unitDef}: ${defLine}. Leans ${lean}, ${why}. ${so}`;
}

const ROLE: Record<EdgeAxis, { off: string; def: string; unitOff: string; unitDef: string }> = {
  rush: { off: "lead back", def: "run stopper", unitOff: "run game", unitDef: "run defense" },
  line: { off: "lead back", def: "run stopper", unitOff: "ground game", unitDef: "run front" },
  pass: { off: "top target", def: "coverage leader", unitOff: "pass game", unitDef: "pass defense" },
  pd: { off: "quarterback", def: "pass rusher", unitOff: "passing-down offense", unitDef: "passing-down defense" },
};

/* ------------------------------------------------------- derived fields */

interface Ctx {
  prospects: Prospect[];
  market: Market;
  homeElo: number | null;
  awayElo: number | null;
  home: Team;
  away: Team;
  network: string;
  status: Game["status"];
  edges: Matchup[];
  weather?: WeatherInput;
  raw: GenGame;
  homeSt?: Standing;
  awaySt?: Standing;
  stakes: string[];
}

function deriveComponents(g: Ctx): ScoreComponents {
  // Competitive expectation: spread first, Elo gap second.
  let competitive: number;
  if (g.market.spread) competitive = Math.max(5, Math.round(100 - Math.abs(g.market.spread.line) * 4.5));
  else if (g.homeElo != null && g.awayElo != null) competitive = Math.max(5, Math.round(100 - Math.abs(g.homeElo - g.awayElo) / 4));
  else competitive = 50;

  const edges = g.edges;
  const directMatchups = edges.length ? Math.min(100, edges.filter((e) => e.edge !== "even").length * 28 + edges.filter((e) => e.edge === "even").length * 12) : null;

  // Rookie and breakout density: radar scores of the rookies, breakouts, and matchup players on both sides.
  let watchDensity: number | null = null;
  if (generatedLoaded()) {
    const pts = g.prospects.reduce((s, p) => {
      if (p.tier === "Rookie") return s + Math.max(0, (p.radar?.score ?? 0) - 40) * 1.4;
      if (p.tier === "Breakout") return s + Math.max(0, (p.radar?.score ?? 0) - 40) * 1.2;
      if (p.tier === "Matchup") return s + 12;
      return s + 5;
    }, 0);
    // NFL radars carry 10 to 14 names a game (college about 4), so raw points run about 90 to 450: scaled by 4.5,
    // not capped at 100, or every game reads 100 and the component tells games apart in nothing.
    watchDensity = Math.round(Math.min(100, pts / 4.5));
  }

  // Stakes: division game, both teams in the hunt, and how late it is.
  let stakes = 20;
  if (g.raw.divGame) stakes += 25;
  const hp = winPct(g.home);
  const ap = winPct(g.away);
  const wk = g.raw.week;
  const late = g.raw.type === "POST" ? 1 : Math.min(1, Math.max(0, (wk - 4) / 14));
  if (g.raw.type === "POST") stakes = 100;
  else {
    if (hp !== undefined && ap !== undefined && gamesPlayed(g.home) >= 3 && gamesPlayed(g.away) >= 3) {
      if (hp >= 0.6 && ap >= 0.6) stakes += 25 + Math.round(20 * late);
      else if (hp >= 0.5 && ap >= 0.5) stakes += 12 + Math.round(12 * late);
      else if (hp < 0.35 && ap < 0.35) stakes -= 10;
    }
    if (g.homeSt && g.awaySt && (g.homeSt.seed <= 7 || g.awaySt.seed <= 7) && wk >= 10) stakes += 10;
    if (g.homeSt && g.awaySt && g.homeSt.seed <= 7 && g.awaySt.seed <= 7) stakes += 10;
  }
  stakes = Math.max(0, Math.min(100, stakes));

  // Availability: can you actually watch it.
  let availability = NATIONAL_WINDOWS.test(g.network.trim()) ? 100 : /^(CBS|FOX)$/i.test(g.network.trim()) ? 70 : g.network ? 60 : 50;
  if (g.status === "final") availability = 30;

  return { competitive, directMatchups, watchDensity, stakes, availability };
}

function deriveWhyWatch(g: Ctx): { headline: string; reasons: string[]; read: string[] } {
  // Each reason says what it is about, so the game page can skip what its answer strip and Who to watch already cover.
  type About = "stakes" | "market" | "move" | "player" | "matchup" | "weather" | "record" | "rating" | "none";
  const r: { about: About; text: string }[] = [];
  const push = (about: About, text: string) => r.push({ about, text });
  const s = g.market.spread;
  const rec = (t: Team) => (t.record ? `${t.short} (${t.record})` : t.short);
  if (g.stakes[0]) push("stakes", g.stakes[0]);
  // The game before the players: how close the market thinks it is leads, then the top radar name.
  if (s) {
    const a = Math.abs(s.line);
    if (a <= 2.5) push("market", `The market calls it a toss-up: ${s.team} ${s.line}.`);
    else if (a <= 6.5) push("market", `One-score game by the market: ${s.team} ${s.line}.`);
  }
  const star = g.prospects.find((p) => p.tier === "Rookie" || p.tier === "Breakout");
  if (star?.radar && star.radar.score >= 70) {
    const r0 = star.radar;
    const aboveSlot = r0.tier === "Rookie" && r0.eqPick !== null && (r0.slot === null || r0.eqPick < r0.slot);
    const what = aboveSlot ? (r0.slot ? `a rookie drafted No. ${r0.slot} who is playing above that slot, ${r0.stat}` : `an undrafted rookie playing like a drafted one, ${r0.stat}`) : r0.breakout?.label ?? r0.stat;
    push("player", `${star.name} (${star.team} ${star.pos}) is a top-of-the-radar name: ${what}.`);
  }
  if (s) {
    const move = s.line - s.open;
    if (Math.abs(move) >= 1.5) push("move", `The line moved ${move > 0 ? "toward the underdog" : "toward the favorite"} this week, from ${s.open} to ${s.line}.`);
  }
  const t = g.market.total;
  if (t) {
    if (t.line >= 50) push("market", `Total of ${t.line}. The market expects points.`);
    else if (t.line <= 39.5) push("market", `Total of ${t.line}. The market expects a field-position grind.`);
  }
  const topEdge = g.edges.find((e) => e.edge !== "even");
  if (topEdge) push("matchup", `${topEdge.a} against ${topEdge.b.toLowerCase()}: advantage ${topEdge.edge}. ${topEdge.evidence}.`);
  if (g.weather) {
    const top = evaluateWeather(g.weather).find((f) => f.level === "elevated") ?? evaluateWeather(g.weather).find((f) => f.level === "flag");
    if (top) push("weather", `${top.title}. ${top.effect}`);
  }
  const hp = winPct(g.home);
  const ap = winPct(g.away);
  if (hp === 1 && ap === 1 && gamesPlayed(g.home) >= 3 && gamesPlayed(g.away) >= 3) push("record", `Both teams are undefeated: ${rec(g.away)} at ${rec(g.home)}.`);
  else if (g.raw.divGame && !g.stakes.length) push("stakes", `${g.home.conference} division game.`);
  if (!s && g.homeElo != null && g.awayElo != null && Math.abs(g.homeElo - g.awayElo) >= 150) {
    const dog = g.homeElo < g.awayElo ? g.home.short : g.away.short;
    push("rating", `Big rating gap and no line. The ${dog} young players get the snaps that matter late.`);
  }
  if (!r.length) push("none", "No line and no charting yet. Schedule-level coverage only.");
  const reasons = r.slice(0, 3).map((x) => x.text);
  // The game page: stakes, records, a line move, weather; empty when there is nothing the strip and Who to watch miss.
  const read = r.filter((x) => x.about === "stakes" || x.about === "record" || x.about === "move" || x.about === "weather" || x.about === "rating").map((x) => x.text);
  return { headline: reasons[0], reasons, read };
}

/** Standings sentences for the two teams, from the schedule file alone. */
function deriveStakes(raw: GenGame, home: Team, away: Team, homeSt?: Standing, awaySt?: Standing): string[] {
  const out: string[] = [];
  if (!homeSt || !awaySt || !homeSt.games || !awaySt.games) {
    if (raw.divGame) out.push(`${home.conference} division game.`);
    return out;
  }
  const line = (t: Team, s: Standing) => `${t.short} ${s.record}, ${ordinal(s.divRank)} in the ${t.conference}`;
  if (raw.divGame) {
    if (homeSt.divRank === 1 || awaySt.divRank === 1) {
      const leader = homeSt.divRank === 1 ? home : away;
      const other = leader === home ? away : home;
      const otherSt = leader === home ? awaySt : homeSt;
      const leaderSt = leader === home ? homeSt : awaySt;
      out.push(otherSt.divRank === 2 && Math.abs(leaderSt.pct - otherSt.pct) <= 0.26
        ? `Division game for first place: the ${leader.short} lead the ${leader.conference} at ${leaderSt.record}, the ${other.short} are ${otherSt.record}.`
        : `Division game: the ${leader.short} lead the ${leader.conference} at ${leaderSt.record}; the ${other.short} are ${otherSt.record}, ${ordinal(otherSt.divRank)}.`);
    } else out.push(`Division game: ${line(away, awaySt)}; ${line(home, homeSt)}.`);
  } else if (homeSt.seed <= 7 && awaySt.seed <= 7 && raw.week >= 6) {
    out.push(`Both in the playoff picture by record: ${away.short} ${awaySt.record} (No. ${awaySt.seed} seed line in the ${away.conference.split(" ")[0]}), ${home.short} ${homeSt.record} (No. ${homeSt.seed} in the ${home.conference.split(" ")[0]}).`);
  } else if (homeSt.pct >= 0.6 && awaySt.pct >= 0.6 && raw.week >= 4) {
    out.push(`Two winning teams: ${line(away, awaySt)}; ${line(home, homeSt)}.`);
  }
  if (raw.type === "POST") out.unshift(`${raw.round === "SB" ? "Super Bowl" : raw.round === "CON" ? "Conference championship" : raw.round === "DIV" ? "Divisional round" : "Wild card round"}: lose and go home.`);
  return out;
}

/* ------------------------------------------------------------ build one */

async function buildGame(raw: GenGame, b: Bundle, withWeather: boolean, withBox = false): Promise<Game> {
  const division: Division = "NFL";
  const home = mkTeam(raw.home, raw.season, b.finals);
  const away = mkTeam(raw.away, raw.season, b.finals);
  const homeSt = standingFor(raw.season, raw.home, b.finals);
  const awaySt = standingFor(raw.season, raw.away, b.finals);
  const now = Date.now();
  // Independent fetches start together: who is playing (ESPN injuries and transactions) and FPI (read later by
  // buildConsensus through the same memo), while the live feed below decides the game's status.
  const availabilityP = gameAvailability(raw.home, raw.away, raw.kickoff).catch(() => undefined);
  void fpiRatings(raw.season).catch(() => undefined);
  const started = new Date(raw.kickoff).getTime() <= now;
  let status: Game["status"] = raw.played ? "final" : started ? "live" : "upcoming";
  let score = raw.played
    ? { home: raw.hs as number, away: raw.as as number, clock: "Final" }
    : status === "live"
      ? { home: NaN, away: NaN, clock: "in progress" }
      : undefined;

  // ESPN live overlay: real clock, score, situation, win probability for games that kicked off in the last 30 hours.
  const espnLive =
    status !== "upcoming" && now - new Date(raw.kickoff).getTime() < 30 * 3600 * 1000 && /^\d+$/.test(raw.id)
      ? await liveGame(raw.id, etDateOf(raw.kickoff)).catch(() => undefined)
      : undefined;
  if (espnLive && espnLive.state !== "pre") {
    status = espnLive.state === "in" ? "live" : "final";
    if (espnLive.home.score != null && espnLive.away.score != null) score = { home: espnLive.home.score, away: espnLive.away.score, clock: espnLive.detail };
  } else if (espnLive && !raw.played) {
    status = "upcoming"; // the clock has passed kickoff; ESPN says it has not started (delay or late kick).
    score = undefined;
  } else if (status === "live" && !espnLive && !raw.played && now - new Date(raw.kickoff).getTime() > 5 * 3600 * 1000) {
    status = "final"; // long past kickoff with no feed: treat as final pending the nflverse result
    score = undefined;
  }

  const builtAt = new Date().toISOString();
  const market = mkMarket(raw, home, away, builtAt);
  const espnRow = b.espn.get(raw.id);
  const network = espnRow?.network || "TV listing pending";
  // ESPN flags international games that nflverse lists as home games (PHI at JAX, Tottenham).
  const neutral = raw.neutral || espnRow?.neutral === true;
  const venue = venueFor({ ...raw, neutral });

  const roof = roofState(raw.roof);
  const weatherP: Promise<WeatherInput | undefined> =
    withWeather && status !== "final" && venue?.nws && roof !== "fixed"
      ? forecastAtKickoff(
          { latitude: venue.lat, longitude: venue.lon, dome: roof === "retractable-closed", grass: venue.surface === "grass", elevationMeters: venue.elevationFt / 3.28084 },
          raw.kickoff,
        ).then((w) => (w ? { ...w, roof } : w))
      : Promise.resolve(undefined);
  const names = new Map<string, string>();
  const boxP = withBox && status === "final" ? boxScore(raw.id, names).catch(() => undefined) : Promise.resolve(undefined);
  const liveP = withBox && espnLive && espnLive.state !== "pre" ? liveSummary(raw.id).catch(() => undefined) : Promise.resolve(undefined);
  const [weather, bs, espnDetail, availability] = await Promise.all([weatherP, boxP, liveP, availabilityP]);
  // One status for the whole page: the radar, the matchup pick, and the storylines read the same feed as "Who is playing".
  const statusOf = (id: string) => availability?.home.statuses[id] ?? availability?.away.statuses[id];
  const sits = (id: string) => (statusOf(id)?.absence ?? 0) > 0.5;

  // Team style and unit matchups from play-by-play.
  const profAway = toProfiles(raw.away);
  const profHome = toProfiles(raw.home);
  const charted = profAway.off.sample !== "unavailable" && profHome.off.sample !== "unavailable";
  const edgeRows = charted ? [...unitEdges(raw.away, raw.home), ...unitEdges(raw.home, raw.away)] : [];
  const topEdges = edgeRows.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap)).slice(0, 4);
  const matchups: Matchup[] = topEdges.map((e) => {
    const [a, bb] = e.title.split(" vs ");
    return { a, b: bb, why: e.text, evidence: e.evidence, edge: e.edge, strength: e.strength, watch: e.watch };
  });
  const contrast = charted ? styleContrast(raw.away, raw.home) : null;
  const pp = charted ? pressurePoint(raw.away, raw.home) : undefined;

  // Radar: rookies, breakouts, and watch names, then the players the unit edges put on the spot.
  const unitNote = (team: string) => {
    const st = styleFor(team);
    const ly = st?.offense.metrics.find((m) => m.key === "ly");
    const pr = st?.offense.metrics.find((m) => m.key === "pressure");
    return ly ? `Unit: run game ${ly.value} EPA per carry (No. ${ly.rank} of ${ly.of})${pr ? `, pressure allowed ${pr.value} (No. ${pr.rank})` : ""}` : undefined;
  };
  const withUnit = (r: RadarPlayer, abbr: string, team: string): Prospect => {
    const pr = radarToProspect(r, abbr);
    if (r.group === "OL") {
      const note = unitNote(team);
      if (note) {
        pr.stat = note;
        pr.traits = [note, ...pr.traits];
        pr.radar = { ...r, stat: note, evidence: [{ kind: "unit", label: note }, ...r.evidence] };
      }
    }
    return pr;
  };
  const radarAway = radarForGame(raw.away, 6, sits).map((r) => withUnit(r, away.abbr, raw.away));
  const radarHome = radarForGame(raw.home, 6, sits).map((r) => withUnit(r, home.abbr, raw.home));
  const matchupPicks: Prospect[] = [];
  const offenseSpot: Prospect[] = [];
  for (const e of topEdges.filter((x) => x.edge !== "even").slice(0, 2)) {
    const axis = axisOf(e);
    const offTeam = e.title.split(" ")[0] === raw.home.split(" ")[0] && e.title.startsWith(raw.home) ? raw.home : raw.away;
    const defTeam = offTeam === raw.home ? raw.away : raw.home;
    const ranks = ranksOf(e);
    const role = ROLE[axis];
    const team = e.edge === "offense" ? offTeam : defTeam;
    const opp = team === offTeam ? defTeam : offTeam;
    const oppRank = e.edge === "offense" ? ranks.def : ranks.off;
    const strength = { dominant: "a mismatch", clear: "a clear edge", real: "an edge", slight: "a slight edge", even: "even" }[e.strength ?? "real"] ?? "an edge";
    const note = e.edge === "offense"
      ? `The ${offTeam} ${role.off} against a ${opp} ${role.unitDef} ranked No. ${oppRank ?? "?"} of ${ranks.of ?? 32}: ${strength}.`
      : `The ${defTeam} ${role.def} against a ${opp} ${role.unitOff} ranked No. ${oppRank ?? "?"} of ${ranks.of ?? 32}: ${strength}.`;
    const mp = matchupPlayer(axis, e.edge as "offense" | "defense", team, e.edge === "offense" ? matchupNote(e, axis, offTeam, defTeam) : note, sits);
    if (mp) matchupPicks.push({ ...radarToProspect(mp, team === raw.home ? home.abbr : away.abbr), matchupSide: "for" });
    // Derek's rule: the betting side of the page is the offense. When the defense holds the edge, the offensive player
    // who carries that unit is the one on the spot (his line is what moves); the defender goes to the Defense section.
    // He is labeled a tough matchup, not a key one, so nobody reads him as a play.
    if (e.edge === "defense") {
      const op = matchupPlayer(axis, "offense", offTeam, matchupNote(e, axis, offTeam, defTeam), sits);
      if (op) offenseSpot.push({ ...radarToProspect(op, offTeam === raw.home ? home.abbr : away.abbr), matchupSide: "against" });
    }
  }
  const seenP = new Set<string>();
  const byTierThenScore = (x: Prospect, y: Prospect) => {
    const order = (t: Prospect["tier"]) => (t === "Matchup" ? 0 : t === "Rookie" ? 1 : t === "Breakout" ? 2 : 3);
    return order(x.tier) - order(y.tier) || (y.radar?.score ?? 0) - (x.radar?.score ?? 0);
  };
  const prospects = [...matchupPicks, ...radarAway, ...radarHome].filter((p) => (seenP.has(p.id) ? false : seenP.add(p.id))).sort(byTierThenScore);
  // Display lists: offense (the betting side) and defense, each with its own picks so neither crowds out the other.
  const isGroup = (set: Set<PosGroup>) => (p: Prospect) => Boolean(p.radar && set.has(p.radar.group));
  const dedupe = (list: Prospect[]) => {
    const seen = new Set<string>();
    return list.filter((p) => (seen.has(p.id) ? false : seen.add(p.id))).sort(byTierThenScore);
  };
  const offenseRadar = dedupe([
    ...matchupPicks.filter(isGroup(OFFENSE_GROUPS)),
    ...offenseSpot,
    ...radarForGame(raw.away, 6, sits, OFFENSE_GROUPS).map((r) => withUnit(r, away.abbr, raw.away)),
    ...radarForGame(raw.home, 6, sits, OFFENSE_GROUPS).map((r) => withUnit(r, home.abbr, raw.home)),
  ]);
  const defenseRadar = dedupe([
    ...matchupPicks.filter(isGroup(DEFENSE_GROUPS)),
    ...radarForGame(raw.away, 4, sits, DEFENSE_GROUPS).map((r) => withUnit(r, away.abbr, raw.away)),
    ...radarForGame(raw.home, 4, sits, DEFENSE_GROUPS).map((r) => withUnit(r, home.abbr, raw.home)),
  ]);
  const kickers = [raw.away, raw.home].flatMap((t) => {
    const k = genPlayers().filter((p) => p.t === t && p.pg === "K" && !sits(p.id)).sort((a, b) => (b.s?.fga ?? 0) - (a.s?.fga ?? 0) || (b.ps?.fga ?? 0) - (a.ps?.fga ?? 0))[0];
    return k ? [{ id: k.id, name: k.n, team: t === raw.home ? home.abbr : away.abbr, line: kickerLine(k) }] : [];
  });

  // Official injury report, both teams, this game's week only (another week's report is not this game's).
  const injuryRows = genInjuries().filter((i: GenInjury) => (i.team === raw.home || i.team === raw.away) && i.status && i.week === raw.week);
  const sev = (s: string | null) => (s === "Out" ? 0 : s === "Doubtful" ? 1 : 2);
  const injuryReport = injuryRows
    .sort((x, y) => sev(x.status) - sev(y.status) || x.name.localeCompare(y.name))
    .map((i) => ({ team: i.team === raw.home ? home.abbr : away.abbr, id: i.id, name: i.name, pos: i.pos, status: i.status as string, practice: i.practice, injury: i.injury, week: i.week }));
  for (const p of prospects) {
    const st = statusOf(p.id);
    const row = injuryRows.find((i) => i.id === p.id);
    if (st) p.injury = { status: st.status, practice: row?.practice ?? null, injury: row?.injury ?? null, week: raw.week };
  }

  const elo = eloPregame(raw.id);
  const homeElo = elo?.home ?? eloCurrent(raw.home) ?? null;
  const awayElo = elo?.away ?? eloCurrent(raw.away) ?? null;
  const rebuilt = projectGame({
    homeAvail: availability?.home,
    awayAvail: availability?.away,
    home,
    away,
    homeElo,
    awayElo,
    neutral,
    market,
    matchups,
    homeSchool: raw.home,
    awaySchool: raw.away,
    homePassRate: styleFor(raw.home)?.raw.off.passRate,
    awayPassRate: styleFor(raw.away)?.raw.off.passRate,
    homeAdv: styleFor(raw.home)?.raw,
    awayAdv: styleFor(raw.away)?.raw,
    means: charted ? leagueMeans("nfl") : undefined,
    weather,
  });
  // Once a game kicks off, the call on screen is the locked pregame call (the one the record grades), not a rebuild from today's data.
  const lockedPre = status !== "upcoming" ? readEntry(raw.season, raw.id)?.pregame : undefined;
  const projection = (lockedPre && lockedProjection(lockedPre)) || rebuilt;
  const consensus = await buildConsensus({
    gameId: raw.id, season: raw.season, week: raw.week, seasonType: raw.type === "REG" ? "regular" : "postseason", home, away, homeSchool: raw.home, awaySchool: raw.away, neutral,
    homeElo, awayElo, market, projection, homeAdv: styleFor(raw.home)?.raw, awayAdv: styleFor(raw.away)?.raw, means: charted ? leagueMeans("nfl") : undefined,
  }).catch(() => undefined);

  // Keep an eye on: watch names that did not make the main list.
  const inMain = new Set(prospects.map((p) => p.id));
  const offInMain = new Set(offenseRadar.map((p) => p.id));
  const eye = [
    ...radarForTeam(raw.away).filter((r) => !inMain.has(r.id) && !offInMain.has(r.id) && !sits(r.id) && OFFENSE_GROUPS.has(r.group)).slice(0, 2).map((r) => ({ r, abbr: away.abbr })),
    ...radarForTeam(raw.home).filter((r) => !inMain.has(r.id) && !offInMain.has(r.id) && !sits(r.id) && OFFENSE_GROUPS.has(r.group)).slice(0, 2).map((r) => ({ r, abbr: home.abbr })),
  ].map(({ r, abbr }) => ({
    name: r.name,
    team: abbr,
    note: `${r.pos}, ${r.cls}. ${r.evidence[0]?.label ?? "No production yet"}${r.evidence[1] ? `. ${r.evidence[1].label}` : ""}. ${r.eligibilityNote}`,
  }));

  const stakes = deriveStakes(raw, home, away, homeSt, awaySt);
  const ctx: Ctx = { edges: matchups, prospects, market, weather, home, away, homeElo, awayElo, network, status, raw, homeSt, awaySt, stakes };
  const why = deriveWhyWatch(ctx);
  const scoreComponents = deriveComponents(ctx);

  // Box score once the game is final (game page only); the ESPN in-game box until then.
  let box: Game["box"];
  if (bs) {
    box = {
      source: bs.source,
      teams: bs.teams.map((t) => ({ team: t.team, abbr: t.team === raw.home ? home.abbr : away.abbr, points: t.points, leaders: t.leaders.map((l) => ({ id: l.id, name: l.name || radarPlayer(l.id)?.name || l.id, category: l.category, headline: l.headline })) })),
    };
    for (const p of prospects) {
      const lines = bs.byPlayer.get(p.id);
      if (lines?.length) p.lines = lines.map((l) => ({ category: l.category, headline: l.headline }));
    }
  } else if (espnDetail && espnDetail.box.some((t) => t.leaders.length)) {
    box = {
      source: "espn",
      teams: espnDetail.box.map((t) => ({
        team: t.homeAway === "home" ? home.short : away.short,
        abbr: t.homeAway === "home" ? home.abbr : away.abbr,
        points: t.homeAway === "home" ? espnDetail.home.score : espnDetail.away.score,
        leaders: t.leaders.map((l) => ({ id: l.id, name: l.name, category: l.category, headline: l.headline })),
      })),
    };
    for (const p of prospects) {
      const lines = espnDetail.byPlayer[p.id];
      if (lines?.length) p.lines = lines;
    }
  }

  const sitHome = situationsFor(raw.home);
  const sitAway = situationsFor(raw.away);
  const situations = sitHome && sitAway ? { home: sitHome, away: sitAway, cues: gameCues(raw.away, raw.home) } : undefined;

  const coverage: Coverage = charted ? "Full" : generatedLoaded() ? "Standard" : "Limited";
  const gaps: string[] = [];
  if (status !== "final" && !espnLive) gaps.push("Live score and clock come from ESPN once the game kicks off. Status is schedule-based until then.");
  if (!generatedLoaded()) gaps.push("Rosters, stats, and tendencies are not ingested. Run npm run ingest.");
  else if (!charted) gaps.push("Play-by-play has not been ingested for one of these teams. Style and matchup scores are excluded.");
  if (generatedLoaded() && !prospects.length) gaps.push("No player from either team clears the radar threshold yet.");
  if (!market.spread) gaps.push("No line on file for this game.");
  else if (market.books === 1) gaps.push("Line is the nflverse schedule number; no Odds API snapshot yet for the current market.");
  if (!weather && status !== "final" && roof !== "fixed") gaps.push(!venue ? "No forecast: venue is not on file." : !venue.nws ? "No forecast: the venue is outside National Weather Service coverage." : "No forecast: kickoff is outside the 7-day hourly window or the weather service did not answer.");
  if (!espnRow?.network) gaps.push("Broadcast network comes from ESPN's scoreboard, which has not listed it yet.");

  const restNote = (t: Team, rest: number | null) => (rest == null ? undefined : rest <= 5 ? `The ${t.short} are on a short week (${rest} days of rest).` : rest >= 13 ? `The ${t.short} are coming off the bye (${rest} days of rest).` : undefined);
  const storylines = [
    ...stakes,
    ...(neutral ? [`Neutral site: ${raw.stadium ?? "venue TBA"}${venue ? `, ${venue.city}` : ""}.`] : []),
    ...[restNote(away, raw.awayRest), restNote(home, raw.homeRest)].filter((x): x is string => Boolean(x)),
    ...(availability?.away.qb && availability.home.qb ? [`Expected quarterbacks: ${availability.away.qb.expected} (${away.abbr}) and ${availability.home.qb.expected} (${home.abbr}).`] : []),
    // Radar names who will not play: left off the watch list, so say why here.
    ...[...radarForGame(raw.away).map((r) => ({ r, abbr: away.abbr })), ...radarForGame(raw.home).map((r) => ({ r, abbr: home.abbr }))]
      .filter(({ r }) => sits(r.id))
      .map(({ r, abbr }) => `${r.name} (${abbr} ${r.pos}) is ${statusOf(r.id)!.status}${statusOf(r.id)!.source ? ` per ${statusOf(r.id)!.source === "ESPN" ? "ESPN" : "the official report"}` : ""} and off the watch list.`),
  ];

  return {
    id: raw.id,
    division,
    home,
    away,
    kickoff: raw.kickoff,
    venue: raw.stadium ?? venue?.name ?? "Venue TBA",
    city: venue ? [venue.city, venue.state].filter(Boolean).join(", ") : espnRow?.city ?? "",
    network,
    status,
    score,
    coverage,
    whyWatch: why.headline,
    whyWatchReasons: why.reasons,
    whyWatchRead: why.read,
    styleLine: charted ? `${shortStyle(profAway.off.label)} O vs ${shortStyle(profHome.def.label)} D` : undefined,
    weather,
    market,
    prospects,
    offenseRadar,
    defenseRadar,
    kickers,
    matchups,
    keepAnEyeOn: eye,
    ...(withBox ? await whoToWatch(raw, home, away, [...matchupPicks.filter(isGroup(OFFENSE_GROUPS)), ...offenseSpot], sits, availability, venue, neutral).catch(() => ({})) : {}),
    storylines,
    offense: { [home.abbr]: profHome.off, [away.abbr]: profAway.off },
    defense: { [home.abbr]: profHome.def, [away.abbr]: profAway.def },
    pressurePoint: pp ?? "Play-by-play not ingested for both teams yet. The report does not guess a scheme.",
    scoreComponents,
    gaps,
    projection,
    consensus,
    box,
    live: espnLive && espnLive.state !== "pre"
      ? {
          period: espnLive.period,
          clock: espnLive.detail,
          possession: espnLive.possession,
          down: espnLive.down,
          distance: espnLive.distance,
          yardLine: espnLive.yardLine,
          downDistance: espnLive.downDistance,
          lastPlay: espnLive.lastPlay,
          homeWinProb: espnLive.homeWinProb,
          awayWinProb: espnLive.awayWinProb,
          swing: espnLive.swing,
          swingMinutes: espnLive.swingMinutes,
          closeness: espnLive.closeness,
          broadcast: espnLive.broadcast,
          asOf: espnLive.asOf,
        }
      : undefined,
    liveDetail: espnDetail,
    situations,
    statsAsOf: genMeta()?.ingestedAt,
    reportAsOf: builtAt,
    source: "live",
    week: raw.week,
    weekLabel: b.week.label,
    divGame: raw.divGame,
    rest: { home: raw.homeRest, away: raw.awayRest },
    injuryReport,
    availability,
    stakes,
  };
}

/* ------------------------------------------------------------- public */

function emptySlate(notes: string[]): Slate {
  const today = etDate();
  return { source: "live", polls: [], season: seasonFor(today), date: today, days: [], games: [], weekGames: [], notes };
}

export async function getSlate(dateParam?: string): Promise<Slate> {
  if (!scheduleLoaded()) return emptySlate(["The nflverse schedule is not ingested yet. Run npm run ingest in web/."]);
  const today = etDate();
  const requested = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;
  // The assembled slate is memoized briefly so navigating between pages does not rebuild the week each time.
  return memo(`slate:${requested}`, (s) => slateTtlSeconds(s.games), () => buildSlate(requested));
}

async function buildSlate(requested: string): Promise<Slate> {
  const season = seasonFor(requested);
  const cal = calendar(season);
  const week = pickWeek(cal, requested);
  if (!week) return { ...emptySlate(["No schedule for this season."]), season, date: requested };

  const b = await loadWeek(season, week);
  const dayCounts = new Map<string, number>();
  for (const g of b.games) {
    const d = etDate(new Date(g.kickoff));
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const days = [...dayCounts].map(([date, count]) => ({ date, count })).sort((a, c) => a.date.localeCompare(c.date));

  let date = requested;
  if (!dayCounts.has(date)) {
    const next = days.find((d) => d.date >= requested);
    date = next?.date ?? days[days.length - 1]?.date ?? requested;
  }

  const todays = b.games.filter((g) => etDate(new Date(g.kickoff)) === date);
  const others = b.games.filter((g) => etDate(new Date(g.kickoff)) !== date);

  const built: Game[] = new Array(todays.length);
  await forecastMany(
    todays.map((g, i) => ({ g, i })),
    6,
    async ({ g, i }) => {
      built[i] = await buildGame(g, b, true);
    },
  );
  const rest = await Promise.all(others.map((g) => buildGame(g, b, false)));

  // Accountability: lock every upcoming call, grade every final that has one. Never blocks the page on failure.
  try {
    for (let i = 0; i < todays.length; i++) {
      const raw = todays[i];
      const g = built[i];
      if (g.status === "upcoming") lockPregame(g, raw.season);
      else if (g.status === "final" && readEntry(raw.season, g.id) && !readEntry(raw.season, g.id)?.postgame) {
        const bs = await boxScore(g.id);
        if (bs) gradePostgame(g, raw.season, bs, null);
      }
    }
  } catch {}

  const notes: string[] = [];
  if (!generatedLoaded()) notes.push("Rosters, stats, and tendencies are not ingested yet. Run npm run ingest in web/ to light up the radar.");
  else {
    const m = genMeta()!;
    notes.push(`Radar and tendencies use nflverse stats ingested ${new Date(m.ingestedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", timeZone: ET })} ET${m.statsThroughWeek ? `, player stats through week ${m.statsThroughWeek}` : ""}${m.pbpThroughWeek ? `, play-by-play through week ${m.pbpThroughWeek}` : ""}${m.latestWeek && m.latestWeek.posted < m.latestWeek.final ? ` (${m.latestWeek.posted} of ${m.latestWeek.final} week ${m.latestWeek.week} finals posted so far; the rest land when nflverse posts them)` : ""}.`);
  }
  notes.push("Lines: the nflverse schedule number is the opening reference; The Odds API snapshots (every 6 hours Thu to Mon) are the current market.");

  const weekGames = [...built, ...rest];
  return { source: "live", polls: [], season, week, date, days, games: built, weekGames, notes, finals: b.finals };
}

export async function getGame(id: string): Promise<Game | undefined> {
  if (!scheduleLoaded()) return undefined;
  if (!/^[\w-]+$/.test(id)) return undefined;
  // 30 s while a game can still change; 10 minutes once it is final (each rebuild re-fetches the ESPN summary).
  return memo(`game:${id}`, (g) => (g?.status === "final" ? 600 : 30), () => buildGameById(id));
}

async function buildGameById(id: string): Promise<Game | undefined> {
  const raw = gameById(id);
  if (!raw) return undefined;
  const cal = calendar(raw.season);
  const week = cal.find((w) => w.week === raw.week && w.seasonType === (raw.type === "REG" ? "regular" : "postseason")) ?? pickWeek(cal, etDateOf(raw.kickoff));
  if (!week) return undefined;
  const b = await loadWeek(raw.season, week, [raw]);
  const game = await buildGame(raw, b, true, true);
  try {
    if (game.status === "upcoming") game.archive = lockPregame(game, raw.season);
    else if (game.status === "final" && game.box) {
      const bs = await boxScore(game.id);
      game.archive = bs ? gradePostgame(game, raw.season, bs, null) : readEntry(raw.season, game.id);
    } else game.archive = readEntry(raw.season, game.id);
  } catch {}
  game.odds = await gameOdds(game, raw.season).catch(() => undefined);
  return game;
}

export async function getPlayer(id: string): Promise<{ player: Prospect; game?: Game } | undefined> {
  const r = radarPlayer(id);
  if (!r) return undefined;
  const slate = await getSlate();
  const game = slate.weekGames.find((g) => g.home.short === r.team || g.away.short === r.team);
  const abbr = game ? (game.home.short === r.team ? game.home.abbr : game.away.abbr) : teamByShort(r.team)?.abbr ?? r.team.slice(0, 3).toUpperCase();
  const p = radarToProspect(r, abbr);
  const inGame = game?.prospects.find((x) => x.id === id);
  if (inGame?.lines) p.lines = inGame.lines;
  return { player: p, game };
}

/** Lookup used by the radar page to link each player to this week's game. */
export async function gameIndexForWeek(): Promise<Map<string, Game>> {
  const slate = await getSlate();
  const m = new Map<string, Game>();
  for (const g of slate.weekGames) {
    m.set(g.home.short, g);
    m.set(g.away.short, g);
  }
  return m;
}

/* ------------------------------------------------------------ who to watch */

/** DK points a game, this season blended with last at 3 games (the DraftKings lens's base): one scale for every skill position. */
function dkPerGame(p: GenPlayer): number {
  const now = p.s?.gp ? dkPoints(p.s) / p.s.gp : undefined;
  const prior = p.ps?.gp && p.ps.gp >= 4 ? dkPoints(p.ps) / p.ps.gp : undefined;
  if (now !== undefined && prior !== undefined) return (now * p.s!.gp! + prior * 3) / (p.s!.gp! + 3);
  return now ?? prior ?? 0;
}

/** A season line under a Who to watch row: the box-score line, games played, and snap share. */
function detailLine(p: GenPlayer): string {
  const group = groupOf(p);
  const gp = p.s?.gp ?? 0;
  const parts: string[] = [];
  if (group && group !== "OL" && p.s) {
    // Zero counts are noise ("0 TFL, 0 sacks"); keep the first piece so a quiet line still says something.
    const bits = statLine(p.s, group).line.split(", ");
    const kept = bits.filter((b, i) => i === 0 || !/^0 /.test(b)).map((b) => b.replace(/^1 (sacks|QB hits)$/, (_, w: string) => `1 ${w.slice(0, -1)}`));
    parts.push(`${kept.join(", ")}${gp ? ` in ${gp} game${gp === 1 ? "" : "s"}` : ""}`);
  }
  const off = p.u?.o ?? 0;
  const def = p.u?.d ?? 0;
  // Snap share averages only the games with a snap row; when the snap feed missed some of his games it misleads, so skip it.
  if (Math.max(off, def) > 0 && (p.u?.gs ?? 0) >= gp) parts.push(`${Math.round(Math.max(off, def) * 100)}% of ${off >= def ? "offensive" : "defensive"} snaps`);
  return parts.join(" · ");
}

/**
 * Why the other team's top skill player matters, in one sentence: his load, where it ranks at his position this season
 * (players with two or more games), and the defense he faces tonight (success rate allowed, No. 1 = best defense).
 */
function starLine(p: GenPlayer, opp: string): string {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const gp = Math.max(1, p.s?.gp ?? 0);
  const per = (q: GenPlayer) => {
    const g = Math.max(1, q.s?.gp ?? 0);
    return p.pg === "QB" ? (q.s?.py ?? 0) / g : p.pg === "RB" ? ((q.s?.ry ?? 0) + (q.s?.rcy ?? 0)) / g : (q.s?.rcy ?? 0) / g;
  };
  const rank = (p.s?.gp ?? 0) >= 2 ? 1 + genPlayers().filter((q) => q.pg === p.pg && (q.s?.gp ?? 0) >= 2 && per(q) > per(p)).length : undefined;
  const among = p.pg === "QB" ? "in the NFL" : p.pg === "RB" ? "among backs" : p.pg === "TE" ? "among tight ends" : "among receivers";
  const rk = rank && rank <= 20 ? ` (No. ${rank} ${among})` : "";
  const d = styleFor(opp)?.defense.metrics.find((m) => m.key === (p.pg === "RB" ? "rushSr" : "passSr"));
  const vs = d?.rank ? `, against a ${opp} ${p.pg === "RB" ? "run" : "pass"} defense ranked No. ${d.rank} of ${d.of}` : "";
  if (p.pg === "QB") return `The ${p.t} quarterback: ${Math.round(per(p))} pass yards a game${rk}${vs}.`;
  if (p.pg === "RB") return `${r1((p.s?.ra ?? 0) / gp)} carries and ${r1((p.s?.tgt ?? 0) / gp)} targets a game, ${Math.round(per(p))} yards from scrimmage${rk}${vs}.`;
  const share = p.s?.tshare ? `${Math.round(p.s.tshare * 100)}% of the ${p.t} targets, ` : "";
  return `${share}${Math.round(per(p))} receiving yards a game${rk}${vs}.`.replace(/^./, (c) => c.toUpperCase());
}

/**
 * The read's names. Tier 1: the player the biggest matchup runs through. Tier 2: the other team's top skill player (the
 * best DK points a game among backs, receivers, tight ends, and the expected starting quarterback). Tier 3, up to three:
 * storylines (revenge game, homecoming, college ties, mixed by kind), then a role change (a starter just went out and
 * this player takes his work); with none, the next top skill player. Nobody who is expected to sit.
 */
async function whoToWatch(raw: GenGame, home: Team, away: Team, matchupPicks: Prospect[], sits: (id: string) => boolean, availability: GameAvailability | undefined, venue: Venue | undefined, neutral: boolean): Promise<Pick<Game, "whoToWatch" | "storyNotes">> {
  const abbrOf = (team: string) => (team === raw.home ? home.abbr : away.abbr);
  const oppOf = (team: string) => (team === raw.home ? raw.away : raw.home);
  const byId = new Map(genPlayers().map((p) => [p.id, p]));
  const detailOf = (id: string) => {
    const p = byId.get(id);
    return p ? detailLine(p) || undefined : undefined;
  };
  const starters = new Set([availability?.home.qb?.expected, availability?.away.qb?.expected].filter(Boolean));
  const roster = genPlayers().filter((p) => (p.t === raw.home || p.t === raw.away) && !sits(p.id));
  const skill = roster.filter((p) => ["RB", "WR", "TE"].includes(p.pg ?? "") || (p.pg === "QB" && starters.has(p.n))).filter((p) => (p.s?.gp ?? 0) >= 1).sort((a, b) => dkPerGame(b) - dkPerGame(a));
  const out: NonNullable<Game["whoToWatch"]> = [];
  const used = new Set<string>();
  const add = (row: NonNullable<Game["whoToWatch"]>[number]) => {
    out.push(row);
    used.add(row.id);
  };

  // Tier 1 and 2.
  const m = matchupPicks.find((p) => !sits(p.id));
  if (m) add({ id: m.id, name: m.name, pos: m.pos, team: m.team, label: m.matchupSide === "against" ? "Tough matchup" : "Key matchup", reason: m.lensNote ?? "", detail: detailOf(m.id) });
  const mTeam = m ? (m.team === home.abbr ? raw.home : raw.away) : undefined;
  const top = skill.find((p) => !used.has(p.id) && (!mTeam || p.t !== mTeam));
  if (top) add({ id: top.id, name: top.n, pos: top.p ?? top.pg ?? "", team: abbrOf(top.t), label: "Top player", reason: starLine(top, oppOf(top.t)), detail: detailLine(top) || undefined });

  // Tier 3: storylines, prominent players first (snap share), anyone already listed left out.
  const TIER3 = 3;
  const prominence = (p: GenPlayer) => Math.max(p.u?.o ?? 0, p.u?.d ?? 0) + (skill.includes(p) ? 0.5 : 0);
  // A storyline needs a player who is on the field: 30% of his side's snaps or more.
  const candidates = roster.filter((p) => !used.has(p.id) && Math.max(p.u?.o ?? 0, p.u?.d ?? 0) >= 0.3).sort((a, b) => prominence(b) - prominence(a));
  // Derek's rule: a storyline earns a slot only for the quarterback, backs, and receivers, the players whose game moves
  // the score. Defenders, linemen, and tight ends with a storyline get one footnote line under the list instead.
  // Sequential on purpose: both calls read and write the ESPN bio cache.
  const STORY_POS = new Set(["QB", "RB", "WR"]);
  const storyArgs = { home: raw.home, away: raw.away, neutral, season: raw.season, venue: venue ? { city: venue.city, state: venue.state } : undefined };
  const stories = await gameStories({ ...storyArgs, candidates: candidates.filter((p) => STORY_POS.has(p.pg ?? "")), max: TIER3 }).catch(() => []);
  for (const st of stories) add({ id: st.id, name: st.name, pos: st.pos, team: abbrOf(st.team), label: st.label, reason: st.text, detail: detailOf(st.id) });
  const others = await gameStories({ ...storyArgs, candidates: candidates.filter((p) => !STORY_POS.has(p.pg ?? "")), max: 4 }).catch(() => []);
  const storyNotes = others.map((st) => ({ id: st.id, name: st.name, pos: st.pos, team: abbrOf(st.team), label: st.label, text: st.text }));
  // A role change: a back, receiver, or tight end who played the last game is out now. The teammate who gained the most
  // in the games he missed (src/lib/vacated.ts) steps in; with no such games, his busiest healthy teammate at the position.
  let tier3 = stories.length;
  for (const side of [availability?.away, availability?.home]) {
    if (tier3 >= TIER3) break;
    const gone = side?.items.find((i) => i.kind === "out" && i.fresh && i.absence >= 0.85 && ["RB", "WR", "TE"].includes(byId.get(i.id)?.pg ?? ""));
    if (!gone) continue;
    const pg = byId.get(gone.id)!.pg ?? "";
    const v = vacatedFor(side!.team, [{ id: gone.id, status: gone.status }])[0];
    const riser = v?.without?.risers.find((r) => !used.has(r.id) && !sits(r.id));
    const n = v?.without?.games.length ?? 0;
    if (riser) {
      add({ id: riser.id, name: riser.name, pos: riser.pos, team: abbrOf(side!.team), label: "Role change", reason: `In ${n} ${n === 1 ? "game" : "games"} without ${gone.name}: ${riserShort(riser, pg)}.`, detail: detailOf(riser.id) });
      tier3++;
      continue;
    }
    const mate = roster.filter((p) => p.t === side!.team && p.pg === pg && !used.has(p.id) && p.id !== gone.id).sort((a, b) => (b.u?.o ?? 0) - (a.u?.o ?? 0))[0];
    if (mate) {
      const open = v ? shareText(v, true) : "";
      add({ id: mate.id, name: mate.n, pos: mate.p ?? mate.pg ?? "", team: abbrOf(mate.t), label: "Role change", reason: `Takes on more work with ${gone.name} ${absentWords(gone.status)}${open ? `, who leaves ${open}` : ""}.`, detail: detailLine(mate) || undefined });
      tier3++;
    }
  }
  if (!tier3) {
    const next = skill.find((p) => !used.has(p.id));
    if (next) add({ id: next.id, name: next.n, pos: next.p ?? next.pg ?? "", team: abbrOf(next.t), label: "Top player", reason: starLine(next, oppOf(next.t)), detail: detailLine(next) || undefined });
  }
  return { whoToWatch: out, storyNotes: storyNotes.filter((n) => !used.has(n.id)) };
}
