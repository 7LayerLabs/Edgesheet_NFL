/**
 * Splits backtest: home/away, division, primetime, short week, and "he loves playing this team". Do they exist across the
 * league, and does a player's or team's own split carry into the next sample?
 * Run: npx tsx scripts/backtest-splits.mts   (writes data/backtest/splits.json)
 *
 * RULES, written before the first run (2026-10-05) and not changed after seeing results:
 *   Seasons 2019-2025, regular season. Splits: home (vs away; neutral games out), division (div_game), primetime (kickoff
 *   7 PM ET or later), short week (his team's rest 4 days or fewer).
 *   Players (QB/RB/WR/TE, player-seasons with 5+ games): residual = DraftKings points minus his average in his other games
 *     that season. Teams: residual = points scored minus the closing implied team total ((total +/- spread) / 2; nflverse
 *     spread_line is the home margin). Defenses: residual = DraftKings DST points (src/lib/dst-core.mjs) minus the
 *     defense's average in its other games that season; plus the home-and-division split (the "Pittsburgh at home against
 *     a division rival" case).
 *   1. League-wide: mean residual in the split minus out of it, 95% bootstrap interval (2,000 resamples, seed 11).
 *   2. Does a player's own split carry over? Players with 3+ games in the split and 6+ out of it in both 2019-2021 and
 *      2022-2025: correlation of his split (mean in minus mean out) between the two halves. Teams and defenses: each
 *      team's split in season N against season N+1 (same minimums per season: 2 in, 4 out).
 *   3. "Loves playing them": for each player game with 2+ earlier games against the same opponent since 2019, his mean
 *      residual in those earlier games against his residual in this one: correlation and slope.
 *   PASS for 2 and 3: correlation 0.15 or more and the 95% bootstrap interval above zero. A split that passes earns a flag
 *   on the site; one that fails is shown as history with "did not carry over in 2019-2025".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCsv } from "./lib/csv.mjs";
import { dkPoints } from "../src/lib/dfs";
import { dstPoints, teamWeeks } from "../src/lib/dst-core.mjs";
import type { StatLine } from "../src/lib/generated";

const CACHE = path.join(process.cwd(), "data", "cache");
const FIRST = 2019;
const LAST = 2025;
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
const CANON: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };
const canon = (c: string) => CANON[c] ?? c;
const num = (v: string | undefined) => (v === undefined || v === "" || v === "NA" ? 0 : Number(v) || 0);
type Row = Record<string, string>;
type Split = "home" | "division" | "primetime" | "short";
const SPLITS: Split[] = ["home", "division", "primetime", "short"];

// ---------------------------------------------------------------- games
interface Game { season: number; week: number; home: string; away: string; neutral: boolean; div: boolean; prime: boolean; hr: number; ar: number; hs: number; as: number; spread: number; total: number }
const games = new Map<string, Game>();
for (const r of (await readCsv(path.join(CACHE, "games.csv"))) as Row[]) {
  const y = Number(r.season);
  if (y < FIRST || y > LAST || r.game_type !== "REG" || r.home_score === "" || r.home_score === "NA") continue;
  games.set(r.game_id, {
    season: y, week: Number(r.week), home: canon(r.home_team), away: canon(r.away_team), neutral: r.location === "Neutral", div: r.div_game === "1",
    prime: (r.gametime ?? "") >= "19:00", hr: num(r.home_rest), ar: num(r.away_rest), hs: num(r.home_score), as: num(r.away_score), spread: num(r.spread_line), total: num(r.total_line),
  });
}
/** The split flags for one side of a game; home is undefined at a neutral site. */
function flags(g: Game, team: string): Record<Split, boolean | undefined> {
  const isHome = team === g.home;
  return { home: g.neutral ? undefined : isHome, division: g.div, primetime: g.prime, short: (isHome ? g.hr : g.ar) <= 4 };
}

