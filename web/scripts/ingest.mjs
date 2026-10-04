/**
 * Ingest: pull the nflverse release files (free, public, no key) once, cache the raw
 * CSVs in data/cache/, and write compact digests to data/generated/. The site reads
 * the digests instantly and never fetches nflverse at request time.
 *
 *   node scripts/ingest.mjs              # this season; downloads what is not cached
 *   REFRESH=1 node scripts/ingest.mjs    # re-download every file (do this weekly; files move Mon/Tue)
 *   SEASON=2025 node scripts/ingest.mjs
 *
 * Sources (https://github.com/nflverse/nflverse-data/releases):
 *   schedules/games.csv                     every game 1999 to now: scores, closing spread_line and total_line,
 *                                           moneylines, roof, surface, stadium, rest days, ESPN id (`espn`)
 *   rosters/roster_<season>.csv             gsis_id, espn_id, name, position, team, jersey, status, years_exp,
 *                                           rookie_year, draft_number, draft_club, college, height, weight
 *   stats_player/stats_player_week_<s>.csv  per player per week: passing, rushing, receiving, defense, kicking,
 *                                           EPA, CPOE, target share, air yards share, WOPR (this season and last)
 *   pbp/play_by_play_<season>.csv           every play with epa, success, down, distance, yardline, pass/rush
 *   ftn_charting/ftn_charting_<season>.csv  FTN charting: blitzers, pass rushers, play action, motion, screens
 *   snap_counts/snap_counts_<season>.csv    offense and defense snap share per player per game
 *   injuries/injuries_<season>.csv          official reports: game status (Out, Doubtful, Questionable), practice status
 *   depth_charts/depth_charts_<season>.csv  daily depth charts (we keep the latest snapshot)
 *   draft_picks/draft_picks.csv             every draft pick with gsis_id
 *
 * Writes (data/generated/):
 *   schedule.json    every game 2019 to now, mapped to our shape (id = ESPN game id)
 *   teams.json       per team offense and defense tendencies computed from play-by-play (GenTeam shape)
 *   players.json     every player we track with season stats, last season's stats, usage, draft slot, injury status
 *   gamelogs.json    per player per game lines (opponent adjustment, box scores, grading)
 *   situational.json per team situational splits from play-by-play (same shape the college app used)
 *   draft.json       the last five draft classes
 *   injuries.json    the latest official injury report per team
 *   elo.json         our Elo (see scripts/lib/elo.mjs) pregame per game and current per team
 *   meta.json        timestamps and counts
 */
import { mkdir, writeFile, access, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num, int, bool } from "./lib/csv.mjs";
import { computeElo } from "./lib/elo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "generated");
const BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const REFRESH = !!process.env.REFRESH;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

const now = new Date();
const season = Number(process.env.SEASON ?? (now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1));
const prev = season - 1;
log("season", season);

/* ------------------------------------------------------------ teams table */
const TEAMS = JSON.parse(readFileSync(path.join(root, "data", "nfl-teams.json"), "utf8"));
const byCode = new Map(TEAMS.teams.map((t) => [t.code, t]));
/** Historical and other-source codes to the current nflverse code. */
const CODE_ALIAS = {
  OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA", WSH: "WAS", JAC: "JAX", HST: "HOU", BLT: "BAL", CLV: "CLE", ARZ: "ARI", SL: "LA",
  GNB: "GB", KAN: "KC", LVR: "LV", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB", SDG: "LAC", RAI: "LV", RAM: "LA", CRD: "ARI", RAV: "BAL",
  CLT: "IND", HTX: "HOU", OTI: "TEN", NYG: "NYG", NYJ: "NYJ",
};
const code = (c) => (byCode.has(c) ? c : CODE_ALIAS[c] ?? c);
const nick = (c) => byCode.get(code(c))?.short ?? c;

/* ------------------------------------------------------------- download */
const FILES = [
  ["schedules/games.csv", "games.csv"],
  [`rosters/roster_${season}.csv`, `roster_${season}.csv`],
  [`rosters/roster_${prev}.csv`, `roster_${prev}.csv`],
  [`stats_player/stats_player_week_${season}.csv`, `stats_player_week_${season}.csv`],
  [`stats_player/stats_player_week_${prev}.csv`, `stats_player_week_${prev}.csv`],
  [`injuries/injuries_${season}.csv`, `injuries_${season}.csv`],
  [`depth_charts/depth_charts_${season}.csv`, `depth_charts_${season}.csv`],
  [`snap_counts/snap_counts_${season}.csv`, `snap_counts_${season}.csv`],
  ["draft_picks/draft_picks.csv", "draft_picks.csv"],
  [`ftn_charting/ftn_charting_${season}.csv`, `ftn_charting_${season}.csv`, { optional: true }],
  [`pbp/play_by_play_${season}.csv`, `play_by_play_${season}.csv`],
];

