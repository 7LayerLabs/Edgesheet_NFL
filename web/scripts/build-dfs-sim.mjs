/**
 * Build the DraftKings simulator's history: data/backtest/dfs-sim.json (tracked, so every copy simulates the same way).
 *
 *   node scripts/build-dfs-sim.mjs            # seasons 2022 to 2025 (2021 supplies the first prior), cached nflverse files
 *
 * 1. Walk-forward player projections exactly as src/lib/dfs.ts makes them: week 3 on, QB RB WR TE with 2+ games, this
 *    season's DK points a game blended with last season at 3 / (games + 3), times a quarter of the opponent factor.
 * 2. Walk-forward DST projections with the live formula (projectDst in src/lib/dst-core.mjs, the same function the app
 *    calls): sacks and takeaways from the defense's and the opponent's rates so far, TDs shrunk to the league rate,
 *    points allowed from the market's implied opponent total. Graded against the defense's season average.
 * 3. Outcome shapes: actual / projected for players, actual - projected for DST, as 101 quantiles per position and
 *    projection tier. These are the boom and bust ranges, measured.
 * 4. Correlations: rank-normal scores of those residuals, paired by role inside each game, fit to a three-factor model
 *    (a game scoring shock shared by both teams, a team offense shock, a pass-versus-run tilt) so the live simulator
 *    draws a whole slate consistently.
 * 5. Calibration gate, leave one season out: shapes built from the other seasons cover the held-out one (share of
 *    actuals under the 10th and 50th percentiles and over the 90th). Gate: the average over held-out seasons within 3
 *    points of nominal and every single season within 6, by position. Single seasons drift (2022 scored low, 2024
 *    high) because the league's scoring level moves every player's range together.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";
import { blendRate, dstPoints, projectDst, seasonRates, teamWeeks } from "../src/lib/dst-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest", "dfs-sim.json");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const POS = ["QB", "RB", "WR", "TE"];
const PRIOR_GAMES = 3;
const MATCHUP_WEIGHT = 0.25;

/* ------------------------------------------------------------ scoring (same rules as dfs.ts and backtest-dfs.mjs) */

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) +
    n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fumbles_lost_total") + n("special_teams_tds") * 6;
};

/* ------------------------------------------------------------ loading */

async function playerRows(season) {
  const rows = [];
  await readCsv(path.join(CACHE, `stats_player_week_${season}.csv`), (r) => {
    if (r.season_type !== "REG") return;
    const n = (k) => num(r[k]) ?? 0;
    rows.push({
      id: r.player_id, pos: r.position, week: Number(r.week), team: r.team, opp: r.opponent_team, gid: r.game_id,
      pts: POS.includes(r.position) ? dk(r) : 0,
      sk: n("def_sacks"), int: n("def_interceptions"), fr: n("fumble_recovery_opp"), dtd: n("def_tds"), sttd: n("special_teams_tds"), saf: n("def_safeties"),
      give: n("passing_interceptions") + n("fumbles_lost_total"), sks: n("sacks_suffered"),
    });
  });
  return rows;
}

async function games() {
  const out = new Map(); // `${season}|${week}|${team}` -> { gid, opp, score, oppScore, implied, oppImplied }
  await readCsv(path.join(CACHE, "games.csv"), (r) => {
    if (r.game_type !== "REG" || r.home_score === "") return;
    const season = Number(r.season), week = Number(r.week);
    const spread = num(r.spread_line), total = num(r.total_line);
    const hs = Number(r.home_score), as = Number(r.away_score);
    // nflverse spread_line: positive = home favored by that many.
    const homeImp = spread != null && total != null ? (total + spread) / 2 : undefined;
    const awayImp = spread != null && total != null ? (total - spread) / 2 : undefined;
    out.set(`${season}|${week}|${r.home_team}`, { gid: r.game_id, opp: r.away_team, score: hs, oppScore: as, implied: homeImp, oppImplied: awayImp });
    out.set(`${season}|${week}|${r.away_team}`, { gid: r.game_id, opp: r.home_team, score: as, oppScore: hs, implied: awayImp, oppImplied: homeImp });
  });
  return out;
}

