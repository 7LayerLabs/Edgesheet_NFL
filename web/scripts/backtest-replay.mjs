/**
 * The full live side model replayed walk-forward, and the tests built on it (audit 2026-10-12, items 2.1, 2.4, 3.1,
 * 3.2, 3.3, 3.4, 4.2). The decision rules were written and pushed before this ran (tasks/todo.md, "Decision rules
 * for Phases 2 to 5", commit 8bd3de7).
 *
 *   node scripts/backtest-total.mjs && node scripts/backtest-qb.mjs && node scripts/replay-build.mjs   # inputs
 *   node scripts/backtest-replay.mjs
 *
 * Inputs: data/generated/schedule.json (finals, closing lines), Elo (scripts/lib/elo.mjs, as live), the QB term
 * (data/backtest/qb-rows.json), the unit-edge term, non-QB availability, starting linemen out and per-game EPA
 * (data/cache/replay/replay-<season>.json), the model total (data/backtest/total-rows.json), and nflverse games.csv
 * for the margin table.
 *
 * "Out of sample" = each graded season (2022-25) uses weights fit only on the seasons before it, from 2019.
 *
 *   2.1  Each live term (QB, unit edges, non-QB availability) added to Elo alone, at its live constant and with its
 *        weight fit out of sample (grid, lowest margin miss). It stays only if it lowers the 2022-25 miss by 0.05+.
 *   2.4  The spread of final margins around the kept model (root mean squared miss) and win-chance calibration.
 *   3.1  Final margin minus line = b x (model minus line), b fit out of sample by least squares; a side is flagged
 *        only when b's 90% interval is above 0 and the shrunk gap is 2+ points. Same for totals (2.5+).
 *   3.2  The table of final margins by closing line (2015-2025) behind the cover chances: data/backtest/margins.json.
 *   3.3  Consensus systems with history (Elo, EPA model, EdgeSheet model) against the close; Elo out.
 *   3.4  Ridge-regressed, opponent-adjusted EPA per play (prior: half of last season) as a term in place of the
 *        unit edges; it replaces them only if it lowers the miss by 0.05+ more than they do. Penalty and prior were
 *        set once (200 plays, half of last season), not tuned.
 *   4.2  Starting linemen out (pre-registered): against the close, and the cost per missing starter.
 *
 * Writes data/backtest/replay.json and data/backtest/margins.json.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { computeElo, ELO_HOME, ELO_PER_POINT } from "./lib/elo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "data", "backtest");
const ALL = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const GRADED = [2022, 2023, 2024, 2025];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const readJson = async (f) => JSON.parse(await readFile(path.join(root, f), "utf8"));

/* ------------------------------------------------------------ rows */
const schedule = await readJson("data/generated/schedule.json");
const played = schedule.filter((g) => g.played && g.hs != null && g.as != null);
const elo = computeElo(played);
const qbRows = new Map((await readJson("data/backtest/qb-rows.json")).map((r) => [r.id, r]));
const totalRows = new Map((await readJson("data/backtest/total-rows.json")).map((r) => [r.id, r]));
const replay = new Map();
for (const y of ALL) for (const [id, g] of Object.entries((await readJson(`data/cache/replay/replay-${y}.json`)).games)) replay.set(id, g);

