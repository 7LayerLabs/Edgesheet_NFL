#!/usr/bin/env node
/**
 * Fit the fourth-down decision model (src/lib/fourth-core.mjs) and write data/generated/fourth-model.json.
 *
 *   node scripts/fourth-fit.mjs
 *
 * Reads nflverse play-by-play 2018 to 2025 (regular season) from data/cache (play_by_play_<year>.csv.gz, downloaded
 * if missing), one season at a time, keeping only the columns it needs.
 *
 * What it fits, in plain words:
 *   Win probability   a logistic model per time segment that learns nflfastR's own vegas_wp (the win probability
 *                     nflverse publishes, which already knows the pregame spread) from the game state. "Distilled"
 *                     means the target is nflfastR's number, not the final result; the final result is used to check
 *                     calibration. Checked out of sample first: fit on 2018 to 2024, scored on 2025; then refit on all
 *                     eight seasons for the app.
 *   Going for it      chance of converting a fourth down by yards to go (logistic on log yards, goal-to-go, and 4th and
 *                     1), from every fourth-down run or pass with a recorded conversion or failure; also checked on 2025
 *                     with a 2018 to 2024 fit. The yards a conversion gains on average, by yards to go, from third and
 *                     fourth down conversions away from the goal line.
 *   Field goals       chance of a make by kick distance (logistic on distance and distance squared).
 *   Punts             where the opponent starts after a punt from each 5-yard band (touchbacks at the 20).
 * Every piece keeps its sample size in the file.
 */
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamCsv } from "./lib/csv-stream.mjs";
import { FEATURES, SEGMENTS, features, segmentOf, stateOf } from "../src/lib/fourth-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "generated");
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const HOLDOUT = 2025;
const t0 = Date.now();
const log = (...a) => console.log(`[fourth ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

const KEEP = ["season", "season_type", "game_id", "posteam", "home_team", "qtr", "game_seconds_remaining", "yardline_100", "down", "ydstogo", "score_differential", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "spread_line", "play_type", "fourth_down_converted", "fourth_down_failed", "field_goal_result", "kick_distance", "return_yards", "touchback", "punt_blocked", "vegas_wp", "result", "yards_gained", "penalty"];

async function pbpFile(y) {
  const name = `play_by_play_${y}.csv.gz`;
  const f = path.join(CACHE, name);
  if (await exists(f)) return f;
  log("download", name);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/pbp/${name}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  await writeFile(`${f}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${f}.part`, f);
  return f;
}

/* -------------------------------------------------------- growable rows */
const K = FEATURES.length;
const W = K + 3; // features, target, outcome, season
function store() {
  return { buf: new Float32Array(W * 65536), n: 0 };
}
function push(s, x, target, outcome, season) {
  if ((s.n + 1) * W > s.buf.length) {
    const nb = new Float32Array(s.buf.length * 2);
    nb.set(s.buf);
    s.buf = nb;
  }
  const o = s.n * W;
  for (let i = 0; i < K; i++) s.buf[o + i] = x[i];
  s.buf[o + K] = target;
  s.buf[o + K + 1] = outcome;
  s.buf[o + K + 2] = season;
  s.n++;
}

const segs = SEGMENTS.map(() => store());
const goRows = []; // [season, togo, yl, converted]
const gainRows = []; // [togo, gain]
const fgRows = []; // [season, dist, made]
const puntBins = new Map(); // lo -> { n, sum, tb }

const num = (v) => (v === "" || v === "NA" || v === undefined ? NaN : Number(v));
for (const y of SEASONS) {
  const f = await pbpFile(y);
  let plays = 0;
  await streamCsv(
    f,
    (r) => {
      if (r.season_type !== "REG" || num(r.qtr) > 4) return;
      const st = stateOf(r);
      const pt = r.play_type;
      // Win probability rows: scrimmage plays with nflfastR's vegas_wp and a final result.
      const vw = num(r.vegas_wp);
      const res = num(r.result);
      if (st && Number.isFinite(vw) && Number.isFinite(res) && st.gsr > 0 && (pt === "run" || pt === "pass" || pt === "punt" || pt === "field_goal" || pt === "no_play")) {
        const home = r.posteam === r.home_team;
        const outcome = res === 0 ? 0.5 : (home ? res > 0 : res < 0) ? 1 : 0;
        push(segs[segmentOf(st.gsr)], features(st), Math.min(0.999, Math.max(0.001, vw)), outcome, y);
        plays++;
      }
      if (!st) return;
      if (st.down === 4 && (pt === "run" || pt === "pass") && num(r.penalty) !== 1) {
        const conv = num(r.fourth_down_converted) === 1 ? 1 : num(r.fourth_down_failed) === 1 ? 0 : NaN;
        if (Number.isFinite(conv)) goRows.push([y, st.togo, st.yl, conv]);
      }
      if ((st.down === 3 || st.down === 4) && (pt === "run" || pt === "pass") && num(r.penalty) !== 1 && st.yl > st.togo) {
        const g = num(r.yards_gained);
        if (Number.isFinite(g) && g >= st.togo) gainRows.push([st.togo, Math.min(g, st.yl - 1)]);
      }
      if (pt === "field_goal") {
        const d = num(r.kick_distance);
        const fr = r.field_goal_result;
        if (Number.isFinite(d) && (fr === "made" || fr === "missed" || fr === "blocked")) fgRows.push([y, d, fr === "made" ? 1 : 0]);
      }
      if (pt === "punt" && num(r.punt_blocked) !== 1 && st.yl >= 30) {
        const kd = num(r.kick_distance);
        if (!Number.isFinite(kd)) return;
        const tb = num(r.touchback) === 1;
        const ret = num(r.return_yards);
        const oppYl = tb ? 80 : Math.max(1, Math.min(99, 100 - st.yl + kd - (Number.isFinite(ret) ? ret : 0)));
        const lo = Math.floor(st.yl / 5) * 5;
        const b = puntBins.get(lo) ?? puntBins.set(lo, { n: 0, sum: 0, tb: 0 }).get(lo);
        b.n++;
        b.sum += oppYl;
        b.tb += tb ? 1 : 0;
      }
    },
    KEEP,
  );
  log("season", y, "wp rows", plays, "go attempts so far", goRows.length);
}

/* ------------------------------------------------------------ solvers */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Logistic regression with soft labels by Newton steps; rows pass the filter `use(season)`. Ridge on all but the intercept. */
function fitLogistic(get, n, k, use, { iters = 25, ridge = 1 } = {}) {
  let w = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    const g = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const row = get(i);
      if (!use(row.season)) continue;
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j] * row.x[j];
      const q = 1 / (1 + Math.exp(-z));
      const e = q - row.y;
      const v = Math.max(q * (1 - q), 1e-6);
      for (let j = 0; j < k; j++) {
        g[j] += e * row.x[j];
        const vx = v * row.x[j];
        for (let m = j; m < k; m++) H[j][m] += vx * row.x[m];
      }
    }
    for (let j = 0; j < k; j++) {
      for (let m = 0; m < j; m++) H[j][m] = H[m][j];
      if (j > 0) {
        H[j][j] += ridge;
        g[j] += ridge * w[j];
      }
    }
    const step = solve(H, g);
    let moved = 0;
    w = w.map((wj, j) => {
      moved = Math.max(moved, Math.abs(step[j]));
      return wj - step[j];
    });
    if (moved < 1e-6) break;
  }
  return w;
}

const segRow = (s) => (i) => {
  const o = i * W;
  return { x: s.buf.subarray(o, o + K), y: s.buf[o + K], season: s.buf[o + K + 2], outcome: s.buf[o + K + 1] };
};

/* ------------------------------------------------- win probability: holdout */
const fitAll = (use) => segs.map((s) => fitLogistic(segRow(s), s.n, K, use));
const trainW = fitAll((y) => y !== HOLDOUT);
let ae = 0, n = 0;
const segAe = SEGMENTS.map(() => ({ ae: 0, n: 0 }));
const buckets = Array.from({ length: 10 }, () => ({ n: 0, model: 0, nflfastr: 0, won: 0 }));
segs.forEach((s, si) => {
  const get = segRow(s);
  for (let i = 0; i < s.n; i++) {
    const row = get(i);
    if (row.season !== HOLDOUT) continue;
    let z = 0;
    for (let j = 0; j < K; j++) z += trainW[si][j] * row.x[j];
    const q = 1 / (1 + Math.exp(-z));
    ae += Math.abs(q - row.y);
    n++;
    segAe[si].ae += Math.abs(q - row.y);
    segAe[si].n++;
    const b = buckets[Math.min(9, Math.floor(q * 10))];
    b.n++;
    b.model += q;
    b.nflfastr += row.y;
    b.won += row.outcome;
  }
});
const r3 = (x) => Math.round(x * 1000) / 1000;
const holdout = {
  season: HOLDOUT,
  plays: n,
  maeVsNflfastr: r3(ae / n),
  bySegment: SEGMENTS.map((sg, i) => ({ segment: sg.name, plays: segAe[i].n, mae: r3(segAe[i].ae / Math.max(1, segAe[i].n)) })),
  calibration: buckets.map((b, i) => ({ bucket: `${i * 10}-${i * 10 + 10}%`, plays: b.n, model: b.n ? r3(b.model / b.n) : null, nflfastr: b.n ? r3(b.nflfastr / b.n) : null, won: b.n ? r3(b.won / b.n) : null })),
};
log("WP holdout", HOLDOUT, "plays", n, "MAE vs nflfastR", holdout.maeVsNflfastr);

/* ------------------------------------------------ win probability: final */
const finalW = fitAll(() => true);

/* -------------------------------------------------------- going for it */
const goX = (togo, yl) => [1, Math.log(Math.max(1, togo)), togo >= yl ? 1 : 0, togo <= 1 ? 1 : 0];
const goGet = (i) => ({ x: goX(goRows[i][1], goRows[i][2]), y: goRows[i][3], season: goRows[i][0] });
const goTrain = fitLogistic(goGet, goRows.length, 4, (y) => y !== HOLDOUT, { ridge: 0.1 });
const goFinal = fitLogistic(goGet, goRows.length, 4, () => true, { ridge: 0.1 });
const TOGO_BINS = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 7], [8, 10], [11, 99]];
const sig = (z) => 1 / (1 + Math.exp(-z));
const goCal = TOGO_BINS.map(([lo, hi]) => {
  const all = goRows.filter((r) => r[1] >= lo && r[1] <= hi);
  const test = all.filter((r) => r[0] === HOLDOUT);
  const pred = test.reduce((a, r) => a + sig(goTrain.reduce((s, c, j) => s + c * goX(r[1], r[2])[j], 0)), 0);
  return { yardsToGo: hi === 99 ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`, attempts: all.length, converted: r3(all.reduce((a, r) => a + r[3], 0) / Math.max(1, all.length)), holdoutAttempts: test.length, holdoutPredicted: test.length ? r3(pred / test.length) : null, holdoutActual: test.length ? r3(test.reduce((a, r) => a + r[3], 0) / test.length) : null };
});
const GAIN_BINS = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 7], [8, 10], [11, 15], [16, 99]];
const gain = GAIN_BINS.map(([lo, hi]) => {
  const xs = gainRows.filter((r) => r[0] >= lo && r[0] <= hi);
  return { lo, hi, mean: xs.length ? Math.round((xs.reduce((a, r) => a + r[1], 0) / xs.length) * 10) / 10 : lo + 4, n: xs.length };
});

