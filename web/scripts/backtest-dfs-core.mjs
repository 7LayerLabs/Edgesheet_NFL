/**
 * Shared pieces of the DraftKings backtests (scripts/backtest-dfs.mjs, scripts/backtest-dfs-fit.mjs,
 * scripts/build-dfs-sim.mjs): the nflverse and ffverse files (downloaded to data/cache when missing), DK scoring, the
 * walk-forward list of players a projection is made for, and the live projection of src/lib/dfs.ts rebuilt from it.
 *
 * Who is in the list (week 3 on, regular season): a QB, RB, WR, or TE with 2+ games so far this season who is on a
 * team's game roster that week (nflverse weekly roster: active or game-day inactive), not listed Out or Doubtful on
 * that week's injury report, and whose team plays. One quarterback a team: the one who took the team's first dropback
 * (play-by-play), since the starter is known before kickoff; the nflverse depth charts and the schedule's named starter
 * were both wrong for whole stretches of 2024. A player in the list with no stat line that week scored 0: inactive
 * on game day, or on the field without touching the ball. The old backtests read only stat lines, so they skipped those
 * weeks and their misses ran low.
 *
 * The standard pool is the top 20 QBs and TEs and the top 40 RBs and WRs by a projection, each week.
 */
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { num } from "./lib/csv.mjs";
import { streamCsv } from "./lib/csv-stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const CACHE = path.join(ROOT, "data", "cache");
export const OUT = path.join(ROOT, "data", "backtest");
export const POS = ["QB", "RB", "WR", "TE"];
export const POOL_SIZE = { QB: 20, RB: 40, WR: 40, TE: 20 };
const NV = "https://github.com/nflverse/nflverse-data/releases/download";
const FF = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";

/**
 * The live projection's settings, the same numbers as src/lib/dfs.ts (PRIOR_GAMES, XFP_WEIGHT, MATCHUP_WEIGHT,
 * NEXT_MAN_UP_SHARE, VOLUME_WEIGHT, CALIBRATION). Change both together. Volume and calibration come from
 * scripts/backtest-dfs-fit.mjs (fit on 2022-23, graded on 2024-25).
 */
export const LIVE = {
  priorGames: 3,
  xfpWeight: 0.5,
  matchupWeight: 0.25,
  nextManUp: { QB: 0, RB: 0.25, TE: 0.2, WR: 0 },
  volume: { QB: 0.6, RB: 0.55, WR: 0.45, TE: 0.95 },
  calibration: {
    QB: { a: 3.649, b: 0.78, floor: 14.1 },
    RB: { a: 0.504, b: 0.891, floor: 8 },
    WR: { a: 1.516, b: 0.837, floor: 10.3 },
    TE: { a: 1.733, b: 0.777, floor: 7 },
  },
};

/* ------------------------------------------------------------ files */