const LIVE = { qb: 0.75, edge: 1, avail: 1 };
const rows = [];
for (const g of played) {
  if (!ALL.includes(g.season) || g.spread == null) continue;
  const pre = elo.pregame.get(g.id);
  const rp = replay.get(g.id);
  if (!pre || !rp) continue;
  const q = qbRows.get(g.id);
  const av = rp.avail;
  rows.push({
    id: g.id,
    season: g.season,
    week: g.week,
    type: g.type,
    home: g.homeCode,
    away: g.awayCode,
    elo: (pre.home + (g.neutral ? 0 : ELO_HOME) - pre.away) / ELO_PER_POINT,
    qb: q ? q.h - q.a : 0,
    edge: rp.edges?.points ?? 0,
    avail: av.home && av.away ? av.home.off + av.home.def - (av.away.off + av.away.def) : 0,
    line: g.spread, // positive = home favored
    actual: g.hs - g.as,
    totalLine: g.totalLine,
    total: g.hs + g.as,
    modelTotal: totalRows.get(g.id)?.model,
    ol: rp.ol,
    epa: rp.epa,
    neutral: g.neutral,
  });
}
log("rows", rows.length, "by season", JSON.stringify(Object.fromEntries(ALL.map((y) => [y, rows.filter((r) => r.season === y).length]))));
const graded = rows.filter((r) => GRADED.includes(r.season));

/* ------------------------------------------------------------ grading helpers */
const mae = (set, f) => mean(set.map((r) => Math.abs(f(r) - r.actual)));
function ats(set, f) {
  let n = 0, win = 0;
  for (const r of set) {
    const m = f(r);
    const d = r.actual - r.line;
    if (d === 0 || m === r.line) continue;
    n++;
    if ((m > r.line) === (d > 0)) win++;
  }
  return { n, rate: n ? r3(win / n) : null };
}
/** A weight per graded season fit on the seasons before it: the grid value with the lowest margin miss. */
function oosWeights(term, grid, base = (r) => r.elo) {
  const w = {};
  for (const y of [...GRADED, 2026]) {
    const train = rows.filter((r) => r.season < y);
    w[y] = grid.reduce((best, x) => (mae(train, (r) => base(r) + x * r[term]) < mae(train, (r) => base(r) + best * r[term]) - 1e-9 ? x : best), grid[0]);
  }
  return w;
}

/* ------------------------------------------------------------ 2.1 terms */
const GRID = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const eloMae = mae(graded, (r) => r.elo);
const terms = {};
for (const t of ["qb", "edge", "avail"]) {
  const w = oosWeights(t, GRID);
  const liveMae = mae(graded, (r) => r.elo + LIVE[t] * r[t]);
  const oosMae = mae(graded, (r) => r.elo + w[r.season] * r[t]);
  const gainLive = eloMae - liveMae;
  const gainOos = eloMae - oosMae;
  // Rule 2.3: the QB weight is always the out-of-sample fit; other terms take the better of the two.
  const useOos = t === "qb" || gainOos >= gainLive;
  terms[t] = {
    live: LIVE[t],
    oosWeights: w,
    maeLive: r3(liveMae),
    maeOos: r3(oosMae),
    gainLive: r3(gainLive),
    gainOos: r3(gainOos),
    keep: Math.max(gainLive, gainOos) >= 0.05,
    weightNext: useOos ? w[2026] : LIVE[t],
    weightBy: useOos ? "out of sample" : "live constant",
    atsLive: ats(graded, (r) => r.elo + LIVE[t] * r[t]),
  };
}
const liveRecipe = (r) => r.elo + LIVE.qb * r.qb + LIVE.edge * r.edge + LIVE.avail * r.avail;
// The kept recipe in each graded season: Elo plus every kept term at the weight it would have had that season.
const weightIn = (t, y) => (terms[t].weightBy === "out of sample" ? terms[t].oosWeights[y] : LIVE[t]);
const kept = ["qb", "edge", "avail"].filter((t) => terms[t].keep);
const keptRecipe = (r) => r.elo + kept.reduce((a, t) => a + weightIn(t, r.season) * r[t], 0);
const full = {
  eloMae: r3(eloMae),
  marketMae: r3(mae(graded, (r) => r.line)),
  liveRecipeMae: r3(mae(graded, liveRecipe)),
  liveRecipeAts: ats(graded, liveRecipe),
  eloAts: ats(graded, (r) => r.elo),
  kept,
  keptRecipeMae: r3(mae(graded, keptRecipe)),
  keptRecipeAts: ats(graded, keptRecipe),
};
log("2.1 Elo", full.eloMae, "| live recipe", full.liveRecipeMae, "| kept", kept.join("+"), full.keptRecipeMae, "| market", full.marketMae);
console.table(Object.entries(terms).map(([t, x]) => ({ term: t, live: x.live, gainLive: x.gainLive, gainOos: x.gainOos, keep: x.keep, weightNext: x.weightNext, w: JSON.stringify(x.oosWeights) })));

