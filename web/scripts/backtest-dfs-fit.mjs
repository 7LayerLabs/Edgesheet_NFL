/**
 * Two candidate changes to the DraftKings projection, each fit on 2022-23 and graded on 2024-25 (audit items 5.2 and
 * 5.3; rules in tasks/todo.md, written before this ran). Each goes live only if it lowers the 2024-25 miss (MAE, all
 * positions together) on the standard pool. 5.3 is fit on top of 5.2 when 5.2 passes. The incumbent is the projection
 * as it was before both (BEFORE below), so the script reruns the same test after the live settings change.
 *
 *   node scripts/backtest-dfs-fit.mjs
 *
 * Players and grading as scripts/backtest-dfs.mjs (scripts/backtest-dfs-core.mjs: no stat line counts as 0); the pool is
 * chosen by the projection being challenged, so both versions are graded on the same player-weeks.
 *
 * 5.2 Volume: projection x (1 + w x (ratio - 1)), w per position on a grid 0 to 2. Two ratios, the one with the lower
 *     2022-23 miss at its best weights is the one graded:
 *       team    the team's implied total this game (closing line: total / 2 plus or minus spread / 2) over its average
 *               implied total in its games so far this season (the games his average came from)
 *       league  the team's implied total over the league's average implied team total so far this season
 * 5.3 Calibration: actual = a + b x projection per position, least squares on the 2022-23 pool. Graded as tested (the
 *     line for everyone in the pool) and as it runs live: the line from the pool's floor up (the fit seasons' average
 *     projection of the last player in the weekly pool), scaled by the line's ratio at the floor below it, because the
 *     line raises low projections and players below the pool were already projected too high. Players below the pool
 *     are reported for both.
 *
 * Writes data/backtest/dfs-fit.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIVE, OUT, POS, POOL_SIZE, byPos, calibrate, liveProj, loadSeason, pairedDiff, schedule, standardPool, walkSeason } from "./backtest-dfs-core.mjs";

const FIT = [2022, 2023];
const TEST = [2024, 2025];
const W = Array.from({ length: 41 }, (_, i) => Math.round(i * 5) / 100);
const BEFORE = { ...LIVE, volume: { QB: 0, RB: 0, WR: 0, TE: 0 }, calibration: undefined };

const sched = await schedule();
const all = [];
for (const season of [...FIT, ...TEST]) all.push(...walkSeason(await loadSeason(season, sched)));
const isFit = (r) => FIT.includes(r.season);
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Grade a challenger against an incumbent on the incumbent's pool, fit and test seasons apart. */
function verdict(incumbent, challenger) {
  const pool = standardPool(all, incumbent);
  const test = pool.filter((r) => !isFit(r));
  const fit = pool.filter(isFit);
  const inPool = new Set(pool);
  const below = all.filter((r) => !isFit(r) && !inPool.has(r));
  const before = byPos(test, incumbent), after = byPos(test, challenger);
  return {
    fitSeasons: { before: byPos(fit, incumbent), after: byPos(fit, challenger) },
    testSeasons: { before, after, diff: Object.fromEntries([...POS.map((p) => [p, pairedDiff(test.filter((r) => r.pos === p), incumbent, challenger)]), ["all", pairedDiff(test, incumbent, challenger)]]) },
    belowPool: { before: byPos(below, incumbent), after: byPos(below, challenger) },
    pass: after.all.mae < before.all.mae,
  };
}

/* ------------------------------------------------------------ 5.2 implied team total as a volume scaler */

const ratios = {
  team: (r) => (r.implied !== undefined && r.teamImplied ? r.implied / r.teamImplied : 1),
  league: (r) => (r.implied !== undefined && r.leagueImplied ? r.implied / r.leagueImplied : 1),
};
const live = (r) => liveProj(r, BEFORE);
const fitPool = standardPool(all, live).filter(isFit);
const fits = {};
for (const [name, ratio] of Object.entries(ratios)) {
  const weights = {};
  let ae = 0;
  for (const pos of POS) {
    const rs = fitPool.filter((r) => r.pos === pos);
    let best;
    for (const w of W) {
      const m = rs.reduce((a, r) => a + Math.abs(live(r) * (1 + w * (ratio(r) - 1)) - r.actual), 0);
      if (!best || m < best.m) best = { w, m };
    }
    weights[pos] = best.w;
    ae += best.m;
  }
  fits[name] = { weights, fitMae: r3(ae / fitPool.length) };
}
const chosen = fits.team.fitMae <= fits.league.fitMae ? "team" : "league";
const volume = (r) => live(r) * (1 + fits[chosen].weights[r.pos] * (ratios[chosen](r) - 1));
const v52 = verdict(live, volume);