const exists = (f) => access(f).then(() => true, () => false);
async function cached(name, url) {
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  console.log("download", name);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

/** DraftKings Classic points from an nflverse weekly row (no two-point conversions, as in dfs.ts). */
export const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) +
    n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fumbles_lost_total") + n("special_teams_tds") * 6;
};
const DK_COLS = ["passing_yards", "passing_tds", "passing_interceptions", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost_total", "special_teams_tds"];
const DST_COLS = ["def_sacks", "def_interceptions", "fumble_recovery_opp", "def_tds", "def_safeties", "sacks_suffered"];

/** Regular-season weekly rows: skill players' DK points and passes, plus the counts the DST model reads from every row. */
export async function weekRows(y) {
  const rows = [];
  const file = await cached(`stats_player_week_${y}.csv`, `${NV}/stats_player/stats_player_week_${y}.csv`);
  await streamCsv(file, (r) => {
    if (r.season_type !== "REG") return;
    const n = (k) => num(r[k]) ?? 0;
    rows.push({
      id: r.player_id, pos: r.position, week: Number(r.week), team: r.team, opp: r.opponent_team, gid: r.game_id,
      pts: POS.includes(r.position) ? dk(r) : 0,
      sk: n("def_sacks"), int: n("def_interceptions"), fr: n("fumble_recovery_opp"), dtd: n("def_tds"), sttd: n("special_teams_tds"), saf: n("def_safeties"),
      give: n("passing_interceptions") + n("fumbles_lost_total"), sks: n("sacks_suffered"),
    });
  }, ["player_id", "position", "week", "season_type", "team", "opponent_team", "game_id", ...DK_COLS, ...DST_COLS]);
  return rows;
}

/** Expected fantasy points (ffverse ffopportunity) by `${player}|${week}`, regular season. */
export async function xfpRows(y) {
  const m = new Map();
  const file = await cached(`ep_weekly_${y}.csv`, `${FF}/ep_weekly_${y}.csv`);
  await streamCsv(file, (r) => {
    const x = num(r.total_fantasy_points_exp);
    const wk = Number(r.week);
    if (x == null || wk > 18) return;
    m.set(`${r.player_id}|${wk}`, { x, fp: num(r.total_fantasy_points) ?? 0 });
  }, ["player_id", "week", "total_fantasy_points_exp", "total_fantasy_points"]);
  return m;
}

/** The injury report's game status by `${week}|${player}` (Out, Doubtful, Questionable), regular season. */
export async function injuryReport(y) {
  const m = new Map();
  const file = await cached(`injuries_${y}.csv`, `${NV}/injuries/injuries_${y}.csv`);
  await streamCsv(file, (r) => {
    if (r.game_type !== "REG" || !r.report_status) return;
    m.set(`${Number(r.week)}|${r.gsis_id}`, r.report_status);
  }, ["game_type", "week", "gsis_id", "report_status"]);
  return m;
}

/** Weekly rosters of skill players by `${week}|${player}`: team and status (ACT active, INA game-day inactive, RES reserve, ...). */
export async function weeklyRoster(y) {
  const m = new Map();
  const byTeam = new Map(); // `${week}|${team}` -> player ids
  const file = await cached(`roster_weekly_${y}.csv`, `${NV}/weekly_rosters/roster_weekly_${y}.csv`);
  await streamCsv(file, (r) => {
    if (r.game_type !== "REG" || !["QB", "RB", "FB", "WR", "TE"].includes(r.position) || !r.gsis_id) return;
    const wk = Number(r.week);
    m.set(`${wk}|${r.gsis_id}`, { team: r.team, status: r.status });
    const k = `${wk}|${r.team}`;
    (byTeam.get(k) ?? byTeam.set(k, []).get(k)).push(r.gsis_id);
  }, ["game_type", "position", "gsis_id", "week", "team", "status"]);
  return { get: (k) => m.get(k), team: (wk, team) => byTeam.get(`${wk}|${team}`) ?? [] };
}

/**
 * Regular-season games by `${season}|${week}|${team}`: game id, opponent, both scores, and the
 * closing line's implied team totals (nflverse spread_line: positive = home favored by that many).
 */
export async function schedule() {
  const out = new Map();
  await streamCsv(path.join(CACHE, "games.csv"), (r) => {
    if (r.game_type !== "REG" || r.home_score === "") return;
    const season = Number(r.season), week = Number(r.week);
    const spread = num(r.spread_line), total = num(r.total_line);
    const hs = Number(r.home_score), as = Number(r.away_score);
    const homeImp = spread != null && total != null ? (total + spread) / 2 : undefined;
    const awayImp = spread != null && total != null ? (total - spread) / 2 : undefined;
    out.set(`${season}|${week}|${r.home_team}`, { gid: r.game_id, opp: r.away_team, score: hs, oppScore: as, implied: homeImp, oppImplied: awayImp });
    out.set(`${season}|${week}|${r.away_team}`, { gid: r.game_id, opp: r.home_team, score: as, oppScore: hs, implied: awayImp, oppImplied: homeImp });
  }, ["game_type", "home_score", "away_score", "season", "week", "spread_line", "total_line", "home_team", "away_team", "game_id"]);
  return out;
}

/** The quarterback on each team's first dropback, by `${game}|${team}`, from nflverse play-by-play (regular season). */
export async function starters(y) {
  const out = new Map();
  const file = await cached(`play_by_play_${y}.csv.gz`, `${NV}/pbp/play_by_play_${y}.csv.gz`);
  await streamCsv(file, (r) => {
    if (r.season_type !== "REG" || !r.passer_player_id || !r.posteam) return;
    const k = `${r.game_id}|${r.posteam}`;
    if (!out.has(k)) out.set(k, r.passer_player_id);
  }, ["game_id", "posteam", "passer_player_id", "season_type"]);
  return out;
}

/** Everything one season's walk needs: this season's and last season's rows and expected points, the report, the rosters. */
export async function loadSeason(season, sched) {
  const [rows, prevRows, xf, xfPrev, inj, roster, qb] = [await weekRows(season), await weekRows(season - 1), await xfpRows(season), await xfpRows(season - 1), await injuryReport(season), await weeklyRoster(season), await starters(season)];
  return { season, rows, prevRows, xf, xfPrev, inj, roster, qb, sched };
}

/* ------------------------------------------------------------ walk-forward */

/**
 * Every player-week in the list (see the file comment), week 3 on, with the inputs of the live projection as of that
 * week: games so far (n) and DK points a game (now), last season's DK points a game (prior, 4+ games), expected points a
 * game this season and last (xNow, xPrev with 4+ games) and the DK-over-ffopportunity scale, the opponent factor (DK
 * points allowed to the position against the league, capped 0.7 to 1.35), the next-man-up bump, the team's implied
 * total this game, its average implied total in its games so far, and the league's. `actual` is 0 with no stat line.
 */
export function walkSeason({ season, rows, prevRows, xf, xfPrev, inj, roster, qb, sched }) {
  const out = [];
  // Last season per game: DK points from the stat lines, expected points from ffopportunity.
  const prev = new Map();
  for (const r of prevRows) {
    if (!POS.includes(r.pos)) continue;
    const e = prev.get(r.id) ?? prev.set(r.id, { pts: 0, n: 0 }).get(r.id);
    e.pts += r.pts;
    e.n++;
  }
  const prevX = new Map();
  for (const [k, q] of xfPrev) {
    const id = k.slice(0, k.indexOf("|"));
    const e = prevX.get(id) ?? prevX.set(id, { x: 0, n: 0 }).get(id);
    e.x += q.x;
    e.n++;
  }
  const xByWeek = new Map(); // week -> [id, q]
  for (const [k, q] of xf) {
    const [id, wk] = k.split("|");
    (xByWeek.get(Number(wk)) ?? xByWeek.set(Number(wk), []).get(Number(wk))).push([id, q]);
  }
  const byWeek = new Map();
  for (const r of rows) (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)).push(r);
  const weeks = [...new Set([...sched.keys()].filter((k) => k.startsWith(`${season}|`)).map((k) => Number(k.split("|")[1])))].sort((a, b) => a - b);

  // Running totals over the weeks before the current one.
  const hist = new Map(); // id -> { pts, n, pos }
  const allowed = new Map(); // `${defense}|${pos}` -> { pts, games }
  const xs = new Map(); // id -> { x, n }
  let dkSum = 0, fpSum = 0;
  const teamImp = new Map(); // team -> { sum, n }
  const leagueImp = { sum: 0, n: 0 };

  for (const w of weeks) {
    const now = byWeek.get(w) ?? [];
    if (w >= 3) {
      const league = {};
      for (const pos of POS) {
        const per = [...allowed.entries()].filter(([k]) => k.endsWith(`|${pos}`)).map(([, e]) => e.pts / e.games.size);
        league[pos] = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
      }
      const scale = fpSum ? dkSum / fpSum : 1;
      const actual = new Map(now.filter((r) => POS.includes(r.pos)).map((r) => [r.id, r.pts]));
      const report = (id) => inj.get(`${w}|${id}`);
      const onRoster = (id) => {
        const ro = roster.get(`${w}|${id}`);
        return ro && (ro.status === "ACT" || ro.status === "INA") ? ro : undefined;
      };
      const expected = (id) => onRoster(id) && report(id) !== "Out" && report(id) !== "Doubtful";

      const cands = [];
      for (const [id, h] of hist) {
        if (h.n < 2 || !POS.includes(h.pos) || !expected(id)) continue;
        const team = onRoster(id).team;
        const g = sched.get(`${season}|${w}|${team}`);
        if (!g) continue; // bye
        cands.push({ id, h, team, g });
      }
      // Next man up (dfs.ts): an RB or TE out this week (reserve list, or Out or Doubtful) with 6+ DK points a game this
      // season hands NEXT_MAN_UP_SHARE of his average to the healthy teammate at his position with the best average so far.
      const bump = new Map();
      for (const team of new Set(cands.map((c) => c.team))) {
        for (const id of roster.team(w, team)) {
          const h = hist.get(id);
          const ro = roster.get(`${w}|${id}`);
          if (!h || !["RB", "TE"].includes(h.pos) || h.pts / h.n < 6) continue;
          if (!(ro.status === "RES" || report(id) === "Out" || report(id) === "Doubtful")) continue;
          const taker = roster.team(w, team)
            .filter((x) => x !== id && hist.get(x)?.pos === h.pos && expected(x))
            .sort((a, b) => hist.get(b).pts / hist.get(b).n - hist.get(a).pts / hist.get(a).n)[0];
          if (!taker) continue;
          const pts = Math.round((h.pts / h.n) * LIVE.nextManUp[h.pos] * 10) / 10;
          bump.set(taker, Math.max(bump.get(taker) ?? 0, pts));
        }
      }
      for (const c of cands) {
        if (c.h.pos === "QB" && qb.get(`${c.g.gid}|${c.team}`) !== c.id) continue; // dfs.ts skips backups unless the starter is out
        const { id, h, team, g } = c;
        const p = prev.get(id);
        const px = prevX.get(id);
        const x = xs.get(id);
        const a = allowed.get(`${g.opp}|${h.pos}`);
        const ti = teamImp.get(team);
        out.push({
          season, week: w, gid: g.gid, id, pos: h.pos, team, opp: g.opp,
          n: h.n, now: h.pts / h.n, prior: p && p.n >= 4 ? p.pts / p.n : undefined,
          nx: x?.n ?? 0, xNow: x?.n ? x.x / x.n : undefined, xPrev: px && px.n >= 4 ? px.x / px.n : undefined, scale,
          factor: a && league[h.pos] ? Math.min(1.35, Math.max(0.7, a.pts / a.games.size / league[h.pos])) : 1,
          bump: bump.get(id) ?? 0,
          implied: g.implied, teamImplied: ti?.n ? ti.sum / ti.n : undefined, leagueImplied: leagueImp.n ? leagueImp.sum / leagueImp.n : undefined,
          actual: actual.get(id) ?? 0, played: actual.has(id), inactive: onRoster(id).status === "INA", q: report(id) === "Questionable",
        });
      }
    }
    // Add this week to the running totals.
    for (const r of now) {
      if (!POS.includes(r.pos)) continue;
      const h = hist.get(r.id) ?? hist.set(r.id, { pts: 0, n: 0 }).get(r.id);
      h.pts += r.pts;
      h.n++;
      h.pos = r.pos;
      const k = `${r.opp}|${r.pos}`;
      const e = allowed.get(k) ?? allowed.set(k, { pts: 0, games: new Set() }).get(k);
      e.pts += r.pts;
      e.games.add(r.week);
      const q = xf.get(`${r.id}|${w}`);
      if (q) { dkSum += r.pts; fpSum += q.fp; }
    }
    for (const [id, q] of xByWeek.get(w) ?? []) {
      const e = xs.get(id) ?? xs.set(id, { x: 0, n: 0 }).get(id);
      e.x += q.x;
      e.n++;
    }
    for (const [k, g] of sched) {
      const [y, wk, team] = k.split("|");
      if (Number(y) !== season || Number(wk) !== w || g.implied === undefined) continue;
      const e = teamImp.get(team) ?? teamImp.set(team, { sum: 0, n: 0 }).get(team);
      e.sum += g.implied;
      e.n++;
      leagueImp.sum += g.implied;
      leagueImp.n++;
    }
  }
  return out;
}