/* ------------------------------------------------------------ 3.4 ridge EPA rating */
// Per season, before each week: offense and defense EPA per play, opponent-adjusted, ridge toward half of last season.
const LAMBDA = 200; // plays of prior weight
const PRIOR_KEEP = 0.5;
const seasonEnd = new Map(); // season -> { off: Map, def: Map }
function fitRidge(gamesData, prior) {
  // gamesData: [{ off, def, plays, epa }] one row per offense in a game; y = epa / plays.
  const teams = new Set(gamesData.flatMap((g) => [g.off, g.def]));
  const O = new Map([...teams].map((t) => [t, prior?.off.get(t) ?? 0]));
  const D = new Map([...teams].map((t) => [t, prior?.def.get(t) ?? 0]));
  const tot = gamesData.reduce((a, g) => a + g.plays, 0);
  if (!tot) return { off: O, def: D, mu: 0 };
  let mu = gamesData.reduce((a, g) => a + g.epa, 0) / tot;
  for (let it = 0; it < 30; it++) {
    for (const t of teams) {
      let num = LAMBDA * (prior?.off.get(t) ?? 0), den = LAMBDA;
      for (const g of gamesData) if (g.off === t) { num += g.epa - g.plays * (mu + D.get(g.def)); den += g.plays; }
      O.set(t, num / den);
    }
    for (const t of teams) {
      let num = LAMBDA * (prior?.def.get(t) ?? 0), den = LAMBDA;
      for (const g of gamesData) if (g.def === t) { num += g.epa - g.plays * (mu + O.get(g.off)); den += g.plays; }
      D.set(t, num / den);
    }
    mu = gamesData.reduce((a, g) => a + g.epa - g.plays * (O.get(g.off) + D.get(g.def)), 0) / tot;
  }
  return { off: O, def: D, mu };
}
{
  const byGid = new Map(rows.map((r) => [r.id, r]));
  for (const y of ALL) {
    const season = played.filter((g) => g.season === y).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    const lastEnd = seasonEnd.get(y - 1);
    const prior = lastEnd ? { off: new Map([...lastEnd.off].map(([t, v]) => [t, v * PRIOR_KEEP])), def: new Map([...lastEnd.def].map(([t, v]) => [t, v * PRIOR_KEEP])) } : undefined;
    const done = [];
    let fit = { off: prior?.off ?? new Map(), def: prior?.def ?? new Map(), mu: 0 };
    let week = null;
    const pace = new Map(); // team -> [plays]
    let waiting = []; // this week's games, added once the week is over
    for (const g of season) {
      if (g.week !== week) {
        for (const f of waiting) f();
        waiting = [];
        fit = done.length ? fitRidge(done, prior) : fit;
        week = g.week;
      }
      const r = byGid.get(g.id);
      if (r) {
        const ph = pace.get(r.home), pa = pace.get(r.away);
        const plays = ph?.length && pa?.length ? (mean(ph) + mean(pa)) / 2 : 62;
        const v = (m, t) => m.get(t) ?? 0;
        // Home offense against the away defense, minus the reverse, in EPA a play, times plays a side.
        r.ridge = ((v(fit.off, r.home) + v(fit.def, r.away)) - (v(fit.off, r.away) + v(fit.def, r.home))) * plays;
      }
      const rp = replay.get(g.id);
      if (rp?.epa) {
        const [a, b] = Object.keys(rp.epa);
        if (a && b) waiting.push(() => {
          done.push({ off: a, def: b, plays: rp.epa[a].plays, epa: rp.epa[a].epa }, { off: b, def: a, plays: rp.epa[b].plays, epa: rp.epa[b].epa });
          for (const t of [a, b]) (pace.get(t) ?? pace.set(t, []).get(t)).push(rp.epa[t].plays);
        });
      }
    }
    for (const f of waiting) f();
    seasonEnd.set(y, fitRidge(done, prior));
  }
}
for (const r of rows) r.ridge ??= 0;
{
  const w = oosWeights("ridge", [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]);
  const gain = eloMae - mae(graded, (r) => r.elo + w[r.season] * r.ridge);
  terms.ridge = { oosWeights: w, gainOos: r3(gain), maeOos: r3(eloMae - gain), beatsEdges: gain - Math.max(terms.edge.gainLive, terms.edge.gainOos) >= 0.05, weightNext: w[2026] };
  log("3.4 ridge gain", r3(gain), "vs unit edges", Math.max(terms.edge.gainLive, terms.edge.gainOos).toFixed(3), "| replaces edges:", terms.ridge.beatsEdges);
}