/* --------------------------------------------------------- field goals */
const fgX = (d) => [1, d / 10, (d / 10) ** 2];
const fgGet = (i) => ({ x: fgX(fgRows[i][1]), y: fgRows[i][2], season: fgRows[i][0] });
const fgTrain = fitLogistic(fgGet, fgRows.length, 3, (y) => y !== HOLDOUT, { ridge: 0.01 });
const fgFinal = fitLogistic(fgGet, fgRows.length, 3, () => true, { ridge: 0.01 });
const FG_BINS = [[18, 29], [30, 39], [40, 44], [45, 49], [50, 54], [55, 59], [60, 70]];
const fgCal = FG_BINS.map(([lo, hi]) => {
  const all = fgRows.filter((r) => r[1] >= lo && r[1] <= hi);
  const test = all.filter((r) => r[0] === HOLDOUT);
  const pred = test.reduce((a, r) => a + sig(fgTrain.reduce((s, c, j) => s + c * fgX(r[1])[j], 0)), 0);
  return { yards: `${lo}-${hi}`, attempts: all.length, made: r3(all.reduce((a, r) => a + r[2], 0) / Math.max(1, all.length)), holdoutAttempts: test.length, holdoutPredicted: test.length ? r3(pred / test.length) : null, holdoutActual: test.length ? r3(test.reduce((a, r) => a + r[2], 0) / test.length) : null };
});
const maxDistance = Math.max(...fgRows.filter((r) => r[2] === 1).map((r) => r[1]));