/* ------------------------------------------------------------ 5.3 calibration slope per position */

const incumbent = v52.pass ? volume : live;
const calPool = standardPool(all, incumbent).filter(isFit);
const calibration = {};
for (const pos of POS) {
  const rs = calPool.filter((r) => r.pos === pos);
  const xs = rs.map(incumbent), ys = rs.map((r) => r.actual);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx;
  // The pool's floor: the last pool player's projection, averaged over the fit seasons' weeks.
  const weeks = new Map();
  for (const r of rs) (weeks.get(`${r.season}|${r.week}`) ?? weeks.set(`${r.season}|${r.week}`, []).get(`${r.season}|${r.week}`)).push(incumbent(r));
  const floors = [...weeks.values()].filter((ps) => ps.length === POOL_SIZE[pos]).map((ps) => Math.min(...ps));
  calibration[pos] = { a: r3(my - b * mx), b: r3(b), floor: Math.round((floors.reduce((s, x) => s + x, 0) / floors.length) * 10) / 10 };
}
const asTested = (r) => Math.max(0, calibration[r.pos].a + calibration[r.pos].b * incumbent(r));
const asLive = (r) => calibrate(calibration[r.pos], incumbent(r));
const v53 = verdict(incumbent, asTested);
const v53live = verdict(incumbent, asLive);

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "dfs-fit.json"), JSON.stringify({
  builtAt: new Date().toISOString(),
  fitSeasons: FIT,
  testSeasons: TEST,
  rule: "Fit on 2022-23, graded on 2024-25 on the standard pool (top 20 QB and TE, top 40 RB and WR by the incumbent projection); live only if the 2024-25 MAE over all positions is lower. diff = paired MAE difference, challenger minus incumbent (negative = better), with its standard error. belowPool = 2024-25 players outside the pool, for information.",
  before: { priorGames: BEFORE.priorGames, xfpWeight: BEFORE.xfpWeight, matchupWeight: BEFORE.matchupWeight, nextManUp: BEFORE.nextManUp },
  volume: { ratios: fits, chosen, ...v52 },
  calibration: { onTopOfVolume: v52.pass, fit: calibration, asTested: v53, asLive: v53live },
}, null, 1));

const show = (label, v) => {
  console.log(`${label}: ${v.pass ? "PASS" : "FAIL"} (2024-25 pool MAE ${v.testSeasons.before.all.mae} -> ${v.testSeasons.after.all.mae}; below the pool ${v.belowPool.before.all.mae} -> ${v.belowPool.after.all.mae})`);
  console.table(Object.fromEntries([...POS, "all"].map((p) => [p, {
    n: v.testSeasons.before[p].n,
    maeBefore: v.testSeasons.before[p].mae, maeAfter: v.testSeasons.after[p].mae,
    biasBefore: v.testSeasons.before[p].bias, biasAfter: v.testSeasons.after[p].bias,
    diff: v.testSeasons.diff[p].diff, se: v.testSeasons.diff[p].se,
    fitBefore: v.fitSeasons.before[p].mae, fitAfter: v.fitSeasons.after[p].mae,
    belowBefore: v.belowPool.before[p].mae, belowAfter: v.belowPool.after[p].mae,
  }])));
};
console.log("5.2 weights fit on 2022-23:", JSON.stringify(fits), "chosen:", chosen);
show("5.2 implied team total", v52);
console.log("5.3 calibration fit on 2022-23:", JSON.stringify(calibration), v52.pass ? "(on top of 5.2)" : "(on the live projection)");
show("5.3 calibration, as tested (the line for everyone)", v53);
show("5.3 calibration, as live (the line from the floor up)", v53live);
