/**
 * Backtest the DraftKings projection in src/lib/dfs.ts on the standard pool.
 *
 *   node scripts/backtest-dfs.mjs                 # seasons 2022 to 2025 (2021 supplies the first prior)
 *
 * Walk-forward per week (week 3 on), every player a projection is made for (scripts/backtest-dfs-core.mjs: 2+ games, on
 * the game roster, not Out or Doubtful, one quarterback a team), graded against his DK points that week; no stat line
 * counts as 0. The standard pool is the top 20 QBs and TEs and the top 40 RBs and WRs by the live projection each week.
 *   live      the projection as dfs.ts makes it: DK points a game blended with last season at 3 / (games + 3), half
 *             expected fantasy points, a quarter of the opponent factor, plus the next-man-up bump, scaled by the game's
 *             implied team total, then the calibration line (the last two from scripts/backtest-dfs-fit.mjs, fit on
 *             2022-23, so 2022-23 is in sample for them; their out-of-sample test is in data/backtest/dfs-fit.json)
 *   before    the same without the implied-total scaler and the calibration line (live until 2026-10-14)
 *   average   his DK points a game so far this season (the benchmark)
 * Reports MAE and mean error (projection minus actual) per position, per season, the same pool graded only on stat
 * lines (how the old backtest counted), and, for reference, a grid of the prior weight k and the matchup weight s.
 * Writes data/backtest/dfs.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIVE, OUT, POS, POOL_SIZE, byPos, liveProj, loadSeason, pairedDiff, schedule, standardPool, walkSeason } from "./backtest-dfs-core.mjs";

const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const K = [0, 1, 2, 3, 4, 6];
const S = [0, 0.25, 0.5];

const sched = await schedule();
const all = [];
for (const season of SEASONS) all.push(...walkSeason(await loadSeason(season, sched)));

const live = (r) => liveProj(r);
const before = (r) => liveProj(r, { ...LIVE, volume: { QB: 0, RB: 0, WR: 0, TE: 0 }, calibration: undefined });
const avg = (r) => r.now;
const pool = standardPool(all, live);

const diffs = Object.fromEntries([...POS.map((p) => [p, pairedDiff(pool.filter((r) => r.pos === p), avg, live)]), ["all", pairedDiff(pool, avg, live)]]);
const benchmark = { live: byPos(pool, live), before: byPos(pool, before), average: byPos(pool, avg), liveMinusAverage: diffs };
const bySeason = Object.fromEntries(SEASONS.map((y) => {
  const rs = pool.filter((r) => r.season === y);
  return [y, { live: byPos(rs, live), before: byPos(rs, before), average: byPos(rs, avg) }];
}));

// What the old way of counting (stat lines only) hid.
const zeros = pool.filter((r) => !r.played);
const survivorship = {
  poolWeeks: pool.length,
  noStatLine: zeros.length,
  inactive: zeros.filter((r) => r.inactive).length,
  inactiveQuestionable: zeros.filter((r) => r.inactive && r.q).length,
  activeNoStatLine: zeros.filter((r) => !r.inactive).length,
  liveAllWeeks: byPos(pool, live),
  liveStatLinesOnly: byPos(pool.filter((r) => r.played), live),
};

// Reference grid on the same pool: prior weight k and matchup weight s (everything else as live).
const ys = pool.map((r) => r.actual);
const corr = (xs) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000;
};
const grid = [];
for (const k of K) for (const s of S) {
  const xs = pool.map((r) => liveProj(r, { ...LIVE, priorGames: k, matchupWeight: s }));
  const mae = xs.reduce((a, x, i) => a + Math.abs(x - ys[i]), 0) / xs.length;
  grid.push({ k, s, mae: Math.round(mae * 1000) / 1000, corr: corr(xs), live: k === LIVE.priorGames && s === LIVE.matchupWeight });
}
grid.sort((a, b) => a.mae - b.mae);

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "dfs.json"), JSON.stringify({
  builtAt: new Date().toISOString(),
  seasons: SEASONS,
  pool: POOL_SIZE,
  note: "Standard pool by the live projection, weeks 3 on, regular season. No stat line counts as 0. mae and bias (projection minus actual) in DK points; liveMinusAverage is the paired MAE difference (negative = the projection misses less) with its standard error.",
  benchmark,
  bySeason,
  survivorship,
  grid,
}, null, 1));

console.log(`Standard pool ${SEASONS.join(", ")}: ${pool.length} player-weeks, ${zeros.length} with no stat line (${survivorship.inactive} inactive, ${survivorship.activeNoStatLine} active without a stat line)`);
console.log("Live projection:");
console.table(benchmark.live);
console.log("Season-to-date average:");
console.table(benchmark.average);
console.log("Live minus average, paired MAE difference:");
console.table(diffs);
console.log("Before the implied-total scaler and calibration (same pool):");
console.table(benchmark.before);
console.log("By season, MAE live / before / average:");
console.table(Object.fromEntries(SEASONS.map((y) => [y, Object.fromEntries([...POS, "all"].map((p) => [p, `${bySeason[y].live[p].mae} / ${bySeason[y].before[p].mae} / ${bySeason[y].average[p].mae}`]))])));
console.log("Live projection graded the old way (stat lines only) on the same pool:");
console.table(survivorship.liveStatLinesOnly);
console.log("Reference grid (k prior games, s matchup weight):");
console.table(grid.slice(0, 8));