/* ------------------------------------------------------------ final model for 2.4 and 3.1 */
// The side model after 2.1 and 3.4: Elo plus the kept terms, with the ridge term in place of the unit edges if it won.
const sideTerms = terms.ridge.beatsEdges ? [...kept.filter((t) => t !== "edge"), "ridge"] : kept;
const weightFor = (t, y) => (t === "ridge" ? terms.ridge.oosWeights[y] : weightIn(t, y));
/** The side model with the weights a season would have used (training rows for that season use the same weights). */
const modelAt = (r, y) => r.elo + sideTerms.reduce((a, t) => a + weightFor(t, y) * r[t], 0);
const model = (r) => modelAt(r, r.season);

/* ------------------------------------------------------------ 2.4 spread and calibration */
const sd = Math.sqrt(mean(graded.map((r) => (r.actual - model(r)) ** 2)));
const sdLine = Math.sqrt(mean(graded.map((r) => (r.actual - r.line) ** 2)));
const erf = (x) => {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};
const phi = (m, s) => 0.5 * (1 + erf(m / (s * Math.SQRT2)));
function calibration(sigma) {
  const buckets = [50, 60, 70, 80, 90].map((lo) => ({ lo, n: 0, p: 0, won: 0 }));
  let brier = 0;
  for (const r of graded) {
    const m = model(r);
    const pHome = phi(m, sigma);
    const won = r.actual > 0 ? 1 : r.actual < 0 ? 0 : 0.5;
    brier += (pHome - won) ** 2;
    const pFav = Math.max(pHome, 1 - pHome);
    const favWon = pHome >= 0.5 ? won : 1 - won;
    const b = buckets.findLast((x) => pFav * 100 >= x.lo);
    b.n++; b.p += pFav; b.won += favWon;
  }
  return { sigma: r2(sigma), brier: r3(brier / graded.length), buckets: buckets.map((b) => ({ range: `${b.lo}-${b.lo + 10}%`, games: b.n, predicted: b.n ? r3(b.p / b.n) : null, won: b.n ? r3(b.won / b.n) : null })) };
}
const sdOut = { modelRmse: r2(sd), lineRmse: r2(sdLine), next: Math.round(sd * 10) / 10, live: calibration(13.5), fitted: calibration(Math.round(sd * 10) / 10) };
log("2.4 margin SD around the model", sdOut.modelRmse, "| around the line", sdOut.lineRmse);

