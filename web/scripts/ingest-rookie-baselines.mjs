/**
 * Draft-slot baselines from history, replacing the hand-set slot curve (Derek: "there's got to be some type of variable
 * that's consistent, not just made-up curve numbers").
 *
 * The question: is this rookie (or second-year player) producing more or less than players drafted in the same range,
 * at the same position, at the same point of the same season of their careers?
 *
 *   Production   DraftKings points per team game for QB, RB, WR, TE; IDP points per team game for defenders (solo
 *                tackle 1, assist 0.5, tackle for loss 1, sack 4, QB hit 1, interception 6, pass defended 1.5, forced
 *                fumble 3, TD 6, safety 2). Per TEAM game, so a game he sat or did not play counts as zero, the same way
 *                for history and for this season.
 *   Same point   through his team's first N games, N = the games his team has played this season.
 *   Comparables  every player drafted 2018 on (stats start in 2018) in the same position group and draft range, in the
 *                same career season: year 1 for rookies, year 2 for last year's class. Players who never got on the
 *                field count as zero, so the baseline is the honest one for a draft range, not just the ones who played.
 *   Ranges       top 10, rest of round 1, round 2, round 3, rounds 4-5, rounds 6-7. A range with fewer than 12
 *                comparables at the position is pooled with its neighbor and says so.
 *   Linemen, specialists, and undrafted players get no baseline (no box-score production for linemen; history has
 *   no complete list of undrafted rookies).
 *
 *   node scripts/ingest-rookie-baselines.mjs        writes data/generated/rookie-baselines.json and prints a check
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const GEN = path.join(root, "data", "generated");
const FIRST_STATS = 2018;
const MIN_COMPS = 12;

const meta = JSON.parse(await readFile(path.join(GEN, "meta.json"), "utf8"));
const SEASON = meta.season;

const TEAM = { GNB: "GB", KAN: "KC", LAR: "LA", LVR: "LV", NOR: "NO", NWE: "NE", SFO: "SF", TAM: "TB", STL: "LA", SDG: "LAC" };
const team = (t) => TEAM[t] ?? t;
const GROUP = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", DT: "DL", NT: "DL", DL: "DL", DE: "EDGE", OLB: "EDGE", EDGE: "EDGE", LB: "LB", ILB: "LB", MLB: "LB", CB: "CB", DB: "CB", S: "S", SAF: "S", FS: "S", SS: "S" };
const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);
const BANDS = [
  { k: "top10", rounds: [1, 1], label: "top-10 picks", test: (r, p) => r === 1 && p <= 10, mid: 5 },
  { k: "r1", rounds: [1, 1], label: "picks 11 to 32", test: (r, p) => r === 1 && p > 10, mid: 21 },
  { k: "r2", rounds: [2, 2], label: "round 2 picks", test: (r) => r === 2, mid: 48 },
  { k: "r3", rounds: [3, 3], label: "round 3 picks", test: (r) => r === 3, mid: 84 },
  { k: "r45", rounds: [4, 5], label: "round 4 and 5 picks", test: (r) => r === 4 || r === 5, mid: 140 },
  { k: "r67", rounds: [6, 7], label: "round 6 and 7 picks", test: (r) => r >= 6, mid: 210 },
];
const bandOf = (round, pick) => BANDS.findIndex((b) => b.test(round, pick));

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) + ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) + n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) - n("fumbles_lost_total") + n("special_teams_tds") * 6;
};
const idp = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  return n("def_tackles_solo") + n("def_tackle_assists") * 0.5 + n("def_tackles_for_loss") + n("def_sacks") * 4 + n("def_qb_hits") + n("def_interceptions") * 6 + n("def_pass_defended") * 1.5 + n("def_fumbles_forced") * 3 + n("def_tds") * 6 + n("def_safeties") * 2;
};

// Team schedules: the week of each regular-season game, in order; this season only games with a final score.
const teamWeeks = new Map(); // `${season}:${team}` -> sorted weeks
await readCsv(path.join(CACHE, "games.csv"), (r) => {
  const s = Number(r.season);
  if (s < FIRST_STATS || r.game_type !== "REG") return;
  if (s === SEASON && (r.result === "" || r.result === "NA")) return;
  for (const t of [r.home_team, r.away_team]) {
    const k = `${s}:${t}`;
    (teamWeeks.get(k) ?? teamWeeks.set(k, []).get(k)).push(Number(r.week));
  }
});
for (const w of teamWeeks.values()) w.sort((a, b) => a - b);

// Weekly production by season and player, with his team that season (first team he played for).
const weekly = new Map(); // season -> Map<gsis, { team, wk: Map<week, {dk, idp}> }>
for (let s = FIRST_STATS; s <= SEASON; s++) {
  const f = path.join(CACHE, `stats_player_week_${s}.csv`);
  if (!existsSync(f)) continue;
  const m = new Map();
  await readCsv(f, (r) => {
    if (r.season_type !== "REG") return;
    const e = m.get(r.player_id) ?? m.set(r.player_id, { team: r.team, first: Number(r.week), pos: new Map(), wk: new Map() }).get(r.player_id);
    if (r.position) e.pos.set(r.position, (e.pos.get(r.position) ?? 0) + 1);
    const w = Number(r.week);
    if (w < e.first) { e.first = w; e.team = r.team; }
    e.wk.set(w, { dk: dk(r), idp: idp(r) });
  });
  weekly.set(s, m);
}

// Picks with a position group we can score.
const picks = [];
await readCsv(path.join(CACHE, "draft_picks.csv"), (r) => {
  const year = Number(r.season);
  const group = GROUP[r.position];
  if (year < FIRST_STATS || !group) return;
  const round = Number(r.round), pick = Number(r.pick);
  picks.push({ year, round, pick, band: bandOf(round, pick), group, gsis: r.gsis_id || null, team: team(r.team), name: r.pfr_player_name, pos: r.position });
});

/** His position group in season s: the position he was listed at most that season, else his draft position. A player
 * moved to another position (a receiver drafted who plays corner) is compared with players at the position he plays. */