// ---------------------------------------------------------------- player lines and DST team-weeks
interface P { pid: string; season: number; week: number; team: string; opp: string; f: Record<Split, boolean | undefined>; dk: number; resid?: number }
const players: P[] = [];
interface D { team: string; season: number; week: number; f: Record<Split, boolean | undefined>; dst: number; resid?: number }
const dsts: D[] = [];
for (let y = FIRST; y <= LAST; y++) {
  const rows = (await readCsv(path.join(CACHE, `stats_player_week_${y}.csv`))) as Row[];
  const byGame = new Map<string, Game>();
  const dstRows: { week: number; team: string; opp: string; sk: number; int: number; fr: number; dtd: number; sttd: number; saf: number; give: number; sks: number }[] = [];
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const g = games.get(r.game_id);
    if (!g) continue;
    const team = canon(r.team);
    byGame.set(`${r.week}|${team}`, g);
    const n = (k: string) => num(r[k]);
    dstRows.push({ week: Number(r.week), team, opp: canon(r.opponent_team), sk: n("def_sacks"), int: n("def_interceptions"), fr: n("fumble_recovery_opp"), dtd: n("def_tds"), sttd: n("special_teams_tds"), saf: n("def_safeties"), give: n("passing_interceptions") + n("fumbles_lost_total"), sks: n("sacks_suffered") });
    if (!SKILL.has(r.position) || !r.player_id) continue;
    const st: StatLine = { py: n("passing_yards"), ptd: n("passing_tds"), pint: n("passing_interceptions"), ry: n("rushing_yards"), rtd: n("rushing_tds"), rec: n("receptions"), rcy: n("receiving_yards"), rctd: n("receiving_tds"), fl: n("fumbles_lost_total"), sttd: n("special_teams_tds") };
    players.push({ pid: r.player_id, season: y, week: Number(r.week), team, opp: canon(r.opponent_team), f: flags(g, team), dk: dkPoints(st) });
  }
  for (const w of teamWeeks(dstRows).values()) {
    const g = byGame.get(`${w.week}|${w.team}`);
    if (!g) continue;
    const oppScore = w.team === g.home ? g.as : g.hs;
    dsts.push({ team: w.team, season: y, week: w.week, f: flags(g, w.team), dst: dstPoints(w, oppScore) });
  }
}
// Residuals against the average of the other games that season.
function residuals<T extends { season: number; resid?: number }>(xs: T[], key: (x: T) => string, val: (x: T) => number, min: number) {
  const by = new Map<string, T[]>();
  for (const x of xs) (by.get(`${key(x)}|${x.season}`) ?? by.set(`${key(x)}|${x.season}`, []).get(`${key(x)}|${x.season}`)!).push(x);
  for (const gs of by.values()) {
    if (gs.length < min) continue;
    const total = gs.reduce((t, x) => t + val(x), 0);
    for (const x of gs) x.resid = val(x) - (total - val(x)) / (gs.length - 1);
  }
}
residuals(players, (x) => x.pid, (x) => x.dk, 5);
residuals(dsts, (x) => x.team, (x) => x.dst, 5);
// Teams: points against the closing implied total.
interface T { team: string; season: number; week: number; f: Record<Split, boolean | undefined>; resid: number }
const teams: T[] = [];
for (const g of games.values()) {
  const impliedHome = (g.total + g.spread) / 2;
  teams.push({ team: g.home, season: g.season, week: g.week, f: flags(g, g.home), resid: g.hs - impliedHome });
  teams.push({ team: g.away, season: g.season, week: g.week, f: flags(g, g.away), resid: g.as - (g.total - impliedHome) });
}
const P_ = players.filter((x) => x.resid !== undefined);
const D_ = dsts.filter((x) => x.resid !== undefined);
console.log(`players: ${P_.length} games; defenses: ${D_.length} team-games; teams: ${teams.length} team-games; ${FIRST}-${LAST}`);

