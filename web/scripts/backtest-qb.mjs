/**
 * Backtest the quarterback adjustment in src/lib/availability.ts on past seasons.
 *
 *   node scripts/backtest-qb.mjs                    # seasons 2022..2025
 *   SEASONS=2024,2025 node scripts/backtest-qb.mjs
 *
 * Walk-forward, no peeking: for every game the starter's value and the team baseline use only plays
 * before that game. The starter is the QB nflverse lists for the game (schedules home_qb_name and
 * away_qb_name), matched to the weekly stats by name inside the game; the QB with the most plays
 * otherwise. Same math as the live model:
 *
 *   QB value     weighted EPA a play over this season so far (weight 1) and the four seasons before
 *                (0.7, 0.5, 0.35, 0.25), shrunk with a 200-play prior whose mean slides from the 25th
 *                percentile QB (thin record) to the average QB (500+ weighted plays).
 *   baseline     this season's QB plays so far, each QB at his value, blended with last season's team
 *                QB plays; this season weighted games / (games + 6).
 *   adjustment   (starter - baseline) x the team's QB plays a game, capped at 12.
 *
 * Graded against finals and the nflverse closing line (schedule spread, positive = home favored):
 * Elo alone against Elo + k x (home adjustment - away adjustment) for k on a grid. Reports MAE, cover
 * rate of the model side, and the same on games where a QB change moved the margin 2+ points.
 *
 * Needs data/generated/schedule.json and the weekly stats files; downloads 2019..2021 to data/cache
 * if missing (about 8 MB each). Writes data/backtest/qb.json.
 */
