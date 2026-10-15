/**
 * Backtest the quarterback adjustment in src/lib/availability.ts on past seasons.
 *
 *   node scripts/backtest-qb.mjs                    # graded 2022..2025, k fit from 2019
 *   SEASONS=2024,2025 node scripts/backtest-qb.mjs
 *
 * Walk-forward, no peeking (audit 2026-10-12, item 2.3):
 *   starter      the QB nflverse names as the starter (games.csv home_qb_id and away_qb_id). No name, no QB term for
 *                that side. There is no fallback to the QB with the most plays in the game: that is only known after it.
 *   QB value     weighted EPA a play over this season so far (weight 1) and the four seasons before
 *                (0.7, 0.5, 0.35, 0.25), shrunk with a 200-play prior whose mean slides from the 25th
 *                percentile QB (thin record) to the average QB (500+ weighted plays).
 *   levels       the 25th percentile and the average come from QB-seasons with 150+ plays before the graded season.
 *   baseline     this season's QB plays so far, each QB at his value, blended with last season's team
 *                QB plays; this season weighted games / (games + 6).
 *   adjustment   (starter - baseline) x the team's QB plays a game, capped at 12.
 *   k            the share of the adjustment that goes into the margin, picked on a grid by margin miss on the seasons
 *                before the graded one only (the schedule starts in 2019, so 2020 is the first season with a fit).
 *
 * Seasons before the schedule (2015 to 2018) only feed the QB track records and last season's team baseline, as
 * whole-season totals from the weekly stats files.
 *
 * Graded against finals and the nflverse closing line (schedule spread, positive = home favored): Elo alone, Elo plus
 * the live k, and Elo plus the out-of-sample k. Reports MAE, cover rate of the model side, and the same on games where
 * the QB term moved the margin 2+ points.
 *
 * Needs data/generated/schedule.json, data/cache/games.csv, and the weekly stats files (downloads missing ones to
 * data/cache, about 8 MB each). Writes data/backtest/qb.json and data/backtest/qb-rows.json (the raw adjustment for
 * every game from 2019, read by scripts/backtest-replay.mjs).
 */
import { mkdir, writeFile, access, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";
import { computeElo, ELO_HOME, ELO_PER_POINT } from "./lib/elo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const FIT_FROM = 2019; // the first season in schedule.json
const HIST_FROM = FIT_FROM - 4;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

const WEIGHTS = [1, 0.7, 0.5, 0.35, 0.25];
const PRIOR = 200;
const CAP = 12;
const LIVE_K = 0.75; // QB_SCALE in src/lib/availability.ts
const KS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];

/* -------------------------------------------------------------- data */
const schedule = JSON.parse(await readFile(path.join(root, "data", "generated", "schedule.json"), "utf8"));
const played = schedule.filter((g) => g.played && g.hs != null && g.as != null);
const elo = computeElo(played);

// The starter nflverse names for each side, by gsis id.
const gamesCsv = path.join(CACHE, "games.csv");
if (!(await exists(gamesCsv))) {
  console.error("backtest-qb: data/cache/games.csv missing. Run npm run ingest first.");
  process.exit(1);
}
const starters = new Map(); // gid -> { home, away }
await readCsv(gamesCsv, (r) => {
  if (Number(r.season) >= FIT_FROM) starters.set(r.game_id, { home: r.home_qb_id || undefined, away: r.away_qb_id || undefined });
});

