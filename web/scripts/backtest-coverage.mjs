/**
 * Does coverage carry over from one season to the next? Before the app treats a man/zone split as anything but
 * context, this checks whether it repeats.
 *
 *   node scripts/backtest-coverage.mjs                 # every season pair with coverage charting (2023-2024, 2024-2025)
 *
 * Uses the same per-season aggregation as scripts/ingest-coverage.mjs (scripts/lib/coverage-agg.mjs; FTN charting
 * via nflverse pbp_participation joined to play-by-play, regular season). Seasons without man/zone charting are skipped.
 *
 *   receivers   man-minus-zone split in yards per target and in EPA per target, 20+ targets on each side in both seasons
 *   defenses    man rate; EPA per dropback allowed against man; the man-minus-zone gap in EPA allowed
 *   offenses    the man-minus-zone gap in EPA per dropback
 * For each: pairs, the season-to-season correlation, its 95% interval (Fisher z), and a verdict: "carries over" only
 * when the interval clears zero. Writes data/backtest/coverage.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSeason, TWO_HIGH } from "./lib/coverage-agg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const MIN = 20;
const SEASONS = (process.env.SEASONS ?? "2023,2024,2025").split(",").map(Number);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

const seasons = {};
for (const y of SEASONS) {
  if (!existsSync(path.join(CACHE, `pbp_participation_${y}.csv`))) {
    console.log("no participation file for", y, "(run SEASON=" + y + " node scripts/ingest-coverage.mjs to download it)");
    continue;
  }
  const a = await aggregateSeason(y, CACHE);
  const charted = Object.values(a?.teams ?? {}).reduce((s, t) => s + t.def.charted, 0);
  if (!a || charted < 1000) {
    console.log(y, "has no man/zone charting; skipped");
    continue;
  }
  seasons[y] = a;
  console.log(y, "charted pass plays", charted);
}

function corr(pairs) {
  const n = pairs.length;
  if (n < 5) return { pairs: n, r: null, ci: null, verdict: "not enough pairs" };
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(n - 3);
  const ci = [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
  const verdict = ci[0] > 0 ? "carries over" : ci[1] < 0 ? "reverses" : "does not carry over";
  return { pairs: n, r: r3(r), ci: ci.map(r3), verdict };
}

const years = Object.keys(seasons).map(Number).sort();
const pairsOf = (fn) => {
  const out = [];
  for (let i = 0; i + 1 < years.length; i++) {
    if (years[i + 1] !== years[i] + 1) continue;
    out.push(...fn(seasons[years[i]], seasons[years[i + 1]]));
  }
  return out;
};

const recSplit = (rc, key, [x, y] = ["man", "zone"]) => {
  if (!rc || rc[x].tgt < MIN || rc[y].tgt < MIN) return undefined;
  return key === "ypt" ? rc[x].yards / rc[x].tgt - rc[y].yards / rc[y].tgt : rc[x].epa / rc[x].tgt - rc[y].epa / rc[y].tgt;
};
const receiverPairs = (key, sides) =>
  pairsOf((a, b) =>
    Object.entries(a.receivers)
      .map(([id, rc]) => [recSplit(rc, key, sides), recSplit(b.receivers[id], key, sides)])
      .filter(([x, y]) => x !== undefined && y !== undefined),
  );
const teamPairs = (fn) =>
  pairsOf((a, b) =>
    Object.keys(a.teams)
      .filter((t) => b.teams[t])
      .map((t) => [fn(a.teams[t]), fn(b.teams[t])])
      .filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y)),
  );

const per = (s) => (s.n ? s.epa / s.n : null);
// Safety shells, which charting reads more consistently than man or zone underneath (Cover 1 and Cover 3 are both one
// deep safety; which of the two a play is depends on reading the underneath defenders, and that call drifts by season).
const twoHigh = (t) => (t.def.charted ? TWO_HIGH.reduce((a, k) => a + (t.def.shells[k] ?? 0), 0) / t.def.charted : null);
const tests = {
  defenseTwoHighRate: { what: "a defense's share of pass plays with two deep safeties (Cover 2, 4, 6, 2-man)", ...corr(teamPairs(twoHigh)) },
  receiverTwoHighMinusOneHighYards: { what: "a receiver's yards per target against two-deep shells minus one-deep shells", ...corr(receiverPairs("ypt", ["high2", "high1"])) },
  receiverTwoHighMinusOneHighEpa: { what: "a receiver's EPA per target against two-deep shells minus one-deep shells", ...corr(receiverPairs("epa", ["high2", "high1"])) },
  offenseTwoHighMinusOneHighEpa: { what: "an offense's EPA per dropback against two-deep shells minus one-deep shells", ...corr(teamPairs((t) => (per(t.off.vsHigh2) != null && per(t.off.vsHigh1) != null ? per(t.off.vsHigh2) - per(t.off.vsHigh1) : null))) },
  receiverManMinusZoneYards: { what: "a receiver's yards per target against man minus against zone", ...corr(receiverPairs("ypt")) },
  receiverManMinusZoneEpa: { what: "a receiver's EPA per target against man minus against zone", ...corr(receiverPairs("epa")) },
  defenseManRate: { what: "a defense's share of pass plays in man coverage", ...corr(teamPairs((t) => (t.def.charted ? t.def.man / t.def.charted : null))) },
  defenseEpaVsMan: { what: "a defense's EPA per dropback allowed against man", ...corr(teamPairs((t) => per(t.def.vsMan))) },
  defenseManMinusZoneEpa: { what: "a defense's EPA allowed in man minus in zone", ...corr(teamPairs((t) => (per(t.def.vsMan) != null && per(t.def.vsZone) != null ? per(t.def.vsMan) - per(t.def.vsZone) : null))) },
  offenseManMinusZoneEpa: { what: "an offense's EPA per dropback against man minus against zone", ...corr(teamPairs((t) => (per(t.off.vsMan) != null && per(t.off.vsZone) != null ? per(t.off.vsMan) - per(t.off.vsZone) : null))) },
};

// League-wide drift by season, so readers see why raw man rates should not be compared across seasons.
const drift = Object.fromEntries(years.map((y) => {
  const ts = Object.values(seasons[y].teams);
  const charted = ts.reduce((a, t) => a + t.def.charted, 0);
  return [y, { manRate: r3(ts.reduce((a, t) => a + t.def.man, 0) / charted), twoHighRate: r3(ts.reduce((a, t) => a + TWO_HIGH.reduce((s, k) => s + (t.def.shells[k] ?? 0), 0), 0) / charted) }];
}));
const note = years.length < 2 ? `Only ${years.join(", ") || "no season"} has man/zone charting, so the carry-over test cannot run yet.` : undefined;
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "coverage.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: years, minTargets: MIN, note, leagueDrift: drift, tests }, null, 2));
if (note) console.log(note);
console.log("League-wide by season:", JSON.stringify(drift));
console.table(Object.entries(tests).map(([k, t]) => ({ test: k, pairs: t.pairs, r: t.r, ci: t.ci ? `${t.ci[0]} to ${t.ci[1]}` : "", verdict: t.verdict })));