/* ------------------------------------------------------------ statistics */

const quantiles = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  return Array.from({ length: 101 }, (_, i) => {
    const pos = (i / 100) * (a.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return Math.round((a[lo] + (a[hi] - a[lo]) * (pos - lo)) * 1000) / 1000;
  });
};
function invNorm(p) {
  // Acklam's rational approximation.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p < 0.02425 ? Math.sqrt(-2 * Math.log(p)) : p > 1 - 0.02425 ? Math.sqrt(-2 * Math.log(1 - p)) : 0;
  if (p < 0.02425) return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p > 1 - 0.02425) return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  const r = (p - 0.5) * (p - 0.5);
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * (p - 0.5)) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Projection tiers (DK points). The live simulator looks these up with the same edges. */
export const TIERS = { QB: [14, 18, 22], RB: [8, 12, 16], WR: [8, 12, 16], TE: [6, 10], DST: [5.5, 7.5] };
const tierOf = (pos, proj) => {
  const edges = TIERS[pos];
  let i = 0;
  while (i < edges.length && proj >= edges[i]) i++;
  return `${pos}${i}`;
};

/* ------------------------------------------------------------ walk-forward */

/** One season: projected and actual DK points for every eligible player-week and team-week (DST). */
function walkSeason(season, rows, prevRows, sched) {
  const out = [];
  // Last season per game: players (DK points) and teams (DST inputs).
  const prevPlayer = new Map();
  for (const r of prevRows) {
    if (!POS.includes(r.pos)) continue;
    const e = prevPlayer.get(r.id) ?? prevPlayer.set(r.id, { pts: 0, n: 0 }).get(r.id);
    e.pts += r.pts;
    e.n++;
  }
  const oppScore = (y) => (w) => sched.get(`${y}|${w.week}|${w.team}`)?.oppScore;
  const prevTeams = seasonRates(teamWeeks(prevRows).values(), oppScore(season - 1));
  const teams = [...teamWeeks(rows).values()];
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  for (const w of weeks) {
    if (w < 3) continue;
    const before = rows.filter((r) => r.week < w);
    // Opponent factor: DK points allowed a game to the position so far, against the league.
    const allowed = new Map();
    for (const r of before) {
      if (!POS.includes(r.pos)) continue;
      const key = `${r.opp}|${r.pos}`;
      const e = allowed.get(key) ?? allowed.set(key, { pts: 0, games: new Set() }).get(key);
      e.pts += r.pts;
      e.games.add(r.week);
    }
    const league = {};
    for (const pos of POS) {
      const per = [...allowed.entries()].filter(([k]) => k.endsWith(`|${pos}`)).map(([, e]) => e.pts / e.games.size);
      league[pos] = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
    }
    const hist = new Map();
    for (const r of before) {
      if (!POS.includes(r.pos)) continue;
      const e = hist.get(r.id) ?? hist.set(r.id, { pts: 0, n: 0 }).get(r.id);
      e.pts += r.pts;
      e.n++;
    }
    for (const r of rows) {
      if (r.week !== w || !POS.includes(r.pos)) continue;
      const h = hist.get(r.id);
      if (!h || h.n < 2) continue;
      const now = h.pts / h.n;
      const p = prevPlayer.get(r.id);
      const base = p && p.n >= 4 ? (h.n * now + PRIOR_GAMES * (p.pts / p.n)) / (h.n + PRIOR_GAMES) : now;
      const a = allowed.get(`${r.opp}|${r.pos}`);
      const factor = a && league[r.pos] ? Math.min(1.35, Math.max(0.7, a.pts / a.games.size / league[r.pos])) : 1;
      const proj = base * (1 + MATCHUP_WEIGHT * (factor - 1));
      if (proj < 3) continue;
      out.push({ season, week: w, gid: r.gid, team: r.team, opp: r.opp, pos: r.pos, id: r.id, proj, actual: r.pts });
    }
    // DST: the live projection (dst-core.mjs) from rates so far, last season, and the market's implied opponent total.
    const soFar = seasonRates(teams.filter((t) => t.week < w), oppScore(season));
    for (const t of teams) {
      if (t.week !== w) continue;
      const g = sched.get(`${season}|${w}|${t.team}`);
      if (!g || g.oppImplied === undefined || !soFar.get(t.team)?.g) continue;
      const side = (team) => ({ now: soFar.get(team), prev: prevTeams.get(team) });
      const { proj } = projectDst(side(t.team), side(t.opp), g.oppImplied);
      out.push({ season, week: w, gid: g.gid, team: t.team, opp: t.opp, pos: "DST", id: `DST-${t.team}`, proj, actual: dstPoints(t, g.oppScore), baseline: blendRate(soFar.get(t.team), prevTeams.get(t.team), "dst") });
    }
  }
  return out;
}