// ---------------------------------------------------------------- stats helpers
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;
function corr(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}
function bootCorr(pairs: [number, number][], seed: number) {
  const rand = mulberry32(seed);
  const rs: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const s = pairs.map(() => pairs[Math.floor(rand() * pairs.length)]);
    rs.push(corr(s.map((p) => p[0]), s.map((p) => p[1])));
  }
  rs.sort((x, y) => x - y);
  return [rs[50], rs[1949]] as [number, number];
}
function slope(pairs: [number, number][]) {
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx ? sxy / sxx : NaN;
}
function leagueWide(xs: { f: Record<Split, boolean | undefined>; resid?: number }[], s: Split | "home-division", seed: number) {
  const inS = (x: (typeof xs)[number]) => (s === "home-division" ? x.f.home === true && x.f.division : x.f[s]);
  const a = xs.filter((x) => inS(x) === true).map((x) => x.resid!);
  const b = xs.filter((x) => (s === "home-division" ? x.f.home !== undefined && !inS(x) : x.f[s] === false)).map((x) => x.resid!);
  const rand = mulberry32(seed);
  const ds: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sa = 0, sb = 0;
    const na = a.length, nb = Math.min(b.length, 5000);
    for (let k = 0; k < na; k++) sa += a[Math.floor(rand() * na)];
    for (let k = 0; k < nb; k++) sb += b[Math.floor(rand() * b.length)];
    ds.push(sa / na - sb / nb);
  }
  ds.sort((x, y) => x - y);
  return { nIn: a.length, nOut: b.length, inMean: r2(mean(a)), outMean: r2(mean(b)), diff: r2(mean(a) - mean(b)), ci: [r2(ds[50]), r2(ds[1949])] };
}
/** Each unit's split (mean in minus mean out) in sample A against sample B; correlation across units. */
function carryOver<X extends { f: Record<Split, boolean | undefined>; resid?: number }>(xs: X[], s: Split | "home-division", unit: (x: X) => string, sample: (x: X) => string | undefined, nextOf: (a: string) => string, minIn: number, minOut: number, seed: number) {
  const inS = (x: X) => (s === "home-division" ? x.f.home === true && x.f.division : x.f[s] === true);
  const outS = (x: X) => (s === "home-division" ? x.f.home !== undefined && !inS(x) : x.f[s] === false);
  const cells = new Map<string, { i: number[]; o: number[] }>();
  for (const x of xs) {
    const sm = sample(x);
    if (sm === undefined) continue;
    const k = `${unit(x)}|${sm}`;
    const c = cells.get(k) ?? cells.set(k, { i: [], o: [] }).get(k)!;
    if (inS(x)) c.i.push(x.resid!);
    else if (outS(x)) c.o.push(x.resid!);
  }
  const split = (c?: { i: number[]; o: number[] }) => (c && c.i.length >= minIn && c.o.length >= minOut ? mean(c.i) - mean(c.o) : undefined);
  const pairs: [number, number][] = [];
  for (const [k, c] of cells) {
    const [u, sm] = k.split("|");
    const a = split(c);
    const b = split(cells.get(`${u}|${nextOf(sm)}`));
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }
  if (pairs.length < 20) return { pairs: pairs.length, r: null, ci: null, pass: false };
  const r = corr(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const ci = bootCorr(pairs, seed);
  return { pairs: pairs.length, r: r2(r), ci: [r2(ci[0]), r2(ci[1])], pass: r >= 0.15 && ci[0] > 0 };
}

// ---------------------------------------------------------------- run
const half = (x: { season: number }) => (x.season <= 2021 ? "A" : "B");
const out: Record<string, unknown> = {};
let seed = 11;
for (const [label, xs] of [["players", P_], ["teams", teams], ["defenses", D_]] as const) {
  const res: Record<string, unknown> = {};
  const list: (Split | "home-division")[] = label === "defenses" ? [...SPLITS, "home-division"] : SPLITS;
  for (const s of list) {
    const lw = leagueWide(xs as { f: Record<Split, boolean | undefined>; resid?: number }[], s, seed++);
    const co =
      label === "players"
        ? carryOver(P_, s, (x) => x.pid, half, (a) => (a === "A" ? "B" : "Z"), 3, 6, seed++)
        : carryOver(xs as (T | D)[], s, (x) => x.team, (x) => String(x.season), (a) => String(Number(a) + 1), 2, 4, seed++);
    res[s] = { leagueWide: lw, carryOver: co };
  }
  out[label] = res;
}

// "Loves playing them": earlier games against the same opponent (2+) against this game.
const byPair = new Map<string, P[]>();
for (const x of [...P_].sort((a, b) => a.season - b.season || a.week - b.week)) (byPair.get(`${x.pid}|${x.opp}`) ?? byPair.set(`${x.pid}|${x.opp}`, []).get(`${x.pid}|${x.opp}`)!).push(x);
const bvp: [number, number][] = [];
for (const gs of byPair.values()) for (let i = 2; i < gs.length; i++) bvp.push([mean(gs.slice(0, i).map((x) => x.resid!)), gs[i].resid!]);
const bvpR = corr(bvp.map((p) => p[0]), bvp.map((p) => p[1]));
const bvpCi = bootCorr(bvp, 99);
out.vsOpponent = { pairs: bvp.length, r: r2(bvpR), ci: [r2(bvpCi[0]), r2(bvpCi[1])], slope: r2(slope(bvp)), pass: bvpR >= 0.15 && bvpCi[0] > 0 };

// ---------------------------------------------------------------- print and save
for (const label of ["players", "teams", "defenses"]) {
  console.log(`\n${label.toUpperCase()}           league-wide: in - out [95% CI]            carries over: r [95% CI] (pairs)`);
  for (const [s, v] of Object.entries(out[label] as Record<string, { leagueWide: ReturnType<typeof leagueWide>; carryOver: ReturnType<typeof carryOver> }>)) {
    const lw = v.leagueWide, co = v.carryOver;
    console.log(`  ${s.padEnd(14)} ${lw.diff.toFixed(2).padStart(6)} [${lw.ci[0].toFixed(2)}, ${lw.ci[1].toFixed(2)}]  n ${lw.nIn}/${lw.nOut}`.padEnd(62) + (co.r === null ? `too few (${co.pairs})` : `${co.r.toFixed(2)} [${co.ci![0].toFixed(2)}, ${co.ci![1].toFixed(2)}] (${co.pairs}) ${co.pass ? "PASS" : "no"}`));
  }
}
const v = out.vsOpponent as { pairs: number; r: number; ci: number[]; slope: number; pass: boolean };
console.log(`\nLOVES PLAYING THEM: r ${v.r} [${v.ci[0]}, ${v.ci[1]}], slope ${v.slope} DK per DK, ${v.pairs} games ${v.pass ? "PASS" : "no"}`);
mkdirSync(path.join(process.cwd(), "data", "backtest"), { recursive: true });
writeFileSync(path.join(process.cwd(), "data", "backtest", "splits.json"), JSON.stringify({ ranAt: new Date().toISOString(), seasons: [FIRST, LAST], rule: "carry-over and loves-playing-them pass = correlation 0.15+ with the 95% bootstrap interval above zero", ...out }, null, 1));
console.log("\nwrote data/backtest/splits.json");