import { mkdir, writeFile, access, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";
import { computeElo, ELO_HOME, ELO_PER_POINT } from "./lib/elo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const FIRST = Math.min(...SEASONS) - 4;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

const WEIGHTS = [1, 0.7, 0.5, 0.35, 0.25];
const PRIOR = 200;
const CAP = 12;

/* -------------------------------------------------------------- data */
const schedule = JSON.parse(await readFile(path.join(root, "data", "generated", "schedule.json"), "utf8"));
const played = schedule.filter((g) => g.played && g.hs != null && g.as != null);
const elo = computeElo(played);

async function weekFile(y) {
  const name = `stats_player_week_${y}.csv`;
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  log("download", name);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/${name}`, { redirect: "follow" });
  if (!res.ok) return undefined;
  await mkdir(CACHE, { recursive: true });
  await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

// QB lines per game: gid -> team code -> [{ pid, name, n, e }]
const byGame = new Map();
const maxSeason = Math.max(...SEASONS);
for (let y = FIRST; y <= maxSeason; y++) {
  const f = await weekFile(y);
  if (!f) {
    log("no weekly file for", y);
    continue;
  }
  await readCsv(f, (r) => {
    if (r.position !== "QB" || !r.game_id) return;
    const n = (num(r.attempts) ?? 0) + (num(r.sacks_suffered) ?? 0) + (num(r.carries) ?? 0);
    if (!n) return;
    const e = (num(r.passing_epa) ?? 0) + (num(r.rushing_epa) ?? 0);
    const g = byGame.get(r.game_id) ?? byGame.set(r.game_id, new Map()).get(r.game_id);
    const arr = g.get(r.team) ?? g.set(r.team, []).get(r.team);
    arr.push({ pid: r.player_id, name: r.player_display_name || r.player_name, n, e });
  });
  log("loaded", y);
}

// Chronological QB history: walk the schedule in kickoff order, record each QB's plays after each game.
const sorted = [...played].filter((g) => g.season >= FIRST).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
const qbSeason = new Map(); // pid -> Map(season -> { n, e })
const teamSeason = new Map(); // `${season}|${code}` -> Map(pid -> n)
const teamGames = new Map(); // `${season}|${code}` -> games played

function qbRecord(pid, season) {
  const m = qbSeason.get(pid);
  let n = 0;
  let e = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    const s = m?.get(season - i);
    if (!s) continue;
    n += WEIGHTS[i] * s.n;
    e += WEIGHTS[i] * s.e;
  }
  return { n, e };
}

// Replacement and average levels from every QB-season with 150+ plays (a fixed league yardstick).
let levels;
function computeLevels() {
  const rates = [];
  for (const m of qbSeason.values()) for (const s of m.values()) if (s.n >= 150) rates.push(s.e / s.n);
  rates.sort((a, b) => a - b);
  return { repl: rates[Math.floor(0.25 * (rates.length - 1))], mean: rates.reduce((a, b) => a + b, 0) / rates.length };
}
const shrink = ({ n, e }) => {
  const prior = levels.repl + (levels.mean - levels.repl) * Math.min(1, n / 500);
  return (e + prior * PRIOR) / (n + PRIOR);
};

const pending = [];
for (const g of sorted) {
  const lines = byGame.get(g.gid);
  const rec = { g, sides: {} };
  for (const side of ["home", "away"]) {
    const code = side === "home" ? g.homeCode : g.awayCode;
    const qbs = lines?.get(code) ?? [];
    const named = side === "home" ? g.homeQb : g.awayQb;
    const starter = qbs.find((q) => q.name === named) ?? [...qbs].sort((a, b) => b.n - a.n)[0];
    rec.sides[side] = { code, starter, qbs };
  }
  // Snapshot what is known before kickoff (values are computed lazily after levels exist).
  if (SEASONS.includes(g.season)) {
    const snap = {};
    for (const side of ["home", "away"]) {
      const { code, starter } = rec.sides[side];
      const key = `${g.season}|${code}`;
      const prevKey = `${g.season - 1}|${code}`;
      snap[side] = {
        starter: starter ? { pid: starter.pid, rec: qbRecord(starter.pid, g.season) } : undefined,
        now: [...(teamSeason.get(key) ?? new Map())].map(([pid, n]) => ({ n, rec: qbRecord(pid, g.season) })),
        prev: [...(teamSeason.get(prevKey) ?? new Map())].map(([pid, n]) => ({ n, rec: qbRecord(pid, g.season) })),
        games: teamGames.get(key) ?? 0,
        prevGames: teamGames.get(prevKey) ?? 0,
      };
    }
    pending.push({ g, snap });
  }
  // Then add this game's plays.
  for (const side of ["home", "away"]) {
    const { code, qbs } = rec.sides[side];
    const key = `${g.season}|${code}`;
    teamGames.set(key, (teamGames.get(key) ?? 0) + 1);
    const ts = teamSeason.get(key) ?? teamSeason.set(key, new Map()).get(key);
    for (const q of qbs) {
      const m = qbSeason.get(q.pid) ?? qbSeason.set(q.pid, new Map()).get(q.pid);
      const s = m.get(g.season) ?? { n: 0, e: 0 };
      m.set(g.season, { n: s.n + q.n, e: s.e + q.e });
      ts.set(q.pid, (ts.get(q.pid) ?? 0) + q.n);
    }
  }
}
levels = computeLevels();
log("games to grade", pending.length, "QB levels", levels);

function adjustment(s) {
  if (!s.starter) return { adj: 0, known: false };
  const v = shrink(s.starter.rec);
  const mix = (rows) => {
    const tot = rows.reduce((a, b) => a + b.n, 0);
    return tot ? { val: rows.reduce((a, r) => a + shrink(r.rec) * r.n, 0) / tot, tot } : undefined;
  };
  const now = mix(s.now);
  const prev = mix(s.prev);
  if (!now && !prev) return { adj: 0, known: false };
  const wNow = !prev ? 1 : !now ? 0 : s.games / (s.games + 6);
  const base = wNow * (now?.val ?? 0) + (1 - wNow) * (prev?.val ?? 0);
  const ppg = now ? now.tot / Math.max(1, s.games) : prev ? prev.tot / Math.max(1, s.prevGames) : 37;
  return { adj: Math.max(-CAP, Math.min(CAP, (v - base) * ppg)), known: true };
}

/* ------------------------------------------------------------- grade */
const rows = [];
for (const { g, snap } of pending) {
  const pre = elo.pregame.get(g.id);
  if (!pre || g.spread == null) continue;
  const eloMargin = (pre.home + (g.neutral ? 0 : ELO_HOME) - pre.away) / ELO_PER_POINT;
  const h = adjustment(snap.home);
  const a = adjustment(snap.away);
  rows.push({ id: g.id, season: g.season, week: g.week, eloMargin, qb: h.adj - a.adj, market: g.spread, actual: g.hs - g.as, homeQb: g.homeQb, awayQb: g.awayQb, h: h.adj, a: a.adj });
}
log("graded rows", rows.length);

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
function grade(set, k) {
  let ae = 0;
  let cov = 0;
  let n = 0;
  let cov2 = 0;
  let n2 = 0;
  let cov4 = 0;
  let n4 = 0;
  for (const r of set) {
    const m = r.eloMargin + k * r.qb;
    ae += Math.abs(m - r.actual);
    const ats = r.actual - r.market; // positive = home covered
    if (ats === 0 || m === r.market) continue;
    const pickHome = m > r.market;
    const win = pickHome ? ats > 0 : ats < 0;
    n++;
    cov += win ? 1 : 0;
    const gap = Math.abs(m - r.market);
    if (gap >= 2) { n2++; cov2 += win ? 1 : 0; }
    if (gap >= 4) { n4++; cov4 += win ? 1 : 0; }
  }
  return { k, mae: r3(ae / set.length), cover: r3(cov / n), n, cover2: n2 ? r3(cov2 / n2) : null, n2, cover4: n4 ? r3(cov4 / n4) : null, n4 };
}
const marketMae = (set) => r3(set.reduce((a, r) => a + Math.abs(r.market - r.actual), 0) / set.length);
const KS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
const changed = rows.filter((r) => Math.abs(r.qb) >= 2);
// Does the QB term point the same way the market moved off Elo? (market minus Elo against the QB term)
const corr = (xs, ys) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return r3(sxy / Math.sqrt(sxx * syy));
};
const out = {
  builtAt: new Date().toISOString(),
  seasons: SEASONS,
  levels: { repl: r3(levels.repl), mean: r3(levels.mean) },
  games: rows.length,
  marketMae: marketMae(rows),
  all: KS.map((k) => grade(rows, k)),
  qbChanged: { games: changed.length, marketMae: changed.length ? marketMae(changed) : null, grid: KS.map((k) => grade(changed, k)) },
  qbTermVsMarketMinusElo: corr(rows.map((r) => r.qb), rows.map((r) => r.market - r.eloMargin)),
  qbTermVsActualMinusElo: corr(rows.map((r) => r.qb), rows.map((r) => r.actual - r.eloMargin)),
  bySeason: SEASONS.map((s) => {
    const set = rows.filter((r) => r.season === s);
    return { season: s, games: set.length, elo: grade(set, 0), eloQb: grade(set, 1) };
  }),
  biggest: [...rows].sort((a, b) => Math.abs(b.qb) - Math.abs(a.qb)).slice(0, 15).map((r) => ({ id: r.id, season: r.season, week: r.week, qbs: `${r.awayQb} at ${r.homeQb}`, qb: r2(r.qb), elo: r2(r.eloMargin), market: r.market, actual: r.actual })),
};
// Cover rate of the model side by how far the model sits from the closing number, at the live scale (0.75).
const LIVE_K = 0.75;
const BUCKETS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6], [6, 99]];
out.byGap = BUCKETS.map(([lo, hi]) => {
  for (const k of [0, LIVE_K]) {
    const set = rows.filter((r) => {
      const gap = Math.abs(r.eloMargin + k * r.qb - r.market);
      return gap >= lo && gap < hi;
    });
    const g = grade(set, k);
    if (k === LIVE_K) return { gap: `${lo} to ${hi === 99 ? "more" : hi}`, games: set.length, coverEloQb: g.cover, n: g.n };
  }
});
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "qb.json"), JSON.stringify(out, null, 2));
console.log(`Cover rate of the model side by gap to the closing line, k = ${LIVE_K} (break-even at -110 is 0.524):`);
console.table(out.byGap);
log("market MAE", out.marketMae, "| corr(QB term, market - Elo)", out.qbTermVsMarketMinusElo, "| corr(QB term, actual - Elo)", out.qbTermVsActualMinusElo);
console.table(out.all);
console.log(`QB change games (|term| >= 2): ${changed.length}, market MAE ${out.qbChanged.marketMae}`);
console.table(out.qbChanged.grid);
console.table(out.bySeason.map((s) => ({ season: s.season, games: s.games, eloMae: s.elo.mae, eloQbMae: s.eloQb.mae, eloCover: s.elo.cover, eloQbCover: s.eloQb.cover })));
console.table(out.biggest);