async function weekFile(y) {
  const name = `stats_player_week_${y}.csv`;
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  log("download", name);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/${name}`, { redirect: "follow" });
  if (!res.ok) return undefined;
  await mkdir(CACHE, { recursive: true });
  await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

const qbSeason = new Map(); // pid -> Map(season -> { n, e })
const teamSeason = new Map(); // `${season}|${code}` -> Map(pid -> n)
const teamGames = new Map(); // `${season}|${code}` -> games played
const addQb = (pid, season, n, e) => {
  const m = qbSeason.get(pid) ?? qbSeason.set(pid, new Map()).get(pid);
  const s = m.get(season) ?? { n: 0, e: 0 };
  m.set(season, { n: s.n + n, e: s.e + e });
};

// QB lines per game from the schedule's first season: gid -> team code -> [{ pid, n, e }]. Earlier seasons go straight
// into the season totals.
const byGame = new Map();
const earlyWeeks = new Map(); // `${season}|${code}` -> Set(week)
const maxSeason = Math.max(...SEASONS);
for (let y = HIST_FROM; y <= maxSeason; y++) {
  const f = await weekFile(y);
  if (!f) {
    log("no weekly file for", y);
    continue;
  }
  await readCsv(f, (r) => {
    if (r.position !== "QB") return;
    const n = (num(r.attempts) ?? 0) + (num(r.sacks_suffered) ?? 0) + (num(r.carries) ?? 0);
    if (!n) return;
    const e = (num(r.passing_epa) ?? 0) + (num(r.rushing_epa) ?? 0);
    if (y < FIT_FROM) {
      addQb(r.player_id, y, n, e);
      const key = `${y}|${r.team}`;
      const ts = teamSeason.get(key) ?? teamSeason.set(key, new Map()).get(key);
      ts.set(r.player_id, (ts.get(r.player_id) ?? 0) + n);
      (earlyWeeks.get(key) ?? earlyWeeks.set(key, new Set()).get(key)).add(`${r.season_type}|${r.week}`);
      return;
    }
    if (!r.game_id) return;
    const g = byGame.get(r.game_id) ?? byGame.set(r.game_id, new Map()).get(r.game_id);
    const arr = g.get(r.team) ?? g.set(r.team, []).get(r.team);
    arr.push({ pid: r.player_id, n, e });
  });
  log("loaded", y);
}
for (const [key, weeks] of earlyWeeks) teamGames.set(key, weeks.size);

function qbRecord(pid, season) {
  const m = qbSeason.get(pid);
  let n = 0;
  let e = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    const s = m?.get(season - i);
    if (!s) continue;
    n += WEIGHTS[i] * s.n;
    e += WEIGHTS[i] * s.e;
  }
  return { n, e };
}

// Replacement and average levels for a graded season: every QB-season with 150+ plays before it.
const levelCache = new Map();
function levelsFor(season) {
  if (levelCache.has(season)) return levelCache.get(season);
  const rates = [];
  for (const m of qbSeason.values()) for (const [y, s] of m) if (y < season && s.n >= 150) rates.push(s.e / s.n);
  rates.sort((a, b) => a - b);
  const lv = { repl: rates[Math.floor(0.25 * (rates.length - 1))], mean: rates.reduce((a, b) => a + b, 0) / rates.length, n: rates.length };
  levelCache.set(season, lv);
  return lv;
}
const shrink = ({ n, e }, lv) => {
  const prior = lv.repl + (lv.mean - lv.repl) * Math.min(1, n / 500);
  return (e + prior * PRIOR) / (n + PRIOR);
};

// Walk the schedule in kickoff order: snapshot what is known before each game, then add the game's plays.
const sorted = [...played].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
const pending = [];
let named = 0;
let unnamed = 0;
for (const g of sorted) {
  const lines = byGame.get(g.gid);
  const snap = {};
  for (const side of ["home", "away"]) {
    const code = side === "home" ? g.homeCode : g.awayCode;
    const pid = starters.get(g.gid)?.[side];
    if (pid) named++;
    else unnamed++;
    const key = `${g.season}|${code}`;
    const prevKey = `${g.season - 1}|${code}`;
    snap[side] = {
      starter: pid ? { pid, rec: qbRecord(pid, g.season) } : undefined,
      now: [...(teamSeason.get(key) ?? new Map())].map(([id, n]) => ({ n, rec: qbRecord(id, g.season) })),
      prev: [...(teamSeason.get(prevKey) ?? new Map())].map(([id, n]) => ({ n, rec: qbRecord(id, g.season) })),
      games: teamGames.get(key) ?? 0,
      prevGames: teamGames.get(prevKey) ?? 0,
    };
  }
  pending.push({ g, snap });
  for (const side of ["home", "away"]) {
    const code = side === "home" ? g.homeCode : g.awayCode;
    const key = `${g.season}|${code}`;
    teamGames.set(key, (teamGames.get(key) ?? 0) + 1);
    const ts = teamSeason.get(key) ?? teamSeason.set(key, new Map()).get(key);
    for (const q of lines?.get(code) ?? []) {
      addQb(q.pid, g.season, q.n, q.e);
      ts.set(q.pid, (ts.get(q.pid) ?? 0) + q.n);
    }
  }
}
log("games", pending.length, "named starters", named, "no name", unnamed);

function adjustment(s, lv) {
  if (!s.starter) return { adj: 0, known: false };
  const v = shrink(s.starter.rec, lv);
  const mix = (rows) => {
    const tot = rows.reduce((a, b) => a + b.n, 0);
    return tot ? { val: rows.reduce((a, r) => a + shrink(r.rec, lv) * r.n, 0) / tot, tot } : undefined;
  };
  const now = mix(s.now);
  const prev = mix(s.prev);
  if (!now && !prev) return { adj: 0, known: false };
  const wNow = !prev ? 1 : !now ? 0 : s.games / (s.games + 6);
  const base = wNow * (now?.val ?? 0) + (1 - wNow) * (prev?.val ?? 0);
  const ppg = now ? now.tot / Math.max(1, s.games) : prev ? prev.tot / Math.max(1, s.prevGames) : 37;
  return { adj: Math.max(-CAP, Math.min(CAP, (v - base) * ppg)), known: true };
}

/* ------------------------------------------------------------- grade */
const all = [];
for (const { g, snap } of pending) {
  const pre = elo.pregame.get(g.id);
  if (!pre) continue;
  const lv = levelsFor(g.season);
  const h = adjustment(snap.home, lv);
  const a = adjustment(snap.away, lv);
  const eloMargin = (pre.home + (g.neutral ? 0 : ELO_HOME) - pre.away) / ELO_PER_POINT;
  all.push({ id: g.id, season: g.season, week: g.week, eloMargin, qb: h.adj - a.adj, h: h.adj, a: a.adj, hKnown: h.known, aKnown: a.known, market: g.spread, actual: g.hs - g.as, homeQb: g.homeQb, awayQb: g.awayQb });
}
const withLine = all.filter((r) => r.market != null);
log("rows", all.length, "with a closing line", withLine.length);

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const maeAt = (set, k) => set.reduce((a, r) => a + Math.abs(r.eloMargin + k * r.qb - r.actual), 0) / set.length;
/** k for a season: the grid value with the lowest margin miss on the seasons before it. */
const kCache = new Map();
function kFor(season) {
  if (kCache.has(season)) return kCache.get(season);
  const train = withLine.filter((r) => r.season < season);
  const k = train.length ? KS.reduce((best, x) => (maeAt(train, x) < maeAt(train, best) - 1e-9 ? x : best), KS[0]) : undefined;
  kCache.set(season, k);
  return k;
}

/** Margin miss and cover rate of the model side for a margin function. */
function grade(set, marginOf) {
  let ae = 0, cov = 0, n = 0, cov2 = 0, n2 = 0, cov4 = 0, n4 = 0;
  for (const r of set) {
    const m = marginOf(r);
    ae += Math.abs(m - r.actual);
    const ats = r.actual - r.market; // positive = home covered
    if (ats === 0 || m === r.market) continue;
    const win = m > r.market ? ats > 0 : ats < 0;
    n++;
    cov += win ? 1 : 0;
    const gap = Math.abs(m - r.market);
    if (gap >= 2) { n2++; cov2 += win ? 1 : 0; }
    if (gap >= 4) { n4++; cov4 += win ? 1 : 0; }
  }
  return { mae: set.length ? r3(ae / set.length) : null, cover: n ? r3(cov / n) : null, n, cover2: n2 ? r3(cov2 / n2) : null, n2, cover4: n4 ? r3(cov4 / n4) : null, n4 };
}
const eloOnly = (r) => r.eloMargin;
const eloLive = (r) => r.eloMargin + LIVE_K * r.qb;
const eloOos = (r) => r.eloMargin + kFor(r.season) * r.qb;

const rows = withLine.filter((r) => SEASONS.includes(r.season));
const changed = rows.filter((r) => Math.abs(r.qb) >= 2);
const marketMae = (set) => r3(set.reduce((a, r) => a + Math.abs(r.market - r.actual), 0) / set.length);
const corr = (xs, ys) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return r3(sxy / Math.sqrt(sxx * syy));
};
const kNext = kFor(maxSeason + 1);
const BUCKETS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6], [6, 99]];
const out = {
  builtAt: new Date().toISOString(),
  seasons: SEASONS,
  rules: "Named starter only; levels and k from seasons before the graded one (audit 2026-10-12 item 2.3).",
  levels: Object.fromEntries(SEASONS.map((s) => [s, { repl: r3(levelsFor(s).repl), mean: r3(levelsFor(s).mean), qbSeasons: levelsFor(s).n }])),
  starters: { named, unnamed },
  games: rows.length,
  marketMae: marketMae(rows),
  kBySeason: Object.fromEntries([...SEASONS, maxSeason + 1].map((s) => [s, kFor(s)])),
  kNext,
  elo: grade(rows, eloOnly),
  eloLiveK: { k: LIVE_K, ...grade(rows, eloLive) },
  eloOosK: grade(rows, eloOos),
  /** The 2.1 bar for this term: Elo plus the QB term must lower the out-of-sample margin miss by 0.05+. */
  maeGainOos: r3(maeAt(rows, 0) - rows.reduce((a, r) => a + Math.abs(eloOos(r) - r.actual), 0) / rows.length),
  maeGainLive: r3(maeAt(rows, 0) - maeAt(rows, LIVE_K)),
  inSampleGrid: KS.map((k) => ({ k, ...grade(rows, (r) => r.eloMargin + k * r.qb) })),
  qbChanged: { games: changed.length, marketMae: changed.length ? marketMae(changed) : null, elo: grade(changed, eloOnly), eloLiveK: grade(changed, eloLive), eloOosK: grade(changed, eloOos) },
  qbTermVsMarketMinusElo: corr(rows.map((r) => r.qb), rows.map((r) => r.market - r.eloMargin)),
  qbTermVsActualMinusElo: corr(rows.map((r) => r.qb), rows.map((r) => r.actual - r.eloMargin)),
  bySeason: SEASONS.map((s) => {
    const set = rows.filter((r) => r.season === s);
    return { season: s, games: set.length, k: kFor(s), elo: grade(set, eloOnly), eloOosK: grade(set, eloOos) };
  }),
  biggest: [...rows].sort((a, b) => Math.abs(b.qb) - Math.abs(a.qb)).slice(0, 15).map((r) => ({ id: r.id, season: r.season, week: r.week, qbs: `${r.awayQb} at ${r.homeQb}`, qb: r2(r.qb), elo: r2(r.eloMargin), market: r.market, actual: r.actual })),
  // Cover rate of the model side by how far it sits from the closing number, at the out-of-sample k.
  byGap: BUCKETS.map(([lo, hi]) => {
    const set = rows.filter((r) => {
      const gap = Math.abs(eloOos(r) - r.market);
      return gap >= lo && gap < hi;
    });
    const g = grade(set, eloOos);
    return { gap: `${lo} to ${hi === 99 ? "more" : hi}`, games: set.length, coverEloQb: g.cover, n: g.n };
  }),
};
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "qb.json"), JSON.stringify(out, null, 2));
await writeFile(path.join(OUT, "qb-rows.json"), JSON.stringify(all.map((r) => ({ id: r.id, season: r.season, h: r2(r.h), a: r2(r.a), hKnown: r.hKnown, aKnown: r.aKnown }))));
console.log("k by season (fit on the seasons before):", JSON.stringify(out.kBySeason));
console.table([{ model: "Elo", ...out.elo }, { model: `Elo + ${LIVE_K} QB (live)`, ...out.eloLiveK }, { model: "Elo + out-of-sample k", ...out.eloOosK }]);
log("market MAE", out.marketMae, "| MAE gain, out of sample", out.maeGainOos, "| live k", out.maeGainLive);
console.log(`QB change games (|term| >= 2): ${changed.length}, market MAE ${out.qbChanged.marketMae}`);
console.table([{ model: "Elo", ...out.qbChanged.elo }, { model: "live k", ...out.qbChanged.eloLiveK }, { model: "out-of-sample k", ...out.qbChanged.eloOosK }]);
console.table(out.byGap);
