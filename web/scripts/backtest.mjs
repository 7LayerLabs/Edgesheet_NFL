/**
 * Backtest: replay the Elo projection on past seasons and grade it against real
 * finals and the nflverse closing line (schedules carry spread_line, which is the
 * closing number, so the test is easy and honest).
 *
 *   node scripts/backtest.mjs                 # seasons 2022..2025, regular season and playoffs
 *   SEASONS=2024,2025 node scripts/backtest.mjs
 *
 * Needs data/generated/schedule.json (npm run ingest). No network.
 *
 * What is tested (walk-forward: every pregame rating only knows games before it):
 *   Elo margin = (home Elo + 48 - away Elo) / 25, the same constants the live projection uses
 *   market margin = closing spread_line (positive = home favored)
 *   winner rate, mean absolute error, cover rate of the Elo side against the closing line
 *   (all games, then only games where Elo and the market differ by 2+ and 4+ points),
 *   win-probability calibration in 10-point buckets, favorite cover rate as the market baseline.
 * The EPA model total is not replayed: it needs a season of play-by-play per year (tens of MB each),
 * which is a later job. The unit-edge blend is not replayed for the same reason.
 *
 * Also fits the two Elo constants on a grid (home field 20..80, Elo per point 20..30) by MAE, and writes
 * the recommendation to data/weights.json. The live projection reads that file only with USE_FITTED_WEIGHTS=1.
 *
 * Writes data/backtest/results.json and data/weights.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeElo, ELO_HOME, ELO_PER_POINT } from "./lib/elo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

let schedule;
try {
  schedule = JSON.parse(await readFile(path.join(root, "data", "generated", "schedule.json"), "utf8"));
} catch {
  console.error("backtest: data/generated/schedule.json missing. Run npm run ingest first.");
  process.exit(1);
}
const games = schedule.filter((g) => g.played && g.hs != null && g.as != null);
log("played games in the file", games.length, "seasons", [...new Set(games.map((g) => g.season))].join(","));

/* ------------------------------------------------------------ helpers */
const r3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const rate = (a, b) => (b ? r3(a / b) : null);
function erf(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const SIGMA = 13.5;
const probFromMargin = (m) => 0.5 * (1 + erf(m / (SIGMA * Math.SQRT2)));

/** Grade one set of games with given constants. rows = { id, season, week, type, home, away, hs, as, neutral, spread, eloH, eloA }. */
function grade(rows, home = ELO_HOME, perPoint = ELO_PER_POINT) {
  const out = {
    games: 0, withLine: 0,
    winnerRight: 0, winnerGraded: 0, mae: 0, sqe: 0,
    marketWinnerRight: 0, marketMae: 0, marketSqe: 0,
    coverRight: 0, coverGraded: 0,
    lean2Right: 0, lean2Graded: 0, lean4Right: 0, lean4Graded: 0,
    favoriteCovered: 0, favoriteGraded: 0, pushes: 0,
    homeWins: 0, homeRate: null,
    calibration: Array.from({ length: 5 }, (_, i) => ({ bucket: `${50 + i * 10}-${59 + i * 10}`, games: 0, right: 0 })),
    bias: 0,
  };
  for (const g of rows) {
    const actual = g.hs - g.as;
    const elo = (g.eloH + (g.neutral ? 0 : home) - g.eloA) / perPoint;
    out.games++;
    if (actual > 0) out.homeWins++;
    if (actual !== 0) {
      out.winnerGraded++;
      if ((elo > 0) === (actual > 0)) out.winnerRight++;
    }
    out.mae += Math.abs(elo - actual);
    out.sqe += (elo - actual) ** 2;
    out.bias += elo - actual;
    const p = probFromMargin(Math.abs(elo));
    const b = Math.min(4, Math.max(0, Math.floor((p * 100 - 50) / 10)));
    if (actual !== 0) {
      out.calibration[b].games++;
      if ((elo > 0) === (actual > 0)) out.calibration[b].right++;
    }
    if (g.spread == null) continue;
    out.withLine++;
    const mkt = g.spread; // home margin by the market
    if (actual !== 0) {
      out.marketWinnerRight += (mkt > 0) === (actual > 0) ? 1 : 0;
    }
    out.marketMae += Math.abs(mkt - actual);
    out.marketSqe += (mkt - actual) ** 2;
    const vsLine = actual - mkt; // positive = home covered
    if (vsLine === 0) {
      out.pushes++;
      continue;
    }
    const favHome = mkt > 0;
    out.favoriteGraded++;
    if ((favHome && vsLine > 0) || (!favHome && vsLine < 0)) out.favoriteCovered++;
    const lean = elo - mkt; // positive = Elo likes home more than the market
    const covered = (lean > 0 && vsLine > 0) || (lean < 0 && vsLine < 0);
    if (lean !== 0) {
      out.coverGraded++;
      if (covered) out.coverRight++;
      if (Math.abs(lean) >= 2) { out.lean2Graded++; if (covered) out.lean2Right++; }
      if (Math.abs(lean) >= 4) { out.lean4Graded++; if (covered) out.lean4Right++; }
    }
  }
  const n = out.games;
  return {
    games: n,
    withLine: out.withLine,
    winnerRate: rate(out.winnerRight, out.winnerGraded),
    winnerRight: out.winnerRight,
    winnerGraded: out.winnerGraded,
    mae: r2(out.mae / Math.max(1, n)),
    rmse: r2(Math.sqrt(out.sqe / Math.max(1, n))),
    bias: r2(out.bias / Math.max(1, n)),
    marketWinnerRate: rate(out.marketWinnerRight, out.winnerGraded),
    marketMae: r2(out.marketMae / Math.max(1, out.withLine)),
    marketRmse: r2(Math.sqrt(out.marketSqe / Math.max(1, out.withLine))),
    coverRate: rate(out.coverRight, out.coverGraded),
    coverRight: out.coverRight,
    coverGraded: out.coverGraded,
    lean2CoverRate: rate(out.lean2Right, out.lean2Graded),
    lean2Graded: out.lean2Graded,
    lean4CoverRate: rate(out.lean4Right, out.lean4Graded),
    lean4Graded: out.lean4Graded,
    favoriteCoverRate: rate(out.favoriteCovered, out.favoriteGraded),
    favoriteGraded: out.favoriteGraded,
    pushes: out.pushes,
    homeWinRate: rate(out.homeWins, n),
    calibration: out.calibration.map((c) => ({ bucket: c.bucket, games: c.games, winRate: rate(c.right, c.games) })),
  };
}

/* -------------------------------------------------------------- run */
const elo = computeElo(schedule); // walk-forward over every season in the file (2019 on), so 2022 starts warm
const rowsFor = (season) =>
  games
    .filter((g) => g.season === season)
    .map((g) => {
      const pre = elo.pregame.get(g.id);
      return { id: g.id, season: g.season, week: g.week, type: g.type, home: g.home, away: g.away, hs: g.hs, as: g.as, neutral: g.neutral, spread: g.spread, eloH: pre?.home ?? 1500, eloA: pre?.away ?? 1500 };
    });

const perSeason = [];
const allRows = [];
for (const s of SEASONS) {
  const rows = rowsFor(s);
  if (!rows.length) {
    log(s, "no played games; skipped");
    continue;
  }
  allRows.push(...rows);
  const reg = grade(rows.filter((r) => r.type === "REG"));
  const all = grade(rows);
  perSeason.push({ season: s, regular: reg, all });
  log(s, `${rows.length} games: Elo winner ${Math.round((all.winnerRate ?? 0) * 100)}%, MAE ${all.mae} (market ${all.marketMae}), cover ${Math.round((all.coverRate ?? 0) * 100)}%, 4+ lean ${Math.round((all.lean4CoverRate ?? 0) * 100)}% of ${all.lean4Graded}`);
}
const overall = grade(allRows);
const overallReg = grade(allRows.filter((r) => r.type === "REG"));

// Grid fit of the two constants by MAE, regular season only, all tested seasons.
const grid = [];
for (let home = 20; home <= 80; home += 5) {
  for (let pp = 20; pp <= 30; pp += 1) {
    const g = grade(allRows.filter((r) => r.type === "REG"), home, pp);
    grid.push({ home, perPoint: pp, mae: g.mae, winnerRate: g.winnerRate, coverRate: g.coverRate, lean4CoverRate: g.lean4CoverRate });
  }
}
grid.sort((a, b) => a.mae - b.mae);
const best = grid[0];
log("best constants by MAE", best, "live", { home: ELO_HOME, perPoint: ELO_PER_POINT });

const results = {
  ranAt: new Date().toISOString(),
  seasons: perSeason.map((p) => p.season),
  live: { home: ELO_HOME, perPoint: ELO_PER_POINT, k: 20, regress: "1/3", sigma: SIGMA },
  overall,
  overallRegular: overallReg,
  perSeason,
  fit: { best, top: grid.slice(0, 8) },
  notes: [
    "Walk-forward: every pregame Elo only knows games before it. Seasons from 2019 warm the ratings before 2022 is graded.",
    "The market column is the nflverse closing spread_line, which is the closing number, not an average across books.",
    "Cover rate counts every game where Elo and the closing line differ at all, so it is a weak signal by design. The 2 and 4 point lean rows are the ones to read.",
    "The EPA model total and the unit-edge blend are not replayed here; both need a full season of play-by-play per year.",
    "Calibration buckets group games by the Elo win probability of the pick and show how often that pick won.",
  ],
};
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
await writeFile(path.join(root, "data", "weights.json"), JSON.stringify({ fittedAt: results.ranAt, source: "scripts/backtest.mjs", elo: { home: best.home, perPoint: best.perPoint, mae: best.mae }, projection: { eloWeight: 0.6, edgeDivisor: 40, note: "unit-edge blend not replayed; live defaults kept" } }, null, 2));
log("wrote", path.join(OUT, "results.json"));