/* ------------------------------------------------------------ run */

const sched = await games();
const all = [];
const cache = new Map();
const load = async (y) => cache.get(y) ?? cache.set(y, await playerRows(y)).get(y);
for (const season of SEASONS) all.push(...walkSeason(season, await load(season), await load(season - 1), sched));

// DST model against the season-average baseline.
const dstRows = all.filter((r) => r.pos === "DST" && r.baseline !== undefined);
const mae = (f) => Math.round((dstRows.reduce((a, r) => a + Math.abs(f(r) - r.actual), 0) / dstRows.length) * 1000) / 1000;
const dstReport = { games: dstRows.length, maeModel: mae((r) => r.proj), maeBaseline: mae((r) => r.baseline), maeFlat: mae(() => dstRows.reduce((a, r) => a + r.actual, 0) / dstRows.length) };

// Residuals: ratio for players, difference for DST.
const resid = (r) => (r.pos === "DST" ? r.actual - r.proj : r.actual / r.proj);
const shapes = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const k = tierOf(r.pos, r.proj);
    (by.get(k) ?? by.set(k, []).get(k)).push(resid(r));
  }
  return Object.fromEntries([...by.entries()].sort().map(([k, xs]) => [k, { n: xs.length, q: quantiles(xs) }]));
};

// Calibration gate, leave one season out.
function holdOut(test) {
const trainShapes = shapes(all.filter((r) => r.season !== test));
const coverage = {};
for (const r of all.filter((x) => x.season === test)) {
  const s = trainShapes[tierOf(r.pos, r.proj)];
  if (!s) continue;
  const c = coverage[r.pos] ?? (coverage[r.pos] = { n: 0, under10: 0, under50: 0, over90: 0 });
  const x = resid(r);
  c.n++;
  // A tie with the quantile counts half: many low-end receivers score exactly 0, which is also their 10th percentile.
  const below = (q) => (x < q ? 1 : x === q ? 0.5 : 0);
  const above = (q) => (x > q ? 1 : x === q ? 0.5 : 0);
  c.under10 += below(s.q[10]);
  c.under50 += below(s.q[50]);
  c.over90 += above(s.q[90]);
}
const pct = (c, k) => Math.round((c[k] / c.n) * 1000) / 10;
return Object.fromEntries(Object.entries(coverage).map(([pos, c]) => [pos, { n: c.n, under10: pct(c, "under10"), under50: pct(c, "under50"), over90: pct(c, "over90") }]));
}
const bySeason = Object.fromEntries(SEASONS.map((y) => [y, holdOut(y)]));
const off = (row) => Math.max(Math.abs(row.under10 - 10), Math.abs(row.under50 - 50), Math.abs(row.over90 - 10));
const calibration = Object.fromEntries(["QB", "RB", "WR", "TE", "DST"].map((pos) => {
  const rows = SEASONS.map((y) => bySeason[y][pos]).filter(Boolean);
  const avg = (k) => Math.round((rows.reduce((a, r) => a + r[k], 0) / rows.length) * 10) / 10;
  const mean = { under10: avg("under10"), under50: avg("under50"), over90: avg("over90") };
  const worst = Math.round(Math.max(...rows.map(off)) * 10) / 10;
  return [pos, { ...mean, worstSeasonOff: worst, pass: off(mean) <= 3 && worst <= 6 }];
}));
const calibrationPass = Object.values(calibration).every((c) => c.pass);