async function download(rel, name, { optional = false } = {}) {
  const file = path.join(CACHE, name);
  if (!REFRESH && (await exists(file))) return file;
  const url = `${BASE}/${rel}`;
  log("download", rel);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    if (optional) {
      log("skip (not published)", rel, res.status);
      return undefined;
    }
    throw new Error(`${url} -> ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`${file}.part`, buf);
  await rename(`${file}.part`, file);
  log("saved", name, `${(buf.length / 1e6).toFixed(1)} MB`);
  return file;
}

await mkdir(CACHE, { recursive: true });
await mkdir(OUT, { recursive: true });
const local = {};
for (const [rel, name, opts] of FILES) local[name] = await download(rel, name, opts); // sequential on purpose

/* ------------------------------------------------------------- schedule */

/** Eastern time to ISO. EDT from the second Sunday of March to the first Sunday of November. */
function etToIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const nthSunday = (year, month, n) => {
    const first = new Date(Date.UTC(year, month, 1));
    const day = first.getUTCDay();
    return 1 + ((7 - day) % 7) + (n - 1) * 7;
  };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7); // 2am EST = 07:00Z
  const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); // 2am EDT = 06:00Z
  const [hh, mm] = (timeStr || "13:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const edt = guess >= dstStart && guess < dstEnd;
  return new Date(guess + (edt ? 4 : 5) * 3600 * 1000).toISOString();
}

const scheduleRows = await readCsv(local["games.csv"]);
const schedule = [];
const espnByGid = new Map();
for (const r of scheduleRows) {
  const s = Number(r.season);
  if (s < 2019) continue;
  const id = r.espn || `nv-${r.game_id}`;
  espnByGid.set(r.game_id, id);
  const hs = int(r.home_score);
  const as = int(r.away_score);
  schedule.push({
    id,
    gid: r.game_id,
    season: s,
    type: r.game_type === "REG" ? "REG" : "POST",
    round: r.game_type,
    week: Number(r.week),
    kickoff: etToIso(r.gameday, r.gametime),
    date: r.gameday,
    time: r.gametime || null,
    away: nick(r.away_team),
    home: nick(r.home_team),
    awayCode: code(r.away_team),
    homeCode: code(r.home_team),
    as,
    hs,
    played: hs != null && as != null,
    result: int(r.result),
    total: int(r.total),
    ot: r.overtime === "1",
    location: r.location,
    neutral: r.location === "Neutral",
    spread: num(r.spread_line),
    totalLine: num(r.total_line),
    aml: int(r.away_moneyline),
    hml: int(r.home_moneyline),
    divGame: r.div_game === "1",
    roof: r.roof || null,
    surface: r.surface || null,
    temp: int(r.temp),
    wind: int(r.wind),
    stadium: r.stadium || null,
    stadiumId: r.stadium_id || null,
    awayRest: int(r.away_rest),
    homeRest: int(r.home_rest),
    awayQb: r.away_qb_name || null,
    homeQb: r.home_qb_name || null,
    awayCoach: r.away_coach || null,
    homeCoach: r.home_coach || null,
    referee: r.referee || null,
  });
}
schedule.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
const thisSeason = schedule.filter((g) => g.season === season);
const gamesById = new Map(schedule.map((g) => [g.id, g]));
log("schedule rows", schedule.length, "this season", thisSeason.length);

const gamesPlayedBy = new Map();
for (const g of thisSeason) {
  if (!g.played) continue;
  gamesPlayedBy.set(g.home, (gamesPlayedBy.get(g.home) ?? 0) + 1);
  gamesPlayedBy.set(g.away, (gamesPlayedBy.get(g.away) ?? 0) + 1);
}

/* ------------------------------------------------------------------ elo */
const elo = computeElo(schedule);
const eloOut = {
  asOf: new Date().toISOString(),
  k: 20,
  home: 48,
  regress: "1/3 to 1500 each new season",
  perPoint: 25,
  teams: Object.fromEntries([...elo.teams].map(([t, r]) => [t, Math.round(r)])),
  pregame: Object.fromEntries(elo.pregame),
};
log("elo computed for", elo.pregame.size, "games");

/* --------------------------------------------------------------- rosters */
const normName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function loadRoster(file) {
  const byGsis = new Map();
  await readCsv(file, (r) => {
    const g = r.gsis_id;
    if (!g) return;
    const wk = Number(r.week || 0);
    const cur = byGsis.get(g);
    if (!cur || wk >= cur._wk) byGsis.set(g, { ...r, _wk: wk });
  });
  return byGsis;
}
const roster = await loadRoster(local[`roster_${season}.csv`]);
const rosterPrev = await loadRoster(local[`roster_${prev}.csv`]);
log("roster", roster.size, "prev roster", rosterPrev.size);
const espnOf = (gsis) => roster.get(gsis)?.espn_id || rosterPrev.get(gsis)?.espn_id || "";
/** Player id used across the site: the ESPN athlete id (headshots, live box score), else the gsis id. */
const pidOf = (gsis) => espnOf(gsis) || gsis;

/* ---------------------------------------------------------- depth charts */
const depth = new Map(); // gsis -> { pos, rank, grp }
{
  const latestDt = new Map(); // team -> dt
  const rows = [];
  await readCsv(local[`depth_charts_${season}.csv`], (r) => {
    const t = code(r.team);
    const dt = r.dt;
    if (!latestDt.has(t) || dt > latestDt.get(t)) latestDt.set(t, dt);
    rows.push(r);
  });
  for (const r of rows) {
    if (r.dt !== latestDt.get(code(r.team))) continue;
    if (!r.gsis_id) continue;
    const rank = int(r.pos_rank) ?? 99;
    const cur = depth.get(r.gsis_id);
    // A player can sit on several slots; keep his best rank on the base chart.
    if (!cur || rank < cur.rank) depth.set(r.gsis_id, { pos: r.pos_abb, rank, grp: r.pos_grp, espn: r.espn_id });
  }
  log("depth chart rows", rows.length, "players", depth.size, "snapshot", [...latestDt.values()].sort().pop());
}

/* -------------------------------------------------------------- injuries */
const injuries = [];
{
  const rows = await readCsv(local[`injuries_${season}.csv`]);
  const latestWeek = new Map();
  for (const r of rows) latestWeek.set(code(r.team), Math.max(latestWeek.get(code(r.team)) ?? 0, Number(r.week)));
  for (const r of rows) {
    const t = code(r.team);
    if (Number(r.week) !== latestWeek.get(t)) continue;
    const st = r.report_status || null;
    const pr = r.practice_status || null;
    if (!st && !/did not|limited/i.test(pr ?? "")) continue;
    injuries.push({
      team: nick(t),
      gsis: r.gsis_id,
      id: pidOf(r.gsis_id),
      name: r.full_name,
      pos: r.position,
      status: st,
      practice: pr,
      injury: r.report_primary_injury || r.practice_primary_injury || null,
      week: Number(r.week),
      seasonType: r.season_type,
    });
  }
  log("injury rows (latest week per team)", injuries.length);
}
const injuryByGsis = new Map(injuries.map((i) => [i.gsis, i]));

/* ----------------------------------------------------------- snap counts */
const snapsByKey = new Map(); // `${team}|${normName}` -> { games, off, def, st }
{
  const rows = await readCsv(local[`snap_counts_${season}.csv`]);
  for (const r of rows) {
    const k = `${code(r.team)}|${normName(r.player)}`;
    const e = snapsByKey.get(k) ?? snapsByKey.set(k, { games: 0, off: 0, def: 0, st: 0, offSnaps: 0, defSnaps: 0 }).get(k);
    e.games++;
    e.off += num(r.offense_pct) ?? 0;
    e.def += num(r.defense_pct) ?? 0;
    e.st += num(r.st_pct) ?? 0;
    e.offSnaps += int(r.offense_snaps) ?? 0;
    e.defSnaps += int(r.defense_snaps) ?? 0;
  }
  log("snap count rows", rows.length);
}

/* ------------------------------------------------------- player stats */
/** nflverse weekly columns to the compact keys the site reads (college keys kept where the stat is the same). */
const SUM = {
  attempts: "pa", completions: "pc", passing_yards: "py", passing_tds: "ptd", passing_interceptions: "pint", sacks_suffered: "sks", passing_epa: "pepa", passing_first_downs: "pfd", passing_air_yards: "pay",
  carries: "ra", rushing_yards: "ry", rushing_tds: "rtd", rushing_epa: "repa", rushing_first_downs: "rfd",
  receptions: "rec", targets: "tgt", receiving_yards: "rcy", receiving_tds: "rctd", receiving_epa: "rcepa", receiving_air_yards: "rays", receiving_yards_after_catch: "ryac", receiving_first_downs: "rcfd",
  def_tackles_solo: "solo", def_tackles_with_assist: "ast", def_tackle_assists: "tast", def_tackles_for_loss: "tfl", def_sacks: "sk", def_qb_hits: "hur", def_pass_defended: "pd", def_interceptions: "int", def_interception_yards: "inty", def_tds: "dtd", def_fumbles_forced: "ff", fumble_recovery_opp: "fr",
  fumbles_total: "fum", fumbles_lost_total: "fl",
  fg_made: "fgm", fg_att: "fga", pat_made: "xpm", pat_att: "xpa",
  pt_att: "pno", pt_yards: "pty", pt_inside_20: "pin20",
  special_teams_tds: "sttd", punt_return_yards: "pry", kickoff_return_yards: "kry",
};
const MAX = { fg_long: "fglg", pt_long: "ptlg" };
const MEAN = { target_share: "tshare", air_yards_share: "ayshare", wopr: "wopr", racr: "racr" };

function finish(s) {
  if (s.pa) { s.ypa = Math.round((s.py / s.pa) * 10) / 10; s.cmp = Math.round((s.pc / s.pa) * 1000) / 10; }
  if (s.ra) s.ypc = Math.round((s.ry / s.ra) * 10) / 10;
  if (s.rec) s.ypr = Math.round((s.rcy / s.rec) * 10) / 10;
  // Combined tackles the way books grade "tackles + assists": solo, plus tackles made with help, plus assists.
  if (s.solo !== undefined || s.ast !== undefined || s.tast !== undefined) s.tk = (s.solo ?? 0) + (s.ast ?? 0) + (s.tast ?? 0);
  if (s.fga) s.fgp = Math.round((s.fgm / s.fga) * 1000) / 10;
  if (s.pno) s.ypp = Math.round((s.pty / s.pno) * 10) / 10;
  if (s._cpoeW) { s.cpoe = Math.round((s._cpoe / s._cpoeW) * 10) / 10; }
  for (const k of Object.keys(s)) {
    if (k.startsWith("_")) delete s[k];
    else if (typeof s[k] === "number") s[k] = Math.round(s[k] * 1000) / 1000;
  }
  return s;
}

/** Aggregate one season's weekly file into season totals per player, plus per-game lines. */
async function loadStats(file, seasonYear, { lines = false } = {}) {
  const totals = new Map(); // gsis -> stats
  const means = new Map(); // gsis -> { key -> [sum, n] }
  const posOf = new Map(); // gsis -> latest position
  const teamOf = new Map();
  const gameLines = lines ? new Map() : undefined; // gsis -> [{...}]
  const games = new Map(); // gsis -> Set(game_id)
  await readCsv(file, (r) => {
    const g = r.player_id;
    if (!g) return;
    const s = totals.get(g) ?? totals.set(g, {}).get(g);
    const line = {};
    for (const [col, key] of Object.entries(SUM)) {
      const v = num(r[col]);
      if (v === null || v === 0) continue;
      s[key] = (s[key] ?? 0) + v;
      line[key] = v;
    }
    for (const [col, key] of Object.entries(MAX)) {
      const v = num(r[col]);
      if (v === null) continue;
      s[key] = Math.max(s[key] ?? 0, v);
      line[key] = v;
    }
    const m = means.get(g) ?? means.set(g, {}).get(g);
    for (const [col, key] of Object.entries(MEAN)) {
      const v = num(r[col]);
      if (v === null) continue;
      const e = m[key] ?? (m[key] = [0, 0]);
      e[0] += v;
      e[1]++;
      line[key] = Math.round(v * 1000) / 1000;
    }
    const att = num(r.attempts) ?? 0;
    const cpoe = num(r.passing_cpoe);
    if (att && cpoe !== null) { s._cpoe = (s._cpoe ?? 0) + cpoe * att; s._cpoeW = (s._cpoeW ?? 0) + att; }
    if (r.position) posOf.set(g, r.position);
    if (r.team) teamOf.set(g, { team: code(r.team), week: Number(r.week), st: r.season_type });
    (games.get(g) ?? games.set(g, new Set()).get(g)).add(r.game_id);
    if (gameLines) {
      const espn = espnByGid.get(r.game_id) ?? `nv-${r.game_id}`;
      const sched = gamesById.get(espn);
      const t = nick(r.team);
      (gameLines.get(g) ?? gameLines.set(g, []).get(g)).push({
        g: espn,
        wk: Number(r.week),
        st: r.season_type === "REG" ? "regular" : "postseason",
        t,
        opp: nick(r.opponent_team),
        ha: sched ? (sched.home === t ? "home" : "away") : "away",
        s: finish({ ...line, _cpoe: 0 }),
      });
    }
  });
  for (const [g, s] of totals) {
    const m = means.get(g) ?? {};
    for (const [key, [sum, n]] of Object.entries(m)) if (n) s[key] = sum / n;
    s.gp = games.get(g)?.size ?? 0;
    finish(s);
  }
  return { totals, posOf, teamOf, gameLines, seasonYear };
}

const statsNow = await loadStats(local[`stats_player_week_${season}.csv`], season, { lines: true });
const statsPrev = await loadStats(local[`stats_player_week_${prev}.csv`], prev);
log("stat players this season", statsNow.totals.size, "last season", statsPrev.totals.size);

/* ----------------------------------------------------------- draft picks */
const draftRows = await readCsv(local["draft_picks.csv"]);
const draftByGsis = new Map();
const draftOut = [];
for (const r of draftRows) {
  const yr = Number(r.season);
  if (yr < season - 4 || yr > season) continue;
  const row = {
    year: yr,
    round: Number(r.round),
    pick: Number(r.pick),
    overall: Number(r.pick),
    name: r.pfr_player_name,
    pos: r.position,
    college: r.college || null,
    conf: null,
    nfl: nick(r.team),
    nflCode: code(r.team),
    h: null,
    w: null,
    grade: null,
    prerank: null,
    collegeAthleteId: null,
    gsis: r.gsis_id || null,
    id: r.gsis_id ? pidOf(r.gsis_id) : null,
    age: int(r.age),
    cfbId: r.cfb_player_id || null,
  };
  draftOut.push(row);
  if (r.gsis_id) draftByGsis.set(r.gsis_id, row);
}
log("draft picks kept", draftOut.length);

/* --------------------------------------------------------------- players */
const KEEP_STATUS = new Set(["ACT", "RES", "INA", "DEV", "PUP", "SUS", "NON", "EXE"]);
const players = [];
for (const [gsis, r] of roster) {
  if (!KEEP_STATUS.has(r.status) || !r.team) continue;
  const team = code(r.team);
  const s = statsNow.totals.get(gsis) ?? null;
  const ps = statsPrev.totals.get(gsis) ?? null;
  const dc = depth.get(gsis);
  const rookie = Number(r.rookie_year) === season;
  const keyPos = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB"].includes(r.position);
  // Keep anyone with a stat line this season or last, a depth chart spot in the top two, or this year's rookies. Practice squad only with stats.
  if (!s && !ps && !(dc && dc.rank <= 2) && !(rookie && r.status !== "DEV")) continue;
  if (r.status === "DEV" && !s) continue;
  const snaps = snapsByKey.get(`${team}|${normName(r.full_name)}`);
  const exp = int(r.years_exp) ?? 0;
  const pick = draftByGsis.get(gsis) ?? (r.draft_number ? { pick: Number(r.draft_number), round: null, year: Number(r.rookie_year), nfl: nick(r.draft_club), nflCode: code(r.draft_club) } : null);
  const pos = statsNow.posOf.get(gsis) ?? statsPrev.posOf.get(gsis) ?? r.depth_chart_position ?? r.position;
  const inj = injuryByGsis.get(gsis);
  players.push({
    id: pidOf(gsis),
    gsis,
    n: r.full_name,
    t: nick(team),
    c: "nfl",
    cf: byCode.get(team)?.conf ?? null,
    dv: byCode.get(team)?.div ?? null,
    p: pos || null,
    pg: r.position || null,
    y: exp + 1,
    h: int(r.height),
    w: int(r.weight),
    j: int(r.jersey_number),
    g: gamesPlayedBy.get(nick(team)) ?? null,
    s,
    ps,
    u: snaps
      ? { o: Math.round((snaps.off / snaps.games) * 1000) / 1000, d: Math.round((snaps.def / snaps.games) * 1000) / 1000, st: Math.round((snaps.st / snaps.games) * 1000) / 1000, gs: snaps.games, os: snaps.offSnaps, ds: snaps.defSnaps }
      : null,
    r: {
      yr: int(r.rookie_year),
      entry: int(r.entry_year),
      pk: pick?.pick ?? null,
      rd: pick?.round ?? null,
      club: pick?.nfl ?? null,
      exp,
      college: r.college || null,
      status: r.status,
      hs: r.headshot_url || null,
      born: r.birth_date || null,
    },
    inj: inj ? { st: inj.status, pr: inj.practice, inj: inj.injury, wk: inj.week } : null,
    dc: dc ? { pos: dc.pos, rank: dc.rank, grp: dc.grp } : null,
    home: r.college || null,
  });
}
log("players kept", players.length, "of", roster.size);

/* --------------------------------------------------------- play by play */
const ftnByPlay = new Map();
if (local[`ftn_charting_${season}.csv`]) {
  await readCsv(local[`ftn_charting_${season}.csv`], (r) => {
    ftnByPlay.set(`${r.nflverse_game_id}|${r.nflverse_play_id}`, {
      blitz: int(r.n_blitzers) ?? 0,
      rushers: int(r.n_pass_rushers) ?? 0,
      pa: bool(r.is_play_action),
      motion: bool(r.is_motion),
      screen: bool(r.is_screen_pass),
      rpo: bool(r.is_rpo),
      box: int(r.n_defense_box),
      noHuddle: bool(r.is_no_huddle),
      sneak: bool(r.is_qb_sneak),
    });
  });
  log("ftn plays", ftnByPlay.size);
}

const bucket = () => ({ n: 0, pass: 0, succ: 0, conv: 0, td: 0, havoc: 0, x: 0 });
const mkUnit = () => ({
  plays: 0, drives: new Set(), epa: 0, succ: 0, exEpa: 0, exN: 0,
  power: { n: 0, conv: 0 }, stuff: { n: 0, conv: 0 }, rushEpa: 0, rushSucc: 0, rushN: 0, rushExEpa: 0, rushExN: 0, sly: 0, ofy: 0,
  passEpa: 0, passSucc: 0, passN: 0, passExEpa: 0, passExN: 0,
  sd: { n: 0, succ: 0 }, pd: { n: 0, succ: 0, exEpa: 0, exN: 0 },
  havoc: 0, pressure: 0, dropbacks: 0, blitzN: 0, blitz: 0, paN: 0, pa: 0, motion: 0, early: { n: 0, pass: 0 }, neutral: { n: 0, pass: 0 },
  ppo: { trips: new Set(), pts: 0 },
  rz: { trips: new Set(), tdTrips: new Set() },
  // situational digest buckets
  sit: {
    early: bucket(), sd: bucket(), pd: bucket(), third: { short: bucket(), medium: bucket(), long: bucket() }, fourth: bucket(),
    rz: Object.assign(bucket(), { trips: 0, tdTrips: 0 }), gl: bucket(), score: { lead: bucket(), close: bucket(), trail: bucket() },
    explosive: { rush: bucket(), pass: bucket() }, tempo: { noHuddle: 0, tagged: 0, secs: [], drivePlays: 0, driveSecs: 0, drivesSeen: new Set() },
  },
  thirdCarriers: new Map(), thirdTargets: new Map(), rzCarriers: new Map(), rzTargets: new Map(),
});
const units = new Map(); // nickname -> { off, def }
const unitFor = (team, side) => {
  const u = units.get(team) ?? units.set(team, { off: mkUnit(), def: mkUnit() }).get(team);
  return u[side];
};
const gameSit = new Map(); // espn id -> { week, seasonType, teams: { nick: { plays, third, pd } } }
const gameLong = new Map(); // espn id -> { [nick]: longest play }
const driveResultPts = { Touchdown: 7, "Field goal": 3 };
let plays = 0;
let pbpWeeks = new Set();
let lastSnap = null; // for seconds between snaps: { game, drive, team, secs }
const tally = (b, o) => {
  b.n++;
  if (o.pass) b.pass++;
  if (o.succ) b.succ++;
  if (o.conv) b.conv++;
  if (o.td) b.td++;
  if (o.havoc) b.havoc++;
  if (o.x) b.x++;
};
const nameCount = (map, name, gsis) => {
  if (!name) return;
  const e = map.get(name) ?? map.set(name, { name, n: 0, gsis }).get(name);
  e.n++;
};

await readCsv(local[`play_by_play_${season}.csv`], (r) => {
  const pt = r.play_type;
  if (pt !== "pass" && pt !== "run") return;
  if (r.aborted_play === "1" || !r.posteam || !r.defteam) return;
  const epa = num(r.epa);
  if (epa === null) return;
  plays++;
  pbpWeeks.add(Number(r.week));
  const off = nick(r.posteam);
  const def = nick(r.defteam);
  const isPass = r.pass === "1";
  const isRush = !isPass && r.rush === "1";
  if (!isPass && !isRush) return;
  const succ = r.success === "1";
  const yards = num(r.yards_gained) ?? 0;
  const down = int(r.down) ?? 0;
  const dist = int(r.ydstogo) ?? 10;
  const yl = int(r.yardline_100) ?? 50;
  const diff = int(r.score_differential) ?? 0;
  const td = r.touchdown === "1" && r.td_team === r.posteam;
  const conv = r.first_down === "1" || td;
  const havoc = r.tackled_for_loss === "1" || r.sack === "1" || r.interception === "1" || r.fumble_forced === "1" || Boolean(r.pass_defense_1_player_id);
  const x = (isRush && yards >= 12) || (isPass && yards >= 20);
  const pressure = isPass && (r.sack === "1" || r.qb_hit === "1");
  const standard = down === 1 || (down === 2 && dist <= 7) || ((down === 3 || down === 4) && dist <= 4);
  const espn = espnByGid.get(r.game_id) ?? `nv-${r.game_id}`;
  const ftn = ftnByPlay.get(`${r.game_id}|${r.play_id}`);
  const qtr = int(r.qtr) ?? 1;

  for (const side of ["off", "def"]) {
    const u = unitFor(side === "off" ? off : def, side);
    u.plays++;
    u.drives.add(`${r.game_id}|${r.fixed_drive}`);
    u.epa += epa;
    if (succ) { u.succ++; u.exEpa += epa; u.exN++; }
    if (isRush) {
      u.rushN++; u.rushEpa += epa;
      if (succ) { u.rushSucc++; u.rushExEpa += epa; u.rushExN++; }
      if (yards <= 0) u.stuff.conv++;
      u.stuff.n++;
      if ((down === 3 || down === 4) && dist <= 2) { u.power.n++; if (conv) u.power.conv++; }
      u.sly += Math.max(0, Math.min(yards, 10) - 5);
      u.ofy += Math.max(0, yards - 10);
    } else {
      u.passN++; u.passEpa += epa; u.dropbacks++;
      if (succ) { u.passSucc++; u.passExEpa += epa; u.passExN++; }
      if (pressure) u.pressure++;
      if (ftn) {
        u.blitzN++;
        if (ftn.blitz >= 1 || ftn.rushers >= 5) u.blitz++;
        if (ftn.pa) u.pa++;
      }
    }
    if (ftn) { u.paN++; if (ftn.motion) u.motion++; }
    if (standard) { u.sd.n++; if (succ) u.sd.succ++; } else { u.pd.n++; if (succ) { u.pd.succ++; u.pd.exEpa += epa; u.pd.exN++; } }
    if (havoc) u.havoc++;
    if (down <= 2) { u.early.n++; if (isPass) u.early.pass++; }
    if (Math.abs(diff) <= 8 && qtr <= 3) { u.neutral.n++; if (isPass) u.neutral.pass++; }
    if (yl <= 40) {
      const key = `${r.game_id}|${r.fixed_drive}`;
      if (!u.ppo.trips.has(key)) { u.ppo.trips.add(key); u.ppo.pts += driveResultPts[r.fixed_drive_result] ?? 0; }
    }
    if (yl <= 20) {
      const key = `${r.game_id}|${r.fixed_drive}`;
      u.rz.trips.add(key);
      if (r.fixed_drive_result === "Touchdown") u.rz.tdTrips.add(key);
    }
    // situational digest
    const S = u.sit;
    const o = { pass: isPass, succ, conv, td, havoc, x };
    if (down <= 2) tally(S.early, o);
    if (standard) tally(S.sd, o); else tally(S.pd, o);
    if (down === 3) tally(dist <= 3 ? S.third.short : dist <= 6 ? S.third.medium : S.third.long, o);
    if (down === 4) tally(S.fourth, o);
    if (yl <= 20) tally(S.rz, o);
    if (yl <= 5) tally(S.gl, o);
    tally(diff >= 9 ? S.score.lead : diff <= -9 ? S.score.trail : S.score.close, o);
    if (isRush) tally(S.explosive.rush, { ...o, x: yards >= 12 });
    else tally(S.explosive.pass, { ...o, x: yards >= 20 });
    if (side === "off") {
      S.tempo.tagged++;
      if (r.no_huddle === "1") S.tempo.noHuddle++;
      const dk = `${r.game_id}|${r.fixed_drive}`;
      if (!S.tempo.drivesSeen.has(dk)) {
        S.tempo.drivesSeen.add(dk);
        const m = (r.drive_time_of_possession ?? "").match(/^(\d+):(\d+)$/);
        if (m) { S.tempo.driveSecs += Number(m[1]) * 60 + Number(m[2]); S.tempo.drivePlays += int(r.drive_play_count) ?? 0; }
      }
      const secs = int(r.game_seconds_remaining);
      if (lastSnap && lastSnap.game === r.game_id && lastSnap.drive === r.fixed_drive && lastSnap.team === r.posteam && secs != null) {
        const d = lastSnap.secs - secs;
        if (d > 0 && d <= 45) S.tempo.secs.push(d);
      }
      lastSnap = { game: r.game_id, drive: r.fixed_drive, team: r.posteam, secs };
      if (down === 3) {
        if (isRush) nameCount(u.thirdCarriers, r.rusher_player_name, r.rusher_player_id);
        else if (r.receiver_player_name) nameCount(u.thirdTargets, r.receiver_player_name, r.receiver_player_id);
      }
      if (yl <= 20) {
        if (isRush) nameCount(u.rzCarriers, r.rusher_player_name, r.rusher_player_id);
        else if (r.receiver_player_name) nameCount(u.rzTargets, r.receiver_player_name, r.receiver_player_id);
      }
    }
  }
  // per game rows for grading
  const gs = gameSit.get(espn) ?? gameSit.set(espn, { week: Number(r.week), seasonType: r.season_type === "REG" ? "regular" : "postseason", teams: {} }).get(espn);
  const row = gs.teams[off] ?? (gs.teams[off] = { plays: 0, third: { n: 0, conv: 0 }, pd: { n: 0, succ: 0 } });
  row.plays++;
  if (down === 3) { row.third.n++; if (conv) row.third.conv++; }
  if (!standard) { row.pd.n++; if (succ) row.pd.succ++; }
  const gl = gameLong.get(espn) ?? gameLong.set(espn, {}).get(espn);
  gl[off] = Math.max(gl[off] ?? 0, yards);
});
log("plays", plays, "weeks", [...pbpWeeks].sort((a, b) => a - b).join(","));

const r3 = (n) => Math.round(n * 1000) / 1000;
const rate = (a, b) => (b ? r3(a / b) : null);
function genUnit(u, games) {
  const hasFtn = u.paN > 0;
  return {
    plays: u.plays,
    drives: u.drives.size,
    ppa: rate(u.epa, u.plays) ?? 0,
    sr: rate(u.succ, u.plays) ?? 0,
    ex: rate(u.exEpa, u.exN) ?? 0,
    power: rate(u.power.conv, u.power.n) ?? 0,
    stuff: rate(u.stuff.conv, u.stuff.n) ?? 0,
    ly: rate(u.rushEpa, u.rushN) ?? 0, // run game: rush EPA per carry (yards before contact is not in play-by-play)
    sly: rate(u.sly, u.rushN) ?? 0,
    ofy: rate(u.ofy, u.rushN) ?? 0,
    ppo: rate(u.ppo.pts, u.ppo.trips.size) ?? 0,
    havoc: rate(u.havoc, u.plays),
    havocF7: null,
    havocDB: null,
    sdSr: rate(u.sd.succ, u.sd.n),
    pdSr: rate(u.pd.succ, u.pd.n),
    pdEx: rate(u.pd.exEpa, u.pd.exN),
    rushRate: rate(u.rushN, u.plays),
    rushSr: rate(u.rushSucc, u.rushN),
    rushEx: rate(u.rushExEpa, u.rushExN),
    rushPpa: rate(u.rushEpa, u.rushN),
    passRate: rate(u.passN, u.plays),
    passSr: rate(u.passSucc, u.passN),
    passEx: rate(u.passExEpa, u.passExN),
    passPpa: rate(u.passEpa, u.passN),
    pressure: rate(u.pressure, u.dropbacks),
    blitz: hasFtn ? rate(u.blitz, u.blitzN) : null,
    playAction: hasFtn ? rate(u.pa, u.blitzN) : null,
    motion: hasFtn ? rate(u.motion, u.paN) : null,
    earlyPass: rate(u.early.pass, u.early.n),
    neutralPass: rate(u.neutral.pass, u.neutral.n),
    rzTd: rate(u.rz.tdTrips.size, u.rz.trips.size),
    rzTrips: u.rz.trips.size,
    pace: games ? r3(u.plays / games) : null,
  };
}
const teamsOut = [];
for (const t of TEAMS.teams) {
  const u = units.get(t.short);
  if (!u) continue;
  const games = gamesPlayedBy.get(t.short) ?? null;
  teamsOut.push({ team: t.short, code: t.code, conf: t.conf, dv: t.div, c: "nfl", games, off: genUnit(u.off, games), def: genUnit(u.def, games) });
}
log("teams charted", teamsOut.length);

/* --------------------------------------------------------- situational */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sitTeams = {};
let namesMatched = 0;
let namesUnmatched = 0;
const nameRows = (map) =>
  [...map.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((e) => {
      const id = e.gsis ? pidOf(e.gsis) : undefined;
      const full = e.gsis ? roster.get(e.gsis)?.full_name : undefined;
      if (id && full) namesMatched++;
      else namesUnmatched++;
      return { name: full ?? e.name, id, n: e.n, unmatched: !full || undefined };
    });
const sitUnit = (u) => {
  const S = u.sit;
  return {
    plays: u.plays,
    early: S.early, sd: S.sd, pd: S.pd, third: S.third, fourth: S.fourth,
    rz: { ...S.rz, trips: u.rz.trips.size, tdTrips: u.rz.tdTrips.size },
    gl: S.gl, score: S.score, explosive: S.explosive,
    tempo: { noHuddle: S.tempo.noHuddle, tagged: S.tempo.tagged, secsPerSnap: median(S.tempo.secs), snapPairs: S.tempo.secs.length, drivePlays: S.tempo.drivePlays, driveSecs: S.tempo.driveSecs },
  };
};
for (const t of TEAMS.teams) {
  const u = units.get(t.short);
  if (!u) continue;
  sitTeams[t.short] = {
    c: "nfl",
    games: gamesPlayedBy.get(t.short) ?? 0,
    off: sitUnit(u.off),
    def: sitUnit(u.def),
    thirdCarriers: nameRows(u.off.thirdCarriers),
    thirdTargets: nameRows(u.off.thirdTargets),
    rzCarriers: nameRows(u.off.rzCarriers),
    rzTargets: nameRows(u.off.rzTargets),
  };
}
const situational = {
  meta: { ingestedAt: new Date().toISOString(), season, weeks: [...pbpWeeks].sort((a, b) => a - b), plays, games: gameSit.size, teams: Object.keys(sitTeams).length, namesMatched, namesUnmatched, runtimeSec: Math.round((Date.now() - t0) / 1000) },
  teams: sitTeams,
  games: Object.fromEntries(gameSit),
};

/* ------------------------------------------------------------ gamelogs */
const logGames = {};
for (const g of thisSeason) {
  if (!g.played && !gameLong.has(g.id)) continue;
  const lg = gameLong.get(g.id) ?? {};
  logGames[g.id] = { wk: g.week, st: g.type === "REG" ? "regular" : "postseason", home: g.home, away: g.away, hp: g.hs, ap: g.as, hc: null, ac: null, long: { home: lg[g.home] ?? null, away: lg[g.away] ?? null } };
}
const logPlayers = {};
let lineCount = 0;
for (const [gsis, lines] of statsNow.gameLines) {
  logPlayers[pidOf(gsis)] = lines;
  lineCount += lines.length;
}
const gamelogs = {
  meta: { ingestedAt: new Date().toISOString(), season, weeks: [...new Set([...statsNow.gameLines.values()].flat().map((l) => String(l.wk)))].sort(), games: Object.keys(logGames).length, players: Object.keys(logPlayers).length, lines: lineCount },
  games: logGames,
  players: logPlayers,
};

/* ----------------------------------------------------------------- meta */
const statsThroughWeek = Math.max(0, ...[...statsNow.gameLines.values()].flat().map((l) => l.wk));
const unplayed = thisSeason.filter((g) => !g.played);
const currentWeek = unplayed.length ? Math.min(...unplayed.map((g) => g.week)) : Math.max(...thisSeason.map((g) => g.week));
const meta = {
  ingestedAt: new Date().toISOString(),
  season,
  week: currentWeek,
  statsThroughWeek,
  pbpThroughWeek: Math.max(0, ...pbpWeeks),
  players: players.length,
  teams: teamsOut.length,
  draftPicks: draftOut.length,
  recruits: 0,
  injuries: injuries.length,
  ftn: ftnByPlay.size > 0,
  plays,
  source: "nflverse",
};

await writeFile(path.join(OUT, "schedule.json"), JSON.stringify(schedule));
await writeFile(path.join(OUT, "teams.json"), JSON.stringify(teamsOut));
await writeFile(path.join(OUT, "players.json"), JSON.stringify(players));
await writeFile(path.join(OUT, "gamelogs.json"), JSON.stringify(gamelogs));
await writeFile(path.join(OUT, "situational.json"), JSON.stringify(situational));
await writeFile(path.join(OUT, "draft.json"), JSON.stringify(draftOut));
await writeFile(path.join(OUT, "injuries.json"), JSON.stringify({ asOf: new Date().toISOString(), season, rows: injuries }));
await writeFile(path.join(OUT, "elo.json"), JSON.stringify(eloOut));
await writeFile(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
log("wrote", OUT, meta);
