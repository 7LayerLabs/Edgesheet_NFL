/**
 * Backtest the model total (src/lib/projection.ts expectedPoints) on past seasons.
 *
 *   node scripts/backtest-total.mjs                  # seasons 2022..2025
 *
 * Live formula, per offense against the other defense:
 *   points = AVG_PPG + plays x ((offense EPA a play - league offense mean) + (defense EPA a play allowed - league defense mean)) / 2
 *   plays  = the average of the two offenses' plays a game; total = home + away.
 * Live inputs are this season's play-by-play (pass and run plays). Here they come from nflverse
 * stats_team_week (passing plus rushing EPA over attempts, sacks, and carries), walk-forward: a game
 * only sees weeks before it in the same season. Weather and availability are left out.
 *
 * Graded against finals and the nflverse closing total (schedule totalLine). Variants on a grid:
 *   shrink s     multiplies the EPA deviation (s = 1 is the live model)
 *   prior k      blends last season's team rates in with weight k / (games + k) (k = 0 is the live model)
 *   base         AVG_PPG; the fitted base is the mean of actual points per team in the graded games
 * Reports MAE, bias (model minus actual), and over/under hit rate by gap to the closing total.
 * Writes data/backtest/total.json.
 */
import { mkdir, writeFile, access, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const LIVE_AVG = 22.8;
const MIN_GAMES = 2; // grade from the point the live model has two games of data
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

async function teamWeek(y) {
  const name = `stats_team_week_${y}.csv`;
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  log("download", name);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/stats_team/${name}`, { redirect: "follow" });
  if (!res.ok) return undefined;
  await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

const schedule = JSON.parse(await readFile(path.join(root, "data", "generated", "schedule.json"), "utf8"));

// Per season: team -> [{ week, plays, epa, playsAllowed, epaAllowed }]
const lines = new Map();
for (const y of [Math.min(...SEASONS) - 1, ...SEASONS]) {
  const f = await teamWeek(y);
  if (!f) continue;
  const rows = [];
  await readCsv(f, (r) => {
    if (r.season_type !== "REG") return;
    const plays = (num(r.attempts) ?? 0) + (num(r.sacks_suffered) ?? 0) + (num(r.carries) ?? 0);
    rows.push({ team: r.team, opp: r.opponent_team, week: Number(r.week), plays, epa: (num(r.passing_epa) ?? 0) + (num(r.rushing_epa) ?? 0) });
  });
  const byTeam = new Map();
  const key = (t, w) => `${t}|${w}`;
  const idx = new Map(rows.map((r) => [key(r.team, r.week), r]));
  for (const r of rows) {
    const o = idx.get(key(r.opp, r.week));
    if (!o) continue;
    const arr = byTeam.get(r.team) ?? byTeam.set(r.team, []).get(r.team);
    arr.push({ week: r.week, plays: r.plays, epa: r.epa, playsAllowed: o.plays, epaAllowed: o.epa });
  }
  lines.set(y, byTeam);
  log("loaded", y, rows.length, "team games");
}

/** Team rates from weeks before `week` (or the whole season when week is Infinity). */
function rates(y, team, week) {
  const arr = (lines.get(y)?.get(team) ?? []).filter((l) => l.week < week);
  if (!arr.length) return undefined;
  const sum = (k) => arr.reduce((a, b) => a + b[k], 0);
  return { games: arr.length, off: sum("epa") / sum("plays"), def: sum("epaAllowed") / sum("playsAllowed"), pace: sum("plays") / arr.length };
}

/** League means of team rates for the same cut (each team counted once). */
const meansCache = new Map();
function means(y, week) {
  const k = `${y}|${week}`;
  if (meansCache.has(k)) return meansCache.get(k);
  const all = [...(lines.get(y)?.keys() ?? [])].map((t) => rates(y, t, week)).filter(Boolean);
  const m = all.length ? { off: all.reduce((a, b) => a + b.off, 0) / all.length, def: all.reduce((a, b) => a + b.def, 0) / all.length } : undefined;
  meansCache.set(k, m);
  return m;
}

const blend = (cur, prev, k) => {
  if (!prev || !k) return cur;
  const w = cur.games / (cur.games + k);
  return { games: cur.games, off: w * cur.off + (1 - w) * prev.off, def: w * cur.def + (1 - w) * prev.def, pace: w * cur.pace + (1 - w) * prev.pace };
};

const games = schedule.filter((g) => SEASONS.includes(g.season) && g.type === "REG" && g.played && g.total != null && g.totalLine != null);
function project(g, { s, k, base }) {
  const H = rates(g.season, g.homeCode, g.week);
  const A = rates(g.season, g.awayCode, g.week);
  if (!H || !A || H.games < MIN_GAMES || A.games < MIN_GAMES) return undefined;
  const m = means(g.season, g.week);
  const pm = means(g.season - 1, Infinity);
  const h = blend(H, rates(g.season - 1, g.homeCode, Infinity), k);
  const a = blend(A, rates(g.season - 1, g.awayCode, Infinity), k);
  // Blended rates are measured against a blend of the two seasons' league means.
  const w = (x) => (k ? x.games / (x.games + k) : 1);
  const mean = (x, side) => w(x) * m[side] + (1 - w(x)) * (pm?.[side] ?? m[side]);
  const pace = (h.pace + a.pace) / 2;
  const pts = (o, oRaw, d, dRaw) => Math.max(3, base + pace * s * ((o.off - mean(oRaw, "off") + (d.def - mean(dRaw, "def"))) / 2));
  return pts(h, H, a, A) + pts(a, A, h, H);
}

function grade(variant) {
  let ae = 0, bias = 0, n = 0, aeMkt = 0;
  const buckets = [[0, 2.5], [2.5, 5], [5, 99]].map(([lo, hi]) => ({ lo, hi, n: 0, hit: 0 }));
  let ouN = 0, ouHit = 0;
  for (const g of games) {
    const t = project(g, variant);
    if (t === undefined) continue;
    const model = Math.round(t * 2) / 2;
    n++;
    ae += Math.abs(model - g.total);
    bias += model - g.total;
    aeMkt += Math.abs(g.totalLine - g.total);
    const gap = model - g.totalLine;
    if (gap === 0 || g.total === g.totalLine) continue;
    const hit = gap > 0 ? g.total > g.totalLine : g.total < g.totalLine;
    ouN++;
    ouHit += hit ? 1 : 0;
    const b = buckets.find((x) => Math.abs(gap) >= x.lo && Math.abs(gap) < x.hi);
    b.n++;
    b.hit += hit ? 1 : 0;
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    ...variant,
    games: n,
    mae: r3(ae / n),
    bias: r3(bias / n),
    marketMae: r3(aeMkt / n),
    ouHit: r3(ouHit / ouN),
    gap0to2_5: `${r3(buckets[0].hit / Math.max(1, buckets[0].n))} (${buckets[0].n})`,
    gap2_5to5: `${r3(buckets[1].hit / Math.max(1, buckets[1].n))} (${buckets[1].n})`,
    gap5plus: `${r3(buckets[2].hit / Math.max(1, buckets[2].n))} (${buckets[2].n})`,
  };
}

const gradedGames = games.filter((g) => project(g, { s: 1, k: 0, base: LIVE_AVG }) !== undefined);
const fittedBase = Math.round((gradedGames.reduce((a, g) => a + g.total, 0) / gradedGames.length / 2) * 10) / 10;
log("graded games", gradedGames.length, "actual points per team", fittedBase);

const variants = [];
for (const base of [LIVE_AVG, fittedBase]) for (const s of [1, 0.75, 0.5, 0.25, 0]) for (const k of [0, 3, 6]) variants.push(grade({ base, s, k }));
variants.sort((a, b) => a.mae - b.mae);
const live = variants.find((v) => v.base === LIVE_AVG && v.s === 1 && v.k === 0);
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "total.json"), JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, minGames: MIN_GAMES, fittedBase, live, variants }, null, 2));
console.log("Live model (base 22.8, s 1, k 0):");
console.table([live]);
console.log("Best variants by MAE:");
console.table(variants.slice(0, 8));