/* ------------------------------------------------------------ 3.1 market plus deviation */
function deviation(set, xOf, yOf, minGap) {
  const fitB = (train, season) => {
    let sxy = 0, sxx = 0;
    for (const r of train) { const x = xOf(r, season), y = yOf(r); sxy += x * y; sxx += x * x; }
    const b = sxy / sxx;
    const res = train.map((r) => yOf(r) - b * xOf(r, season));
    const s2 = res.reduce((a, e) => a + e * e, 0) / (train.length - 1);
    const se = Math.sqrt(s2 / sxx);
    return { b: r3(b), lo90: r3(b - 1.645 * se), hi90: r3(b + 1.645 * se), n: train.length };
  };
  const bySeason = {};
  for (const y of [...GRADED, 2026]) bySeason[y] = fitB(set.filter((r) => r.season < y), y);
  const test = set.filter((r) => GRADED.includes(r.season));
  let flagged = 0, win = 0, n = 0, aeShrunk = 0, aeLine = 0;
  for (const r of test) {
    const f = bySeason[r.season];
    const d = f.b * xOf(r, r.season); // shrunk gap, positive = more than the line
    aeShrunk += Math.abs(yOf(r) - d);
    aeLine += Math.abs(yOf(r));
    if (!(f.lo90 > 0) || Math.abs(d) < minGap) continue;
    flagged++;
    const y = yOf(r);
    if (y === 0) continue;
    n++;
    if ((d > 0) === (y > 0)) win++;
  }
  return { bySeason, next: bySeason[2026], test: { games: test.length, maeShrunk: r3(aeShrunk / test.length), maeLine: r3(aeLine / test.length), flagged, graded: n, hit: n ? r3(win / n) : null } };
}
const sideDev = deviation(rows, (r, y) => modelAt(r, y) - r.line, (r) => r.actual - r.line, 2);
const totRows = rows.filter((r) => r.modelTotal != null && r.totalLine != null);
const totalDev = deviation(totRows, (r) => r.modelTotal - r.totalLine, (r) => r.total - r.totalLine, 2.5);
log("3.1 sides b next", JSON.stringify(sideDev.next), "| test", JSON.stringify(sideDev.test));
log("3.1 totals b next", JSON.stringify(totalDev.next), "| test", JSON.stringify(totalDev.test));

/* ------------------------------------------------------------ 3.3 consensus */
// EPA model as consensus.ts builds it: pace / 2 x ((home off - away off) + (away def allowed - home def allowed)) + 2 home.
{
  const cum = new Map(); // `${season}|${team}` -> { op, oe, dp, de, g }
  const bySeason = new Map();
  for (const g of played.filter((x) => ALL.includes(x.season)).sort((a, b) => a.kickoff.localeCompare(b.kickoff))) (bySeason.get(g.season) ?? bySeason.set(g.season, []).get(g.season)).push(g);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [, list] of bySeason) {
    let week = null;
    let pendingAdds = [];
    for (const g of list) {
      if (g.week !== week) { for (const f of pendingAdds) f(); pendingAdds = []; week = g.week; }
      const r = byId.get(g.id);
      const H = cum.get(`${g.season}|${g.homeCode}`), A = cum.get(`${g.season}|${g.awayCode}`);
      if (r && H?.g && A?.g) {
        const pace = (H.op / H.g + A.op / A.g) / 2;
        r.epaSys = (pace / 2) * ((H.oe / H.op - A.oe / A.op) + (A.de / A.dp - H.de / H.dp)) + (g.neutral ? 0 : 2);
      }
      const rp = replay.get(g.id);
      if (rp?.epa) pendingAdds.push(() => {
        const [a, b] = Object.keys(rp.epa);
        if (!a || !b) return;
        for (const [t, o] of [[a, b], [b, a]]) {
          const c = cum.get(`${g.season}|${t}`) ?? cum.set(`${g.season}|${t}`, { op: 0, oe: 0, dp: 0, de: 0, g: 0 }).get(`${g.season}|${t}`);
          c.op += rp.epa[t].plays; c.oe += rp.epa[t].epa; c.dp += rp.epa[o].plays; c.de += rp.epa[o].epa; c.g++;
        }
      });
    }
  }
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const consensusSet = graded.filter((r) => r.epaSys !== undefined);
const consensus = {
  games: consensusSet.length,
  elo: { mae: r3(mae(consensusSet, (r) => r.elo)), ats: ats(consensusSet, (r) => r.elo) },
  epaModel: { mae: r3(mae(consensusSet, (r) => r.epaSys)), ats: ats(consensusSet, (r) => r.epaSys) },
  edgeSheetModel: { mae: r3(mae(consensusSet, liveRecipe)), ats: ats(consensusSet, liveRecipe) },
  oldMedian: { systems: "Elo, EPA model, EdgeSheet model (FPI has no history)", mae: r3(mae(consensusSet, (r) => med([r.elo, r.epaSys, liveRecipe(r)]))), ats: ats(consensusSet, (r) => med([r.elo, r.epaSys, liveRecipe(r)])) },
  newMedian: { systems: "EPA model, EdgeSheet model (FPI has no history)", mae: r3(mae(consensusSet, (r) => med([r.epaSys, model(r)]))), ats: ats(consensusSet, (r) => med([r.epaSys, model(r)])) },
  market: { mae: r3(mae(consensusSet, (r) => r.line)) },
};
log("3.3 consensus", JSON.stringify(consensus.newMedian), "old", JSON.stringify(consensus.oldMedian));

