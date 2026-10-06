/**
 * Backtest referee totals: does a referee's past over/under record predict his next season's games?
 *
 *   node scripts/backtest-referees.mjs
 *
 * nflverse schedules (data/cache/games.csv) name the referee of every game since 1999, with the closing total. For each
 * season from 2010 on, every referee with 40+ graded games before that season gets his career over rate so far; his
 * games that season are graded against the closing total (pushes out).
 *   carry-over   correlation between the past over rate and that season's over rate, referee-seasons with 10+ games
 *   bet          take the over with referees whose past over rate is 55%+ and the under at 45% or lower, at -110
 * A crew lean is shown only if the bet clears the 52.4% break-even with an interval that does. Writes
 * data/backtest/referees.json.
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
  if (r.game_type !== "REG" || !r.referee) return;
  const total = num(r.total_line), hs = num(r.home_score), as = num(r.away_score);
  if (total == null || hs == null || as == null) return;
  const pts = hs + as;
  if (pts === total) return;
  games.push({ season: Number(r.season), ref: r.referee, over: pts > total ? 1 : 0 });
});

const r3 = (x) => Math.round(x * 1000) / 1000;
const pairs = [];
let betW = 0, betL = 0;
const bySeason = [];
for (let y = 2010; y <= 2025; y++) {
  const past = new Map();
  for (const g of games.filter((x) => x.season < y)) {
    const e = past.get(g.ref) ?? past.set(g.ref, { o: 0, n: 0 }).get(g.ref);
    e.o += g.over;
    e.n++;
  }
  const now = new Map();
  for (const g of games.filter((x) => x.season === y)) {
    const e = now.get(g.ref) ?? now.set(g.ref, { o: 0, n: 0, games: [] }).get(g.ref);
    e.o += g.over;
    e.n++;
    e.games.push(g);
  }
  let w = 0, l = 0;
  for (const [ref, e] of now) {
    const p = past.get(ref);
    if (!p || p.n < 40) continue;
    const rate = p.o / p.n;
    if (e.n >= 10) pairs.push([rate, e.o / e.n]);
    const side = rate >= 0.55 ? 1 : rate <= 0.45 ? 0 : undefined;
    if (side === undefined) continue;
    for (const g of e.games) (g.over === side ? w++ : l++);
  }
  betW += w;
  betL += l;
  bySeason.push({ season: y, bets: w + l, hitRate: w + l ? r3(w / (w + l)) : null });
}
const corr = (() => {
  const n = pairs.length, mx = pairs.reduce((a, b) => a + b[0], 0) / n, my = pairs.reduce((a, b) => a + b[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy);
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { pairs: n, r: r3(r), ci95: [r3(Math.tanh(z - 1.96 * se)), r3(Math.tanh(z + 1.96 * se))] };
})();
const n = betW + betL, p = n ? betW / n : 0, se = n ? Math.sqrt((p * (1 - p)) / n) : 0;
const bet = { bets: n, hitRate: r3(p), ci95: [r3(p - 1.96 * se), r3(p + 1.96 * se)], roi: n ? r3((betW * 100 - betL * 110) / (n * 110)) : 0 };
const pass = bet.ci95[0] > 0.524;
const verdict = pass
  ? `Referee over/under tendencies carried into the next season: betting them hit ${(p * 100).toFixed(1)}% on ${n} games since 2010.`
  : `Referee over/under records did not carry over: a referee's past over rate predicted his next season with a correlation of ${corr.r} (${corr.pairs} referee-seasons), and betting the tendency hit ${(p * 100).toFixed(1)}% on ${n} games since 2010 against 52.4% to break even. Not shown as a lean.`;
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "referees.json"), JSON.stringify({ builtAt: new Date().toISOString(), carryOver: corr, bet, pass, verdict, bySeason }, null, 2));
console.log(corr);
console.log(bet);
console.log(verdict);
console.table(bySeason);