/* ------------------------------------------------------------ projections */

/** The DK base: this season blended with last season, then half expected points (dfs.ts). */
export function baseOf(c, k = LIVE.priorGames, xw = LIVE.xfpWeight) {
  let base = c.prior === undefined || !k ? c.now : (c.n * c.now + k * c.prior) / (c.n + k);
  if (c.xNow !== undefined && xw) {
    const x = (c.xPrev === undefined ? c.xNow : (c.nx * c.xNow + LIVE.priorGames * c.xPrev) / (c.nx + LIVE.priorGames)) * c.scale;
    base = (1 - xw) * base + xw * x;
  }
  return base;
}

/** Implied team total this game over the team's average implied total in its games so far (1 with no line). */
export const volumeRatio = (c) => (c.implied !== undefined && c.teamImplied ? c.implied / c.teamImplied : 1);

/**
 * The calibration line from its floor up; below the floor the projection is scaled by the line's ratio at the floor, so
 * players under the pool it was fit on keep their order and move little (dfs.ts calibrate).
 */
export function calibrate(cal, proj) {
  if (!cal) return proj;
  return proj >= cal.floor ? cal.a + cal.b * proj : proj * ((cal.a + cal.b * cal.floor) / cal.floor);
}

/** The live projection as dfs.ts makes it, from a walkSeason row. */
export function liveProj(c, s = LIVE) {
  const proj = (baseOf(c, s.priorGames, s.xfpWeight) * (1 + s.matchupWeight * (c.factor - 1)) + c.bump) * (1 + (s.volume[c.pos] ?? 0) * (volumeRatio(c) - 1));
  return calibrate(s.calibration?.[c.pos], proj);
}