/* --------------------------------------------------------------- punts */
const puntTable = [...puntBins.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([lo, b]) => ({ lo, hi: lo + 4, oppYl: Math.round((b.sum / b.n) * 10) / 10, touchback: r3(b.tb / b.n), n: b.n }));

const r5 = (x) => Math.round(x * 100000) / 100000;
const model = {
  builtAt: new Date().toISOString(),
  seasons: SEASONS,
  wp: { segments: finalW.map((w) => w.map(r5)), features: FEATURES, segmentNames: SEGMENTS.map((s) => s.name), plays: segs.reduce((a, s) => a + s.n, 0), holdout },
  go: { coef: goFinal.map(r5), gain, attempts: goRows.length, byTogo: goCal },
  fg: { coef: fgFinal.map(r5), maxDistance, attempts: fgRows.length, byDistance: fgCal },
  punt: { table: puntTable, punts: puntTable.reduce((a, b) => a + b.n, 0) },
};
await mkdir(OUT, { recursive: true });
const json = JSON.stringify(model);
await writeFile(path.join(OUT, "fourth-model.json"), json);
log("wrote fourth-model.json", `${(json.length / 1024).toFixed(1)} KB`, "go attempts", goRows.length, "field goals", fgRows.length, "punts", model.punt.punts);
console.table(holdout.bySegment);
console.table(holdout.calibration);
console.table(goCal);
console.table(fgCal);
console.table(puntTable);