/* ------------------------------------------------------------ 4.2 linemen out */
const teamGames = [];
for (const r of rows) {
  if (r.type !== "REG" || !r.ol || !GRADED.includes(r.season)) continue;
  for (const side of ["home", "away"]) {
    const o = r.ol[side];
    if (!o) continue;
    const resid = side === "home" ? r.actual - r.line : -(r.actual - r.line);
    teamGames.push({ id: r.id, side, out: o.out, resid });
  }
}
const ci = (xs) => {
  const m = mean(xs);
  const s = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  const se = s / Math.sqrt(xs.length);
  return { n: xs.length, mean: r2(m), lo95: r2(m - 1.96 * se), hi95: r2(m + 1.96 * se) };
};
const two = ci(teamGames.filter((t) => t.out >= 2).map((t) => t.resid));
const testA = { ...two, pass: two.mean <= -1 && two.hi95 < 0 && two.n >= 100, byCount: [0, 1, 2, 3].map((k) => ({ out: k === 3 ? "3+" : k, ...ci(teamGames.filter((t) => (k === 3 ? t.out >= 3 : t.out === k)).map((t) => t.resid)) })) };
// B: cost per missing starter on the final margin, beyond Elo (OLS with an intercept).
const bRows = rows.filter((r) => r.type === "REG" && GRADED.includes(r.season) && r.ol?.home && r.ol?.away).map((r) => ({ x: r.ol.home.out - r.ol.away.out, y: r.actual - r.elo }));
const testB = (() => {
  const mx = mean(bRows.map((r) => r.x)), my = mean(bRows.map((r) => r.y));
  let sxy = 0, sxx = 0;
  for (const r of bRows) { sxy += (r.x - mx) * (r.y - my); sxx += (r.x - mx) ** 2; }
  const slope = sxy / sxx;
  const res = bRows.map((r) => r.y - my - slope * (r.x - mx));
  const se = Math.sqrt(res.reduce((a, e) => a + e * e, 0) / (bRows.length - 2) / sxx);
  const perStarter = -slope; // points a missing starter costs his team
  return { games: bRows.length, perStarter: r2(perStarter), lo95: r2(perStarter - 1.96 * se), hi95: r2(perStarter + 1.96 * se), replaces04: perStarter - 1.96 * se > 0 || perStarter + 1.96 * se < 0 };
})();
log("4.2 A", JSON.stringify({ n: testA.n, mean: testA.mean, lo95: testA.lo95, hi95: testA.hi95, pass: testA.pass }), "| B", JSON.stringify(testB));