/** The standard pool: top 20 QB and TE, top 40 RB and WR by `projOf`, each season-week. Returns the chosen rows. */
export function standardPool(rows, projOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.season}|${r.week}|${r.pos}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const pos = k.split("|")[2];
    out.push(...rs.map((r) => [r, projOf(r)]).sort((a, b) => b[1] - a[1]).slice(0, POOL_SIZE[pos]).map(([r]) => r));
  }
  return out;
}

/* ------------------------------------------------------------ grading */

const r3 = (x) => Math.round(x * 1000) / 1000;

/** MAE, mean error (projection minus actual), and count of a projection over rows. */
export function grade(rows, projOf) {
  let ae = 0, e = 0;
  for (const r of rows) {
    const d = projOf(r) - r.actual;
    ae += Math.abs(d);
    e += d;
  }
  return { n: rows.length, mae: r3(ae / Math.max(1, rows.length)), bias: r3(e / Math.max(1, rows.length)) };
}

/** Paired MAE difference (b minus a; negative = b misses less) with its standard error. */
export function pairedDiff(rows, a, b) {
  const ds = rows.map((r) => Math.abs(b(r) - r.actual) - Math.abs(a(r) - r.actual));
  const m = ds.reduce((s, x) => s + x, 0) / Math.max(1, ds.length);
  const v = ds.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, ds.length - 1);
  return { diff: r3(m), se: r3(Math.sqrt(v / Math.max(1, ds.length))) };
}

/** grade() per position plus all positions together. */
export function byPos(rows, projOf) {
  return Object.fromEntries([...POS.map((p) => [p, grade(rows.filter((r) => r.pos === p), projOf)]), ["all", grade(rows, projOf)]]);
}
