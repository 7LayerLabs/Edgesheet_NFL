#!/usr/bin/env node
/**
 * Checks on the fourth-down model (scripts/fourth-fit.mjs, src/lib/fourth-core.mjs) that a reader can trust.
 *
 *   node scripts/backtest-fourth.mjs
 *
 * Scores every regular-season fourth down 2018 to 2025 (runs, passes, field goals, punts; no penalties, no overtime,
 * no garbage time where every option is under 2% or over 98%) with the model the app uses. The win-probability part
 * of that model was fit on these same seasons, so these are consistency checks, not an out-of-sample test; the
 * out-of-sample numbers (2025 held out) are in the model file and repeated here.
 *
 *   1. When the model says go by 3+ points, how often teams went, by season (the league has been going more).
 *   2. Calibration of the conversion and field goal chances on the held-out 2025 season (from the model file).
 *   3. Teams that gave up more win probability on fourth downs than their opponent in the same game: did they win
 *      less than the pregame line expected? (Pregame expectation: nflfastR's vegas_wp on the game's first play.)
 *      Costly calls and losing can share a cause (a team that falls behind faces more hard fourth downs), so this is
 *      an association, not proof.
 * Writes data/backtest/fourth.json with plain verdict lines.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamCsv } from "./lib/csv-stream.mjs";
import { callOf, options, stateOf } from "../src/lib/fourth-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const t0 = Date.now();
const log = (...a) => console.log(`[backtest-fourth ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const model = JSON.parse(await readFile(path.join(root, "data", "generated", "fourth-model.json"), "utf8"));
const KEEP = ["season_type", "game_id", "posteam", "home_team", "away_team", "qtr", "game_seconds_remaining", "yardline_100", "down", "ydstogo", "score_differential", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "spread_line", "play_type", "penalty", "vegas_wp", "result", "play_id"];
const r3 = (x) => Math.round(x * 1000) / 1000;

const bySeason = [];
const gameStats = []; // per game: { home, away, costHome, costAway, homeWon, pregameHome }
for (const y of SEASONS) {
  const games = new Map();
  let decisions = 0, went = 0, saidGo3 = 0, wentWhenSaidGo3 = 0, saidKickOrPunt3 = 0, wentWhenSaidNo3 = 0, agreed = 0;
  await streamCsv(
    path.join(CACHE, `play_by_play_${y}.csv.gz`),
    (r) => {
      if (r.season_type !== "REG") return;
      const g = games.get(r.game_id) ?? games.set(r.game_id, { home: r.home_team, away: r.away_team, costHome: 0, costAway: 0, result: Number(r.result), pregameHome: undefined }).get(r.game_id);
      if (g.pregameHome === undefined && r.vegas_wp !== "" && r.vegas_wp !== "NA" && r.posteam) {
        const v = Number(r.vegas_wp);
        if (Number.isFinite(v)) g.pregameHome = r.posteam === r.home_team ? v : 1 - v;
      }
      if (r.down !== "4" || r.penalty === "1" || Number(r.qtr) > 4) return;
      const call = callOf(r.play_type);
      const st = stateOf(r);
      if (!call || !st || st.gsr <= 0) return;
      const o = options(model, st);
      const wps = [o.go.wp, o.kick?.wp, o.punt?.wp].filter((x) => x !== undefined);
      if (Math.max(...wps) < 0.02 || Math.min(...wps) > 0.98) return;
      const chosen = o[call];
      if (!chosen) return;
      decisions++;
      if (call === "go") went++;
      const cost = (o[o.best].wp - chosen.wp) * 100;
      if (call === o.best || o.tossUp) agreed++;
      if (o.best === "go" && o.margin >= 3) {
        saidGo3++;
        if (call === "go") wentWhenSaidGo3++;
      }
      if (o.best !== "go" && o.margin >= 3) {
        saidKickOrPunt3++;
        if (call === "go") wentWhenSaidNo3++;
      }
      if (r.posteam === g.home) g.costHome += cost;
      else g.costAway += cost;
    },
    KEEP,
  );
  bySeason.push({ season: y, decisions, wentForIt: r3(went / decisions), modelSaidGoBy3: saidGo3, wentWhenModelSaidGoBy3: r3(wentWhenSaidGo3 / Math.max(1, saidGo3)), modelSaidKickOrPuntBy3: saidKickOrPunt3, wentAnywayWhenModelSaidKickOrPuntBy3: r3(wentWhenSaidNo3 / Math.max(1, saidKickOrPunt3)), agreedWithModel: r3(agreed / decisions) });
  for (const g of games.values()) if (Number.isFinite(g.result) && g.pregameHome !== undefined) gameStats.push(g);
  log("season", y, "decisions", decisions);
}

// 3. Higher-cost team against its pregame expectation, by how much more it gave up.
const BANDS = [[1, 3], [3, 6], [6, 99]];
const costSplit = BANDS.map(([lo, hi]) => {
  let n = 0, won = 0, expected = 0;
  for (const g of gameStats) {
    const diff = g.costHome - g.costAway;
    if (Math.abs(diff) < lo || Math.abs(diff) >= hi) continue;
    const costlyIsHome = diff > 0;
    const homeWin = g.result > 0 ? 1 : g.result < 0 ? 0 : 0.5;
    won += costlyIsHome ? homeWin : 1 - homeWin;
    expected += costlyIsHome ? g.pregameHome : 1 - g.pregameHome;
    n++;
  }
  return { gaveUpMoreBy: hi === 99 ? `${lo}+ points` : `${lo} to ${hi} points`, games: n, won: r3(won / Math.max(1, n)), pregameExpected: r3(expected / Math.max(1, n)), shortfall: r3((won - expected) / Math.max(1, n)) };
});

const first = bySeason[0];
const last = bySeason[bySeason.length - 1];
const verdicts = [
  `Teams went for it on ${Math.round(first.wentWhenModelSaidGoBy3 * 100)}% of fourth downs the model called a clear go (3+ points) in ${first.season} and ${Math.round(last.wentWhenModelSaidGoBy3 * 100)}% in ${last.season}.`,
  `The win-probability model was off from nflfastR by ${(model.wp.holdout.maeVsNflfastr * 100).toFixed(1)} points on average in the held-out ${model.wp.holdout.season} season, and its buckets line up with how often teams actually won (table in the model file).`,
  ...costSplit.filter((c) => c.games >= 30).map((c) => `Teams that gave up ${c.gaveUpMoreBy} more win probability on fourth downs than their opponent won ${Math.round(c.won * 100)}% of ${c.games} games against ${Math.round(c.pregameExpected * 100)}% expected from the pregame line. Association, not proof: a team that falls behind also faces more hard fourth downs.`),
];
const out = { builtAt: new Date().toISOString(), seasons: SEASONS, note: "In-sample for the win-probability fit; see holdout in the model file.", bySeason, costSplit, conversionHoldout: model.go.byTogo, fieldGoalHoldout: model.fg.byDistance, verdicts };
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "fourth.json"), JSON.stringify(out, null, 2));
console.table(bySeason);
console.table(costSplit);
for (const v of verdicts) console.log("-", v);
