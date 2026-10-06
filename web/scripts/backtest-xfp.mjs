/**
 * Backtest expected fantasy points (ffverse ffopportunity) in the DraftKings projection.
 *
 *   node scripts/backtest-xfp.mjs                  # seasons 2022..2025
 *
 * Walk-forward per week (week 3 on), QB/RB/WR/TE with 2+ games so far and 8+ DK points a game (the DFS pool):
 *   live     (his DK points a game so far, with last season worth 3 games) x (1 + 0.25 x (matchup - 1))
 *   + xfp    the same, with the base replaced by (1 - w) x DK base + w x (his expected points a game so far, blended
 *            with last season's the same way, on DraftKings' scale: times the pool's DK points over ffopportunity
 *            points so far, about 1.03 since DK adds yardage bonuses)
 * graded on DK points that week. Grid w in 0..1. Writes data/backtest/xfp.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const POS = new Set(["QB", "RB", "WR", "TE"]);
const W = [0, 0.25, 0.5, 0.6, 0.75, 1];
const PRIOR = 3;
const MATCH = 0.25;

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) +
    n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fumbles_lost_total") + n("special_teams_tds") * 6;
};

async function weekRows(y) {
  const rows = [];
  await readCsv(path.join(CACHE, `stats_player_week_${y}.csv`), (r) => {
    if (r.season_type !== "REG" || !POS.has(r.position)) return;
    rows.push({ id: r.player_id, pos: r.position, week: Number(r.week), opp: r.opponent_team, pts: dk(r) });
  });
  return rows;
}
async function xfpRows(y) {
  const m = new Map();
  await readCsv(path.join(CACHE, `ep_weekly_${y}.csv`), (r) => {
    const x = num(r.total_fantasy_points_exp);
    if (x == null) return;
    m.set(`${r.player_id}|${Number(r.week)}`, { x, fp: num(r.total_fantasy_points) ?? 0 });
  });
  return m;
}

const cells = new Map(W.map((w) => [w, { ae: 0, xs: [] }]));
const ys = [];
for (const season of SEASONS) {
  const [rows, prevRows, xf, xfPrev] = await Promise.all([weekRows(season), weekRows(season - 1), xfpRows(season), xfpRows(season - 1)]);
  const prev = new Map();
  for (const r of prevRows) {
    const e = prev.get(r.id) ?? prev.set(r.id, { pts: 0, x: 0, nx: 0, n: 0 }).get(r.id);
    e.pts += r.pts;
    e.n++;
    const q = xfPrev.get(`${r.id}|${r.week}`);
    if (q) { e.x += q.x; e.nx++; }
  }
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  for (const w of weeks) {
    if (w < 3) continue;
    const before = rows.filter((r) => r.week < w);
    const allowed = new Map();
    for (const r of before) {
      const k = `${r.opp}|${r.pos}`;
      const e = allowed.get(k) ?? allowed.set(k, { pts: 0, g: new Set() }).get(k);
      e.pts += r.pts;
      e.g.add(r.week);
    }
    const league = {};
    for (const pos of POS) {
      const per = [...allowed.entries()].filter(([k]) => k.endsWith(`|${pos}`)).map(([, e]) => e.pts / e.g.size);
      league[pos] = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
    }
    // DraftKings points over ffopportunity points so far, across the pool, to put expected points on DK's scale.
    let dkSum = 0, fpSum = 0;
    const hist = new Map();
    for (const r of before) {
      const e = hist.get(r.id) ?? hist.set(r.id, { pts: 0, n: 0, x: 0, nx: 0 }).get(r.id);
      e.pts += r.pts;
      e.n++;
      const q = xf.get(`${r.id}|${r.week}`);
      if (q) { e.x += q.x; e.nx++; dkSum += r.pts; fpSum += q.fp; }
    }
    const scale = fpSum ? dkSum / fpSum : 1;
    for (const r of rows.filter((x) => x.week === w)) {
      const h = hist.get(r.id);
      if (!h || h.n < 2) continue;
      const now = h.pts / h.n;
      if (now < 8 || !h.nx) continue;
      const p = prev.get(r.id);
      const lastDk = p && p.n >= 4 ? p.pts / p.n : undefined;
      const lastX = p && p.nx >= 4 ? p.x / p.nx : undefined;
      const dkBase = lastDk === undefined ? now : (h.n * now + PRIOR * lastDk) / (h.n + PRIOR);
      const xNow = h.x / h.nx;
      const xBase = (lastX === undefined ? xNow : (h.nx * xNow + PRIOR * lastX) / (h.nx + PRIOR)) * scale;
      const a = allowed.get(`${r.opp}|${r.pos}`);
      const factor = a && league[r.pos] ? Math.min(1.35, Math.max(0.7, a.pts / a.g.size / league[r.pos])) : 1;
      ys.push(r.pts);
      for (const wt of W) {
        const proj = ((1 - wt) * dkBase + wt * xBase) * (1 + MATCH * (factor - 1));
        const c = cells.get(wt);
        c.ae += Math.abs(proj - r.pts);
        c.xs.push(proj);
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
const results = W.map((w) => ({ xfpWeight: w, playerWeeks: ys.length, mae: Math.round((cells.get(w).ae / ys.length) * 1000) / 1000, corr: corr(cells.get(w).xs) }));
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "xfp.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, priorGames: PRIOR, matchupWeight: MATCH, results }, null, 2));
console.table(results);
