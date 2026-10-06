/**
 * Backtest the primetime-under angle as a bet: take the under on every regular-season game kicking off at 7 PM ET or
 * later (Thursday, Sunday, and Monday nights, plus Saturday nights late in the year), at the nflverse closing total.
 *
 *   node scripts/backtest-primetime.mjs
 *
 * The splits backtest (scripts/backtest-splits.mts) found teams score 1.1 points a game further under their implied
 * total in primetime than in other windows. A gap in the average is not a bet: this grades the under itself, pushes
 * out, against the 52.4% break-even at -110, by era and by season, with a 95% interval on the hit rate and the
 * return per $110 risked. Day games are graded the same way as the control. Reads data/cache/games.csv (nflverse
 * schedules, 1999 on). Writes data/backtest/primetime.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "data", "backtest");

const games = [];
await readCsv(path.join(root, "data", "cache", "games.csv"), (r) => {
  if (r.game_type !== "REG") return;
  const total = num(r.total_line);
  const hs = num(r.home_score);
  const as = num(r.away_score);
  if (total == null || hs == null || as == null) return;
  const prime = (r.gametime ?? "") >= "19:00";
  games.push({ season: Number(r.season), day: r.weekday, prime, total, points: hs + as });
});

const r3 = (x) => Math.round(x * 1000) / 1000;
function grade(set) {
  let under = 0, over = 0, push = 0, margin = 0;
  for (const g of set) {
    margin += g.points - g.total;
    if (g.points < g.total) under++;
    else if (g.points > g.total) over++;
    else push++;
  }
  const n = under + over;
  const p = n ? under / n : 0;
  const se = n ? Math.sqrt((p * (1 - p)) / n) : 0;
  // $110 risked to win $100 on each under.
  const roi = n ? (under * 100 - over * 110) / (n * 110) : 0;
  return { games: set.length, unders: under, overs: over, pushes: push, underRate: r3(p), ci95: [r3(p - 1.96 * se), r3(p + 1.96 * se)], roi: r3(roi), avgVsTotal: r3(margin / Math.max(1, set.length)) };
}

const eras = [[1999, 2009], [2010, 2018], [2019, 2025], [2023, 2025]];
const rows = [];
for (const [a, b] of eras) {
  const set = games.filter((g) => g.season >= a && g.season <= b);
  rows.push({ seasons: `${a}-${b}`, window: "primetime", ...grade(set.filter((g) => g.prime)) });
  rows.push({ seasons: `${a}-${b}`, window: "day", ...grade(set.filter((g) => !g.prime)) });
}
const bySeason = [];
for (let y = 2010; y <= 2026; y++) {
  const set = games.filter((g) => g.season === y && g.prime);
  if (set.length) bySeason.push({ season: y, ...grade(set) });
}
const byNight = ["Thursday", "Sunday", "Monday"].map((d) => ({ night: d, ...grade(games.filter((g) => g.prime && g.day === d && g.season >= 2010 && g.season <= 2025)) }));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "primetime.json"), JSON.stringify({ builtAt: new Date().toISOString(), breakEven: 0.524, eras: rows, bySeason, byNight }, null, 2));
console.log("Under on every game, closing total, pushes out (break-even 52.4% at -110):");
console.table(rows);
console.table(byNight);
console.table(bySeason);
