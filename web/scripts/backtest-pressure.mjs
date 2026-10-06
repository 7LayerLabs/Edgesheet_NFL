/**
 * Backtest the pass-rush lens behind the defensive props: do pressures predict next week's sacks better than sacks do?
 *
 *   node scripts/backtest-pressure.mjs               # seasons 2022..2025
 *
 * PFR advanced weekly defense (nflverse pfr_advstats), walk-forward from week 3, defenders with 2+ games and 2+ pressures
 * so far that season. Sack rate per game is predicted three ways:
 *   sacks      his sacks a game so far
 *   pressures  his pressures a game so far x the league's sacks per pressure so far
 *   blend      w x pressures + (1 - w) x sacks, w on a grid
 * each optionally times the opponent's pressures allowed a game against the league (from the PFR passing file, the
 * quarterbacks' times pressured summed by team), capped 0.75 to 1.3 and taken at a weight m.
 * Graded on sacks that week: mean absolute error, and the Brier score of "half a sack or more" with a Poisson chance
 * 1 - e^(-rate), the shape of a sack prop. Writes data/backtest/pressure.json.
 */
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const W = [0, 0.25, 0.5, 0.75, 1];
const M = [0, 0.5, 1];

async function file(kind, y) {
  const name = `advstats_week_${kind}_${y}.csv`;
  const f = path.join(CACHE, name);
  try {
    await access(f);
    return f;
  } catch {
    const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/${name}`, { redirect: "follow" });
    if (!res.ok) throw new Error(`${name} ${res.status}`);
    await writeFile(`${f}.part`, Buffer.from(await res.arrayBuffer()));
    await rename(`${f}.part`, f);
    return f;
  }
}

const cells = new Map();
const cell = (k) => cells.get(k) ?? cells.set(k, { ae: 0, brier: 0, n: 0 }).get(k);
for (const season of SEASONS) {
  const def = [];
  await readCsv(await file("def", season), (r) => {
    if (r.game_type !== "REG") return;
    def.push({ id: r.pfr_player_id, week: Number(r.week), opp: r.opponent, sk: num(r.def_sacks) ?? 0, pr: num(r.def_pressures) ?? 0 });
  });
  // Pressures each offense allowed, by week (its quarterbacks' times pressured).
  const allowedWk = new Map();
  await readCsv(await file("pass", season), (r) => {
    if (r.game_type !== "REG") return;
    const k = `${r.team}|${Number(r.week)}`;
    allowedWk.set(k, (allowedWk.get(k) ?? 0) + (num(r.times_pressured) ?? 0));
  });
  const weeks = [...new Set(def.map((d) => d.week))].sort((a, b) => a - b);
  for (const w of weeks) {
    if (w < 3) continue;
    const before = def.filter((d) => d.week < w);
    const skAll = before.reduce((a, b) => a + b.sk, 0);
    const prAll = before.reduce((a, b) => a + b.pr, 0);
    const skPerPr = prAll ? skAll / prAll : 0;
    const team = new Map();
    for (const [k, v] of allowedWk) {
      const [t, wk] = k.split("|");
      if (Number(wk) >= w) continue;
      const e = team.get(t) ?? team.set(t, { pr: 0, g: 0 }).get(t);
      e.pr += v;
      e.g++;
    }
    const leaguePr = [...team.values()].reduce((a, b) => a + b.pr / b.g, 0) / Math.max(1, team.size);
    const hist = new Map();
    for (const d of before) {
      const e = hist.get(d.id) ?? hist.set(d.id, { sk: 0, pr: 0, g: 0 }).get(d.id);
      e.sk += d.sk;
      e.pr += d.pr;
      e.g++;
    }
    for (const d of def.filter((x) => x.week === w)) {
      const h = hist.get(d.id);
      if (!h || h.g < 2 || h.pr < 2) continue;
      const o = team.get(d.opp);
      const oppFactor = o && leaguePr ? Math.min(1.3, Math.max(0.75, o.pr / o.g / leaguePr)) : 1;
      const viaSacks = h.sk / h.g;
      const viaPress = (h.pr / h.g) * skPerPr;
      const hit = d.sk >= 0.5 ? 1 : 0;
      for (const wt of W) {
        for (const m of M) {
          const rate = (wt * viaPress + (1 - wt) * viaSacks) * (1 + m * (oppFactor - 1));
          const c = cell(`${wt}|${m}`);
          c.ae += Math.abs(rate - d.sk);
          const p = 1 - Math.exp(-rate);
          c.brier += (p - hit) ** 2;
          c.n++;
        }
      }
    }
  }
}
const r4 = (x) => Math.round(x * 10000) / 10000;
const results = [...cells.entries()].map(([k, c]) => {
  const [w, m] = k.split("|").map(Number);
  return { pressureWeight: w, opponentWeight: m, rusherWeeks: c.n, mae: r4(c.ae / c.n), brier: r4(c.brier / c.n) };
}).sort((a, b) => a.brier - b.brier);
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "pressure.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, results }, null, 2));
console.log("Sacks only (pressureWeight 0, opponentWeight 0) against the rest, best Brier first:");
console.table(results.slice(0, 8));
console.table(results.filter((r) => r.pressureWeight === 0 && r.opponentWeight === 0));