// Rank-normal scores within each tier, then role pairs inside each game.
const finalShapes = shapes(all);
const byTier = new Map();
for (const r of all) (byTier.get(tierOf(r.pos, r.proj)) ?? byTier.set(tierOf(r.pos, r.proj), []).get(tierOf(r.pos, r.proj))).push(r);
for (const rs of byTier.values()) {
  rs.sort((a, b) => resid(a) - resid(b));
  rs.forEach((r, i) => (r.z = invNorm((i + 0.5) / rs.length)));
}
const roleOf = new Map(); // row -> role
const byTeamWeek = new Map();
for (const r of all) (byTeamWeek.get(`${r.season}|${r.week}|${r.team}`) ?? byTeamWeek.set(`${r.season}|${r.week}|${r.team}`, []).get(`${r.season}|${r.week}|${r.team}`)).push(r);
for (const rs of byTeamWeek.values()) {
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const cap = { QB: 1, RB: 2, WR: 3, TE: 1 }[pos];
    rs.filter((r) => r.pos === pos).sort((a, b) => b.proj - a.proj).slice(0, cap).forEach((r, i) => roleOf.set(r, `${pos}${i + 1}`));
  }
  for (const r of rs) if (r.pos === "DST") roleOf.set(r, "DST");
}
const pairs = new Map(); // key -> { sxy, sxx, syy, n }
const add = (key, a, b) => {
  const e = pairs.get(key) ?? pairs.set(key, { sxy: 0, sxx: 0, syy: 0, n: 0 }).get(key);
  e.sxy += a * b; e.sxx += a * a; e.syy += b * b; e.n++;
};
const byGame = new Map();
for (const r of all) if (roleOf.has(r)) (byGame.get(`${r.season}|${r.gid}`) ?? byGame.set(`${r.season}|${r.gid}`, []).get(`${r.season}|${r.gid}`)).push(r);
for (const rs of byGame.values()) {
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    const ra = roleOf.get(a), rb = roleOf.get(b);
    const same = a.team === b.team;
    if (ra === "DST" && rb === "DST") add("dst-dst", a.z, b.z);
    else if (ra === "DST" || rb === "DST") {
      const [d, o] = ra === "DST" ? [a, b] : [b, a];
      add(`${d.team === o.team ? "dst-own" : "dst-opp"}:${roleOf.get(o)}`, d.z, o.z);
    } else add(`${same ? "same" : "opp"}:${[ra, rb].sort().join("|")}`, a.z, b.z);
  }
}
const observed = Object.fromEntries([...pairs.entries()].filter(([, e]) => e.n >= 150).map(([k, e]) => [k, { r: Math.round((e.sxy / Math.sqrt(e.sxx * e.syy)) * 1000) / 1000, n: e.n }]));