function groupIn(p, s) {
  const st = p.gsis ? weekly.get(s)?.get(p.gsis) : undefined;
  const top = st ? [...st.pos].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
  return (top && GROUP[top]) || p.group;
}

/** Points per team game through his team's first n games of season s (0 for a game he did not play). */
function perTeamGame(p, s, n) {
  const st = p.gsis ? weekly.get(s)?.get(p.gsis) : undefined;
  const t = st?.team ?? p.team;
  const weeks = teamWeeks.get(`${s}:${t}`);
  if (!weeks || weeks.length < n || n < 1) return undefined;
  const last = weeks[n - 1];
  let sum = 0;
  const g = groupIn(p, s);
  if (st) for (const [w, v] of st.wk) if (w <= last) sum += OFFENSE.has(g) ? v.dk : v.idp;
  return sum / n;
}

// Historical distributions: [classYear][group][band][n] -> sorted values. History is every finished season.
const hist = { 1: {}, 2: {} };
for (const cy of [1, 2]) {
  for (const p of picks) {
    const s = p.year + cy - 1;
    if (s >= SEASON || !weekly.has(s)) continue;
    const g = (hist[cy][groupIn(p, s)] ??= BANDS.map(() => []));
    for (let n = 1; n <= 16; n++) {
      const v = perTeamGame(p, s, n);
      if (v === undefined) continue;
      (g[p.band][n] ??= []).push(v);
    }
  }
  for (const g of Object.values(hist[cy])) for (const b of g) for (const arr of b) arr?.sort((a, b2) => a - b2);
}