/* ------------------------------------------------------------ 3.2 margin table */
// For each closing favorite line 0 to 20 by 0.5: the share of games the favorite won by each margin, from games closing
// within a point of it (wider when thin), 2015-2025 regular season and playoffs, blended 80/20 with a normal curve so
// thin tails are not zero while the key numbers keep their real weight.
const hist = [];
await readCsv(path.join(root, "data", "cache", "games.csv"), (g) => {
  const y = Number(g.season);
  if (y < 2015 || y > 2025 || g.home_score === "" || g.spread_line === "") return;
  const L = Number(g.spread_line);
  const M = Number(g.home_score) - Number(g.away_score);
  hist.push(L >= 0 ? { f: L, m: M } : { f: -L, m: -M });
});
const MIN_M = -45, MAX_M = 70;
const lines = [];
for (let f2 = 0; f2 <= 40; f2++) {
  const f = f2 / 2;
  let bw = 1, near = [];
  while (bw <= 4) { near = hist.filter((h) => Math.abs(h.f - f) <= bw); if (near.length >= 200) break; bw += 0.5; }
  const counts = new Array(MAX_M - MIN_M + 1).fill(0);
  for (const h of near) {
    // Keep the favorite's margin as played, re-centered by the line difference rounded to whole points.
    const m = Math.round(h.m + (f - h.f));
    if (m >= MIN_M && m <= MAX_M) counts[m - MIN_M]++;
  }
  const tot = counts.reduce((a, b) => a + b, 0);
  const pmf = counts.map((c, i) => {
    const m = i + MIN_M;
    const normal = phi(m + 0.5 - f, sdLine) - phi(m - 0.5 - f, sdLine);
    return 0.8 * (c / tot) + 0.2 * normal;
  });
  const s = pmf.reduce((a, b) => a + b, 0);
  lines.push({ line: f, games: near.length, window: bw, pmf: pmf.map((p) => Math.round((p / s) * 1e5) / 1e5) });
}
const margins = { builtAt: new Date().toISOString(), seasons: "2015-2025", minMargin: MIN_M, maxMargin: MAX_M, sd: r2(sdLine), lines };
// Check: cover chance of the closing favorite at its own line against what happened, 2022-25.
const pmfAt = (f) => lines[Math.max(0, Math.min(40, Math.round(Math.abs(f) * 2)))].pmf;
let pSum = 0, covered = 0, nCheck = 0;
for (const r of graded) {
  if (r.line === 0) continue;
  const F = Math.abs(r.line);
  const favMargin = r.line > 0 ? r.actual : -r.actual;
  if (favMargin === F) continue;
  const pmf = pmfAt(F);
  let pCover = 0, pPush = 0;
  pmf.forEach((p, i) => { const m = i + MIN_M; if (m > F) pCover += p; else if (m === F) pPush += p; });
  pSum += pCover / (1 - pPush);
  covered += favMargin > F ? 1 : 0;
  nCheck++;
}
margins.check = { games: nCheck, predictedFavCover: r3(pSum / nCheck), actualFavCover: r3(covered / nCheck) };
log("3.2 margin table check", JSON.stringify(margins.check));

/* ------------------------------------------------------------ write */
const out = {
  builtAt: new Date().toISOString(),
  graded: GRADED,
  games: graded.length,
  terms,
  full,
  sideModel: { terms: sideTerms, weightsNext: Object.fromEntries(sideTerms.map((t) => [t, t === "ridge" ? terms.ridge.weightNext : terms[t].weightNext])), mae: r3(mae(graded, model)), ats: ats(graded, model) },
  sd: sdOut,
  sideDeviation: sideDev,
  totalDeviation: totalDev,
  consensus,
  linemen: { testA, testB },
};
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "replay.json"), JSON.stringify(out, null, 2));
await writeFile(path.join(OUT, "margins.json"), JSON.stringify(margins));
log("written");
