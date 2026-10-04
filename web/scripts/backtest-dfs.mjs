/**
 * Backtest the DraftKings projection in src/lib/dfs.ts.
 *
 *   node scripts/backtest-dfs.mjs                 # seasons 2024, 2025 (needs 2023 for the first prior)
 *
 * Walk-forward per week (week 3 on): each QB, RB, WR, and TE with 2+ games earlier that season, and
 * 8+ DK points a game so far (the pool a DFS player is choosing from), gets
 *   base      his DK points a game so far, blended with last season's per-game average at weight
 *             k / (games + k) (k = 0 is this season only)
 *   proj      base x (1 + s x (factor - 1)), factor = DK points the opponent allowed a game to the
 *             position so far against the league average, capped 0.7 to 1.35
 * graded against what he scored that week (DK Classic rules, no two-point conversions, as in dfs.ts).
 * Reports MAE and the correlation with actual points on a grid of k and s. Writes data/backtest/dfs.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2024,2025").split(",").map(Number);
const POS = new Set(["QB", "RB", "WR", "TE"]);
const S = [0, 0.25, 0.5];
const K = [0, 1, 2, 3, 4, 6];

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) +
    n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fumbles_lost_total") + n("special_teams_tds") * 6;
};

async function seasonRows(season) {
  const rows = [];
  await readCsv(path.join(CACHE, `stats_player_week_${season}.csv`), (r) => {
    if (r.season_type !== "REG" || !POS.has(r.position)) return;
    rows.push({ id: r.player_id, pos: r.position, week: Number(r.week), opp: r.opponent_team, pts: dk(r) });
  });
  return rows;
}

const cells = new Map(); // `${k}|${s}` -> { ae, xs }
const ys = [];
for (const season of SEASONS) {
  const rows = await seasonRows(season);
  const prevRows = await seasonRows(season - 1);
  const prev = new Map();
  for (const r of prevRows) {
    const e = prev.get(r.id) ?? prev.set(r.id, { pts: 0, n: 0 }).get(r.id);
    e.pts += r.pts;
    e.n++;
  }
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  for (const w of weeks) {
    if (w < 3) continue;
    const before = rows.filter((r) => r.week < w);
    const allowed = new Map();
    for (const r of before) {
      const key = `${r.opp}|${r.pos}`;
      const e = allowed.get(key) ?? allowed.set(key, { pts: 0, games: new Set() }).get(key);
      e.pts += r.pts;
      e.games.add(r.week);
    }
    const league = {};
    for (const pos of POS) {
      const per = [...allowed.entries()].filter(([key]) => key.endsWith(`|${pos}`)).map(([, e]) => e.pts / e.games.size);
      league[pos] = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
    }
    const hist = new Map();
    for (const r of before) {
      const e = hist.get(r.id) ?? hist.set(r.id, { pts: 0, n: 0 }).get(r.id);
      e.pts += r.pts;
      e.n++;
    }
    for (const r of rows.filter((x) => x.week === w)) {
      const h = hist.get(r.id);
      if (!h || h.n < 2) continue;
      const now = h.pts / h.n;
      if (now < 8) continue;
      const p = prev.get(r.id);
      const last = p && p.n >= 4 ? p.pts / p.n : undefined;
      const a = allowed.get(`${r.opp}|${r.pos}`);
      const factor = a && league[r.pos] ? Math.min(1.35, Math.max(0.7, a.pts / a.games.size / league[r.pos])) : 1;
      ys.push(r.pts);
      for (const k of K) {
        const base = last === undefined || !k ? now : (h.n * now + k * last) / (h.n + k);
        for (const s of S) {
          const proj = base * (1 + s * (factor - 1));
          const c = cells.get(`${k}|${s}`) ?? cells.set(`${k}|${s}`, { ae: 0, xs: [] }).get(`${k}|${s}`);
          c.ae += Math.abs(proj - r.pts);
          c.xs.push(proj);
        }
      }
    }
  }
}
const corr = (xs) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000;
};
const results = [...cells.entries()]
  .map(([key, c]) => {
    const [k, s] = key.split("|").map(Number);
    return { k, s, playerWeeks: ys.length, mae: Math.round((c.ae / ys.length) * 1000) / 1000, corr: corr(c.xs) };
  })
  .sort((a, b) => a.mae - b.mae);
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "dfs.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, results }, null, 2));
console.log("Live before this backtest: k 0, s 0.5");
console.table(results.filter((r) => r.k === 0 && r.s === 0.5));
console.table(results.slice(0, 10));