// Factor fit. Offense loads on the game shock (g, shared by both teams), its team's offense shock (t), and its team's
// pass-versus-run tilt (s). Each pass catcher (WR1-3, TE1) also has his own link shock (p) that his quarterback loads on
// (q): a QB's day is roughly the sum of his receivers' days, while receivers compete for the same targets. A DST loads on
// the game shock, the OPPONENT's offense shock (stored as t), and its own team's tilt.
const posOf = (role) => (role === "DST" ? "DST" : role.replace(/\d$/, ""));
const LINKS = ["WR1", "WR2", "WR3", "TE1"];
let L = {
  QB: { g: 0.2, t: 0.3, s: 0.3 }, RB: { g: 0.15, t: 0.3, s: -0.2 }, WR: { g: 0.15, t: 0.15, s: 0.15 }, TE: { g: 0.1, t: 0.1, s: 0.15 }, DST: { g: -0.1, t: -0.5, s: -0.1 },
  link: { WR1: { p: 0.5, q: 0.4 }, WR2: { p: 0.4, q: 0.3 }, WR3: { p: 0.3, q: 0.2 }, TE1: { p: 0.4, q: 0.2 } },
};
const implied = (key, M) => {
  if (key === "dst-dst") return M.DST.g * M.DST.g;
  const [kind, roles] = key.split(":");
  if (kind === "dst-own") { const o = M[posOf(roles)]; return M.DST.g * o.g + M.DST.s * o.s; }
  if (kind === "dst-opp") { const o = M[posOf(roles)]; return M.DST.g * o.g + M.DST.t * o.t; }
  const [ra, rb] = roles.split("|");
  const x = M[posOf(ra)], y = M[posOf(rb)];
  if (kind !== "same") return x.g * y.g;
  const link = ra === "QB1" && M.link[rb] ? M.link[rb].q * M.link[rb].p : rb === "QB1" && M.link[ra] ? M.link[ra].q * M.link[ra].p : 0;
  return x.g * y.g + x.t * y.t + x.s * y.s + link;
};
const loss = (M) => Object.entries(observed).reduce((a, [k, o]) => a + o.n * (implied(k, M) - o.r) ** 2, 0);
const sq = (v) => v.g * v.g + v.t * v.t + v.s * v.s;
const valid = (M) =>
  ["RB", "DST"].every((p) => sq(M[p]) <= 0.95) &&
  sq(M.QB) + LINKS.reduce((a, r) => a + M.link[r].q ** 2, 0) <= 0.95 &&
  LINKS.every((r) => sq(M[posOf(r)]) + M.link[r].p ** 2 <= 0.95);
const knobs = [...["QB", "RB", "WR", "TE", "DST"].flatMap((pos) => ["g", "t", "s"].map((k) => [pos, k])), ...LINKS.flatMap((r) => [["link", r, "p"], ["link", r, "q"]])];
const get = (M, kn) => (kn[0] === "link" ? M.link[kn[1]][kn[2]] : M[kn[0]][kn[1]]);
const set = (M, kn, v) => (kn[0] === "link" ? (M.link[kn[1]][kn[2]] = v) : (M[kn[0]][kn[1]] = v));
for (let step = 0.1; step > 0.0005; step /= 2) {
  for (let improved = true; improved; ) {
    improved = false;
    for (const kn of knobs) for (const dir of [1, -1]) {
      const M = structuredClone(L);
      set(M, kn, Math.round((get(M, kn) + dir * step) * 10000) / 10000);
      if (valid(M) && loss(M) < loss(L)) { L = M; improved = true; }
    }
  }
}
const fit = Object.fromEntries(Object.entries(observed).map(([k, o]) => [k, { observed: o.r, fitted: Math.round(implied(k, L) * 1000) / 1000, n: o.n }]));

const result = {
  builtAt: new Date().toISOString(),
  seasons: SEASONS,
  note: "Built by scripts/build-dfs-sim.mjs. Players: actual / projected DK points; DST: actual - projected. Quantiles 0..100 by tier.",
  tiers: TIERS,
  shapes: finalShapes,
  loadings: L,
  fit,
  calibration: { method: "leave one season out", byPos: calibration, bySeason, pass: calibrationPass },
  dst: { report: dstReport },
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(result, null, 1));

console.log(`player-weeks ${all.filter((r) => r.pos !== "DST").length}, DST team-weeks ${all.filter((r) => r.pos === "DST").length}`);
console.log("DST model vs baseline:", dstReport);
console.log("Calibration, leave one season out (average over held-out seasons; worst single season's distance from nominal):");
console.table(calibration);
console.log("Factor loadings:", JSON.stringify(L));
console.table(Object.entries(fit).sort((a, b) => b[1].n - a[1].n).slice(0, 24).map(([k, v]) => ({ pair: k, ...v })));
console.log("Shape medians (p50) and 10th/90th by tier:");
console.table(Object.fromEntries(Object.entries(finalShapes).map(([k, s]) => [k, { n: s.n, p10: s.q[10], p50: s.q[50], p90: s.q[90] }])));