const q = (arr, p) => {
  if (!arr.length) return 0;
  const i = (arr.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return arr[lo] + (arr[hi] - arr[lo]) * (i - lo);
};
const r1 = (x) => Math.round(x * 10) / 10;

/** The comparables for a band, pooled with neighbors until there are MIN_COMPS. */
function comps(cy, group, band, n) {
  const g = hist[cy][group];
  if (!g) return undefined;
  let lo = band, hi = band;
  const vals = () => BANDS.slice(lo, hi + 1).flatMap((_, i) => g[lo + i]?.[n] ?? []);
  while (vals().length < MIN_COMPS && (lo > 0 || hi < BANDS.length - 1)) {
    // Widen toward the side that keeps the range closest to his own pick.
    if (hi < BANDS.length - 1 && (lo === 0 || hi - band <= band - lo)) hi++;
    else lo--;
  }
  const v = vals().sort((a, b) => a - b);
  const a = BANDS[lo].rounds[0], z = BANDS[hi].rounds[1];
  const label = lo === hi ? BANDS[lo].label : a === z ? (a === 1 ? "first-round picks" : `round ${a} picks`) : `picks from rounds ${a} to ${z}`;
  return { v, label, lo, hi };
}

/** Typical (median) production per draft range at this point, forced to fall (or hold) as the range gets later. */
function typical(cy, group, n) {
  const g = hist[cy][group];
  if (!g) return [];
  const med = BANDS.map((_, i) => {
    const c = comps(cy, group, i, n);
    return c && c.v.length ? q(c.v, 0.5) : 0;
  });
  for (let i = 1; i < med.length; i++) med[i] = Math.min(med[i], med[i - 1]);
  return med;
}

// This season's rookies and second-year players.
const draftGen = JSON.parse(await readFile(path.join(GEN, "draft.json"), "utf8"));
const espnByGsis = new Map((Array.isArray(draftGen) ? draftGen : draftGen.picks).filter((p) => p.gsis && p.id).map((p) => [p.gsis, p.id]));
const players = {};
for (const p of picks) {
  const cy = SEASON - p.year + 1;
  if (cy !== 1 && cy !== 2) continue;
  const st = p.gsis ? weekly.get(SEASON)?.get(p.gsis) : undefined;
  const t = st?.team ?? p.team;
  const n = teamWeeks.get(`${SEASON}:${t}`)?.length ?? 0;
  if (!n) continue;
  const pts = perTeamGame(p, SEASON, n);
  const group = groupIn(p, SEASON);
  const c = comps(cy, group, p.band, Math.min(n, 16));
  if (pts === undefined || !c || !c.v.length) continue;
  const below = c.v.filter((x) => x < pts).length, ties = c.v.filter((x) => x === pts).length;
  const pctile = Math.round((100 * (below + 0.5 * ties)) / c.v.length);
  const med = typical(cy, group, Math.min(n, 16));
  // The latest range whose typical player he matches or beats: "producing like a typical round 2 pick".
  let like = pts > 0 ? med.findIndex((m) => pts >= m) : -2;
  if (like === -1) like = BANDS.length; // below a typical round 6-7 pick
  const id = (p.gsis && espnByGsis.get(p.gsis)) || null;
  const row = {
    gsis: p.gsis, name: p.name, group, classYear: cy, pick: p.pick, round: p.round,
    metric: OFFENSE.has(group) ? "DK" : "IDP", games: n, pts: r1(pts),
    comps: { label: c.label, n: c.v.length, median: r1(q(c.v, 0.5)), p25: r1(q(c.v, 0.25)), p75: r1(q(c.v, 0.75)) },
    pctile, vsSlot: pctile - 50,
    like: like === -2 ? "no production yet" : like === 0 ? "a typical top-10 pick or better" : like === BANDS.length ? "below a typical round 6 or 7 pick" : `a typical ${BANDS[like].label.replace(/s$/, "")}`,
    likePick: like === -2 ? null : like === BANDS.length ? 257 : BANDS[like].mid,
  };
  players[id ?? p.gsis] = row;
}

const out = { asOf: new Date().toISOString(), season: SEASON, minComps: MIN_COMPS, history: `${FIRST_STATS} to ${SEASON - 1}`, bands: BANDS.map((b) => b.label), players };
await writeFile(path.join(GEN, "rookie-baselines.json"), JSON.stringify(out));
console.log(`rookie baselines: ${Object.keys(players).length} players (season ${SEASON})`);

if (process.argv.includes("--check")) {
  // Does the draft range order production? Median per team game through 4 games and through 16, year 1.
  for (const g of ["QB", "RB", "WR", "TE", "EDGE", "DL", "LB", "CB", "S"]) {
    const row = (n) => BANDS.map((_, i) => {
      const arr = hist[1][g]?.[i]?.[n] ?? [];
      return `${r1(q(arr, 0.5))} (${arr.length})`;
    }).join(" | ");
    console.log(`${g.padEnd(4)} wk4:  ${row(4)}`);
    console.log(`${"".padEnd(4)} wk16: ${row(16)}`);
  }
  // Does a rookie's start carry? First 4 team games against the rest of his rookie season.
  const xs = [], ys = [];
  for (const p of picks) {
    if (p.year >= SEASON || !OFFENSE.has(p.group)) continue;
    const a = perTeamGame(p, p.year, 4), full = perTeamGame(p, p.year, 16);
    if (a === undefined || full === undefined) continue;
    xs.push(a); ys.push((full * 16 - a * 4) / 12);
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  console.log(`offense rookies, first 4 team games vs the other 12: r ${r1((sxy / Math.sqrt(sxx * syy)) * 100) / 100} over ${xs.length} players`);
}
