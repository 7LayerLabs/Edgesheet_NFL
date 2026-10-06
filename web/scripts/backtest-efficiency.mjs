/**
 * Do efficiency stats predict? Two tests on 2022 to 2025 regular seasons, play-by-play through scripts/lib/leaders-agg.mjs
 * (the same definitions as the Leaders page) and DraftKings points from the nflverse weekly files.
 *
 *   node scripts/backtest-efficiency.mjs
 *
 * 1. Stickiness, split halves: weeks 1-9 against weeks 10-18 of the same season. For each stat in the first half,
 *    the correlation with the second half's yards per play, EPA per play, and DK points a game. A stat that predicts
 *    the second half better than yards per carry (or per target, per attempt) did is a better read on the player.
 *    Backs 40+ carries in each half, receivers 30+ targets, quarterbacks 150+ dropbacks.
 * 2. Does it add to the DraftKings projection? Walk-forward from week 4: the live base (DK points a game blended with
 *    last season at 3 games, half weight on expected fantasy points; the matchup quarter is left out of both arms)
 *    against base x (1 + k x z), z = his efficiency so far against his position's average, shrunk toward zero with a
 *    prior of 60 carries / 40 targets / 150 dropbacks. k fit on 2022-2023, tested on 2024-2025.
 * Writes data/backtest/efficiency.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";
import { aggregatePbp, sumWeeks } from "./lib/leaders-agg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = [2022, 2023, 2024, 2025];
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) + ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) + n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) - n("fumbles_lost_total") + n("special_teams_tds") * 6;
};
async function weekly(y) {
  const m = new Map();
  await readCsv(path.join(CACHE, `stats_player_week_${y}.csv`), (r) => {
    if (r.season_type !== "REG") return;
    const e = m.get(r.player_id) ?? m.set(r.player_id, { pos: r.position, wk: new Map() }).get(r.player_id);
    e.wk.set(Number(r.week), dk(r));
  });
  return m;
}
async function xfp(y) {
  const m = new Map();
  await readCsv(path.join(CACHE, `ep_weekly_${y}.csv`), (r) => {
    const x = num(r.total_fantasy_points_exp);
    if (x == null) return;
    (m.get(r.player_id) ?? m.set(r.player_id, new Map()).get(r.player_id)).set(Number(r.week), { x, fp: num(r.total_fantasy_points) ?? 0 });
  });
  return m;
}
const corr = (xs, ys) => {
  const n = xs.length;
  if (n < 10) return { n, r: null };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy);
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { n, r: r3(r), ci: [r3(Math.tanh(z - 1.96 * se)), r3(Math.tanh(z + 1.96 * se))] };
};

// ---------------------------------------------------------------- 1. split halves
const pairs = { rb: [], rec: [], qb: [] };
// ---------------------------------------------------------------- 2. walk-forward
const walk = { rb: [], rec: [], qb: [] };

let prevWeekly = await weekly(2021);
let prevX = await xfp(2021);
for (const y of SEASONS) {
  console.log("season", y);
  const [{ players }, wkly, xf] = await Promise.all([aggregatePbp(path.join(CACHE, `play_by_play_${y}.csv.gz`)), weekly(y), xfp(y)]);
  // League means per stat so far, by week, for z-scores (computed from everyone with any volume before the week).
  for (const [gsis, weeks] of players) {
    const first = sumWeeks(weeks, 10);
    const second = sumWeeks(new Map([...weeks].filter(([w]) => w >= 10)));
    const dkWeeks = wkly.get(gsis)?.wk;
    const dkGame = (lo, hi) => {
      if (!dkWeeks) return undefined;
      const v = [...dkWeeks].filter(([w]) => w >= lo && w <= hi).map(([, p]) => p);
      return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
    };
    const d1 = dkGame(1, 9), d2 = dkGame(10, 18);
    const a1 = first.rush, a2 = second.rush;
    if (a1?.att >= 40 && a2?.att >= 40 && wkly.get(gsis)?.pos === "RB") pairs.rb.push({ succ: a1.succ / a1.att, epa: a1.epa / a1.att, ypc: a1.yds / a1.att, expl: a1.expl / a1.att, stuff: a1.stuff / a1.att, ypc2: a2.yds / a2.att, epa2: a2.epa / a2.att, dk1: d1, dk2: d2 });
    const t1 = first.rec, t2 = second.rec;
    const pos = wkly.get(gsis)?.pos;
    if (t1?.tgt >= 30 && t2?.tgt >= 30 && (pos === "WR" || pos === "TE")) pairs.rec.push({ epa: t1.epa / t1.tgt, succ: t1.succ / t1.tgt, ypt: t1.yds / t1.tgt, catch: t1.rec / t1.tgt, adot: t1.airN ? t1.air / t1.airN : 0, ypt2: t2.yds / t2.tgt, epa2: t2.epa / t2.tgt, dk1: d1, dk2: d2 });
    const p1 = first.pass, p2 = second.pass;
    if (p1?.db >= 150 && p2?.db >= 150) pairs.qb.push({ epa: p1.epa / p1.db, succ: p1.succ / p1.db, cpoe: p1.cpoeN ? p1.cpoe / p1.cpoeN : 0, ypa: (p1.yds ?? 0) / Math.max(1, p1.att ?? 0), sack: (p1.sk ?? 0) / p1.db, epa2: p2.epa / p2.db, ypa2: (p2.yds ?? 0) / Math.max(1, p2.att ?? 0), dk1: d1, dk2: d2 });
  }

  // Walk-forward weekly: base projection and efficiency so far.
  for (let w = 4; w <= 18; w++) {
    const means = { rb: [], rec: [], qb: [] };
    const so = new Map();
    for (const [gsis, weeks] of players) {
      const s = sumWeeks(weeks, w);
      so.set(gsis, s);
      if (s.rush?.att >= 20) means.rb.push(s.rush.succ / s.rush.att);
      if (s.rec?.tgt >= 15) means.rec.push(s.rec.epa / s.rec.tgt);
      if (s.pass?.db >= 60) means.qb.push(s.pass.epa / s.pass.db);
    }
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const sd = (xs) => Math.sqrt(avg(xs.map((x) => (x - avg(xs)) ** 2))) || 1;
    const M = { rb: [avg(means.rb), sd(means.rb)], rec: [avg(means.rec), sd(means.rec)], qb: [avg(means.qb), sd(means.qb)] };
    let dkS = 0, fpS = 0;
    for (const [id, e] of wkly) for (const [wk, p] of e.wk) if (wk < w && xf.get(id)?.get(wk)) { dkS += p; fpS += xf.get(id).get(wk).fp; }
    const scale = fpS ? dkS / fpS : 1;
    for (const [gsis, e] of wkly) {
      const actual = e.wk.get(w);
      if (actual === undefined) continue;
      const before = [...e.wk].filter(([wk]) => wk < w).map(([, p]) => p);
      if (before.length < 2) continue;
      const now = before.reduce((a, b) => a + b, 0) / before.length;
      if (now < 8) continue;
      const pv = prevWeekly.get(gsis);
      const last = pv && pv.wk.size >= 4 ? [...pv.wk.values()].reduce((a, b) => a + b, 0) / pv.wk.size : undefined;
      const dkBase = last === undefined ? now : (before.length * now + 3 * last) / (before.length + 3);
      const xs = [...(xf.get(gsis) ?? new Map())].filter(([wk]) => wk < w).map(([, v]) => v.x);
      const px = prevX.get(gsis);
      const xl = px && px.size >= 4 ? [...px.values()].reduce((a, b) => a + b.x, 0) / px.size : undefined;
      const xNow = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
      const xBase = xNow === undefined ? undefined : (xl === undefined ? xNow : (xs.length * xNow + 3 * xl) / (xs.length + 3)) * scale;
      const base = xBase === undefined ? dkBase : 0.5 * dkBase + 0.5 * xBase;
      const s = so.get(gsis) ?? {};
      let z;
      let kind;
      if (e.pos === "RB" && s.rush?.att) { kind = "rb"; const n = s.rush.att; z = ((s.rush.succ / n - M.rb[0]) / M.rb[1]) * (n / (n + 60)); }
      else if ((e.pos === "WR" || e.pos === "TE") && s.rec?.tgt) { kind = "rec"; const n = s.rec.tgt; z = ((s.rec.epa / n - M.rec[0]) / M.rec[1]) * (n / (n + 40)); }
      else if (e.pos === "QB" && s.pass?.db) { kind = "qb"; const n = s.pass.db; z = ((s.pass.epa / n - M.qb[0]) / M.qb[1]) * (n / (n + 150)); }
      if (kind) walk[kind].push({ season: y, base, z, actual });
    }
  }
  prevWeekly = wkly;
  prevX = xf;
}

// ---------------------------------------------------------------- report
const half = (rows, stats, targets) => {
  const out = {};
  for (const t of targets) {
    out[t] = {};
    for (const s of stats) {
      const ok = rows.filter((r) => Number.isFinite(r[s]) && Number.isFinite(r[t]));
      out[t][s] = corr(ok.map((r) => r[s]), ok.map((r) => r[t]));
    }
  }
  return out;
};
const stick = {
  rb: half(pairs.rb, ["succ", "epa", "ypc", "expl", "stuff", "dk1"], ["ypc2", "epa2", "dk2"]),
  rec: half(pairs.rec, ["epa", "succ", "ypt", "catch", "adot", "dk1"], ["ypt2", "epa2", "dk2"]),
  qb: half(pairs.qb, ["epa", "succ", "cpoe", "ypa", "sack", "dk1"], ["epa2", "ypa2", "dk2"]),
};
const KS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15];
const fit = {};
for (const kind of ["rb", "rec", "qb"]) {
  const train = walk[kind].filter((r) => r.season <= 2023), test = walk[kind].filter((r) => r.season >= 2024);
  const mae = (rows, k) => rows.reduce((a, r) => a + Math.abs(r.base * (1 + k * r.z) - r.actual), 0) / rows.length;
  const best = KS.reduce((b, k) => (mae(train, k) < mae(train, b) ? k : b), 0);
  fit[kind] = { train: train.length, test: test.length, bestK: best, testMaeBase: r3(mae(test, 0)), testMaeWithEff: r3(mae(test, best)), grid: KS.map((k) => ({ k, train: r3(mae(train, k)), test: r3(mae(test, k)) })) };
}
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "efficiency.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, pairs: { rb: pairs.rb.length, rec: pairs.rec.length, qb: pairs.qb.length }, stickiness: stick, projection: fit }, null, 2));
const show = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.r]));
for (const kind of ["rb", "rec", "qb"]) {
  console.log(`\n${kind.toUpperCase()} split halves (${pairs[kind].length} player-seasons), first-half stat vs second half:`);
  console.table(Object.fromEntries(Object.entries(stick[kind]).map(([t, v]) => [t, show(v)])));
}
console.log("\nDK projection, efficiency multiplier fit on 2022-23, tested 2024-25:");
console.table(Object.fromEntries(Object.entries(fit).map(([k, v]) => [k, { bestK: v.bestK, test: v.test, maeBase: v.testMaeBase, maeWithEff: v.testMaeWithEff }])));
