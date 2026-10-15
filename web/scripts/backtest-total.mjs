/**
 * Backtest the model total (src/lib/projection.ts expectedPoints) on past seasons, out of sample.
 *
 *   node scripts/backtest-total.mjs        # fit on 2019-21, graded on 2022-25
 *
 * Live formula, per offense against the other defense:
 *   points = AVG_PPG + plays x shrink x ((offense EPA a play - league offense mean) + (defense EPA a play allowed - league defense mean)) / 2
 *   plays  = the average of the two offenses' plays a game; total = home + away.
 * Live inputs are this season's play-by-play (pass and run plays). Here they come from nflverse
 * stats_team_week (passing plus rushing EPA over attempts, sacks, and carries), walk-forward: a game
 * only sees weeks before it in the same season. Weather and availability are left out.
 *
 * Audit 2026-10-12 item 2.2: the base and the shrink used to be picked on the same games they were graded on. Now
 * they are fit on 2019-21 only (lowest miss against the final, base 20 to 25 by 0.1, shrink 0 to 1 by 0.05) and
 * graded on 2022-25. Games count from week 2, since the live model makes a total after one game. Also reports
 * weeks 2 and 3 against weeks 4 on (the live total waits until week 4 if the early weeks miss by 0.5+ more), and
 * the earlier live constants on the same games for comparison. A last-season prior (k) is shown as context only.
 *
 * Graded against finals and the nflverse closing total (schedule totalLine). Reports MAE, bias (model minus actual),
 * and over/under hit rate by gap to the closing total. Writes data/backtest/total.json and data/backtest/total-rows.json
 * (the model total for each graded game, read by scripts/backtest-replay.mjs).
 */
import { mkdir, writeFile, access, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const FIT = [2019, 2020, 2021];
const TEST = [2022, 2023, 2024, 2025];
const SEASONS = [...FIT, ...TEST];
const PREV_LIVE = { base: 22.4, s: 0.5, k: 0 }; // the live constants before this run
const MIN_GAMES = 1; // the live model makes a total once both teams have one game
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
const ratesCache = new Map();
function rates(y, team, week) {
  const ck = `${y}|${team}|${week}`;
  if (ratesCache.has(ck)) return ratesCache.get(ck);
  const arr = (lines.get(y)?.get(team) ?? []).filter((l) => l.week < week);
  const sum = (k) => arr.reduce((a, b) => a + b[k], 0);
  const out = arr.length ? { games: arr.length, off: sum("epa") / sum("plays"), def: sum("epaAllowed") / sum("playsAllowed"), pace: sum("plays") / arr.length } : undefined;
  ratesCache.set(ck, out);
  return out;
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

const allGames = schedule.filter((g) => SEASONS.includes(g.season) && g.type === "REG" && g.played && g.total != null && g.totalLine != null);
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

const r3 = (x) => Math.round(x * 1000) / 1000;
function grade(variant, games) {
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
  const bucket = (b) => ({ hit: b.n ? r3(b.hit / b.n) : null, n: b.n });
  return {
    ...variant,
    games: n,
    mae: n ? r3(ae / n) : null,
    bias: n ? r3(bias / n) : null,
    marketMae: n ? r3(aeMkt / n) : null,
    ouHit: ouN ? r3(ouHit / ouN) : null,
    gap0to2_5: bucket(buckets[0]),
    gap2_5to5: bucket(buckets[1]),
    gap5plus: bucket(buckets[2]),
  };
}

/** The base and shrink with the lowest miss against the final on these games (k = 0, as live). */
function fitOn(games) {
  let best;
  for (let b = 200; b <= 250; b++) {
    for (let si = 0; si <= 20; si++) {
      const v = grade({ base: b / 10, s: si / 20, k: 0 }, games);
      if (!best || v.mae < best.mae) best = v;
    }
  }
  return best;
}
const fitGames = allGames.filter((g) => FIT.includes(g.season));
const testGames = allGames.filter((g) => TEST.includes(g.season));
const best = fitOn(fitGames);
const fit = { base: best.base, s: best.s, k: 0 };
log("fit on 2019-21", JSON.stringify(fit), "MAE", best.mae, "on", best.games, "games");

// Expanding window: each test season graded with constants fit on every season before it (from 2019). The live
// constants for the next season come from the same procedure on every finished season.
const expanding = TEST.map((y) => {
  const f = fitOn(allGames.filter((g) => g.season < y));
  return { season: y, base: f.base, s: f.s, ...grade({ base: f.base, s: f.s, k: 0 }, allGames.filter((g) => g.season === y)) };
});
const expandingMae = r3(expanding.reduce((a, x) => a + x.mae * x.games, 0) / expanding.reduce((a, x) => a + x.games, 0));
const expandingMarket = r3(expanding.reduce((a, x) => a + x.marketMae * x.games, 0) / expanding.reduce((a, x) => a + x.games, 0));
const nextFit = fitOn(allGames);
const next = { base: nextFit.base, s: nextFit.s, k: 0 };
log("expanding window MAE", expandingMae, "market", expandingMarket, "| next season", JSON.stringify(next));

const early = testGames.filter((g) => g.week <= 3);
const later = testGames.filter((g) => g.week >= 4);
const out = {
  builtAt: new Date().toISOString(),
  fitSeasons: FIT,
  testSeasons: TEST,
  minGames: MIN_GAMES,
  fit,
  fitInSample: best,
  test: grade(fit, testGames),
  testPrevLive: grade(PREV_LIVE, testGames),
  weeks2to3: grade(fit, early),
  weeks4on: grade(fit, later),
  bySeason: TEST.map((y) => ({ season: y, ...grade(fit, testGames.filter((g) => g.season === y)) })),
  priorContext: [3, 6].map((k) => grade({ ...fit, k }, testGames)),
  expanding,
  expandingMae,
  expandingMarketMae: expandingMarket,
  next,
};
out.waitUntilWeek4 = out.weeks2to3.mae - out.weeks4on.mae >= 0.5;
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "total.json"), JSON.stringify(out, null, 2));
// The model total for every graded game, for scripts/backtest-replay.mjs: test seasons with the constants fit before
// them, 2019-21 with the 2019-21 fit (in sample; those seasons only train the replay's market weights).
const constantsFor = (y) => (TEST.includes(y) ? expanding.find((x) => x.season === y) : fit);
const totalRows = allGames.flatMap((g) => {
  const c = constantsFor(g.season);
  const t = project(g, { base: c.base, s: c.s, k: 0 });
  return t === undefined ? [] : [{ id: g.id, season: g.season, week: g.week, model: Math.round(t * 2) / 2 }];
});
await writeFile(path.join(OUT, "total-rows.json"), JSON.stringify(totalRows));
console.log("Graded 2022-25 from week 2:");
console.table([{ model: "fit on 2019-21", ...out.test }, { model: "previous live (22.4, 0.5)", ...out.testPrevLive }].map((x) => ({ ...x, gap0to2_5: JSON.stringify(x.gap0to2_5), gap2_5to5: JSON.stringify(x.gap2_5to5), gap5plus: JSON.stringify(x.gap5plus) })));
console.table([{ weeks: "2-3", ...out.weeks2to3 }, { weeks: "4+", ...out.weeks4on }].map((x) => ({ weeks: x.weeks, games: x.games, mae: x.mae, marketMae: x.marketMae })));
log("wait until week 4:", out.waitUntilWeek4);
