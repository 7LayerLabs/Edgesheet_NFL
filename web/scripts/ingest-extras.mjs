#!/usr/bin/env node
/**
 * The second ingest step: nflverse and ffverse feeds beyond the core files, digested into
 * data/generated/extras.json. Runs after scripts/ingest.mjs (it reads players.json for the id join).
 *
 *   node scripts/ingest-extras.mjs              (npm run ingest runs both)
 *   REFRESH=1 node scripts/ingest-extras.mjs    re-download every file
 *
 * Sources (all free, no key), cached in data/cache:
 *   pfr_advstats   PFR advanced weekly stats, this season and last: defense (targets and yards allowed, passer rating
 *                  allowed, blitzes, hurries, QB hits, sacks, pressures, tackles, missed tackles), rushing (yards
 *                  before and after contact, broken tackles), receiving (drops, broken tackles, rating when targeted),
 *                  passing (bad throws, times pressured, drops by his receivers)
 *   nextgen_stats  NFL Next Gen Stats season lines (week 0 rows, qualified players only): rushing (yards over
 *                  expected, 8+ defenders in the box, time to the line), receiving (separation, cushion, YAC over
 *                  expected, share of intended air yards), passing (time to throw, aggressiveness, completion % over
 *                  expected)
 *   ffopportunity  expected fantasy points per player-week from usage (ffverse), this season and last
 *   weekly_rosters this season's roster by week: who joined a team, came up from the practice squad, went to IR
 *   trades         every trade with its date (this season and last kept)
 *   combine        combine measurements by PFR id
 * Joins: PFR ids through the season rosters (pfr_id -> gsis_id), everything else on gsis, then to the app's
 * player id (ESPN id when known) through players.json. Sleeper ids from the rosters ride along for the
 * fantasy tools.
 */
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "generated");
const REFRESH = !!process.env.REFRESH;
const NV = "https://github.com/nflverse/nflverse-data/releases/download";
const FF = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";
const t0 = Date.now();
const log = (...a) => console.log(`[extras ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

const meta = JSON.parse(await readFile(path.join(OUT, "meta.json"), "utf8"));
const season = meta.season;
const prev = season - 1;
const teams = JSON.parse(await readFile(path.join(root, "data", "nfl-teams.json"), "utf8")).teams;
const ALIAS = { LAR: "LA", WSH: "WAS", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LA", GNB: "GB", KAN: "KC", LVR: "LV", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB", SDG: "LAC" };
const nick = (c) => teams.find((t) => t.code === (ALIAS[c] ?? c) || t.abbr === c)?.short ?? c;

async function get(url, name, { gz = false, optional = true } = {}) {
  const file = path.join(CACHE, name);
  if (!REFRESH && (await exists(file))) return file;
  log("download", name);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    if (optional) {
      log("skip", name, res.status);
      return (await exists(file)) ? file : undefined;
    }
    throw new Error(`${url} -> ${res.status}`);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  if (gz) buf = (await import("node:zlib")).gunzipSync(buf);
  await writeFile(`${file}.part`, buf);
  await rename(`${file}.part`, file);
  return file;
}

const files = {};
for (const y of [season, prev]) {
  for (const k of ["def", "rush", "rec", "pass"]) files[`adv_${k}_${y}`] = await get(`${NV}/pfr_advstats/advstats_week_${k}_${y}.csv`, `advstats_week_${k}_${y}.csv`);
  files[`ep_${y}`] = await get(`${FF}/ep_weekly_${y}.csv`, `ep_weekly_${y}.csv`);
}
for (const k of ["passing", "receiving", "rushing"]) files[`ngs_${k}`] = await get(`${NV}/nextgen_stats/ngs_${k}.csv.gz`, `ngs_${k}.csv`, { gz: true });
files.weekly = await get(`${NV}/weekly_rosters/roster_weekly_${season}.csv`, `roster_weekly_${season}.csv`);
files.trades = await get(`${NV}/trades/trades.csv`, "trades.csv");
files.combine = await get(`${NV}/combine/combine.csv`, "combine.csv");

/* ------------------------------------------------------------------ ids */
const players = JSON.parse(await readFile(path.join(OUT, "players.json"), "utf8"));
const idByGsis = new Map(players.filter((p) => p.gsis).map((p) => [p.gsis, p.id]));
const gsisByPfr = new Map();
const sleeperByGsis = new Map();
for (const y of [prev, season]) {
  const f = path.join(CACHE, `roster_${y}.csv`);
  if (!(await exists(f))) continue;
  await readCsv(f, (r) => {
    if (r.pfr_id && r.gsis_id) gsisByPfr.set(r.pfr_id, r.gsis_id);
    if (r.sleeper_id && r.gsis_id) sleeperByGsis.set(r.gsis_id, r.sleeper_id);
  });
}
const out = { asOf: new Date().toISOString(), season, players: {}, moves: [], trades: [], sources: {} };
const slot = (id) => (out.players[id] ??= {});
const idOfPfr = (pfr) => idByGsis.get(gsisByPfr.get(pfr));
for (const [gsis, sleeper] of sleeperByGsis) {
  const id = idByGsis.get(gsis);
  if (id) slot(id).sleeper = sleeper;
}

/* ------------------------------------------------------------- PFR adv */
// Weekly rows summed to a season per player. Rates are recomputed from the sums, never averaged.
const ADV = {
  def: { def_targets: "tgt", def_completions_allowed: "cmp", def_yards_allowed: "yds", def_receiving_td_allowed: "td", def_ints: "int", def_times_blitzed: "blitz", def_times_hurried: "hurry", def_times_hitqb: "hit", def_sacks: "sk", def_pressures: "press", def_tackles_combined: "tk", def_missed_tackles: "mtk" },
  rush: { carries: "att", rushing_yards_before_contact: "ybc", rushing_yards_after_contact: "yac", rushing_broken_tackles: "brk", receiving_broken_tackles: "rbrk" },
  rec: { receiving_drop: "drops", receiving_broken_tackles: "brk", receiving_int: "int" },
  pass: { passing_bad_throws: "bad", times_pressured: "press", times_blitzed: "blitz", times_hurried: "hurry", times_hit: "hit", times_sacked: "sk", passing_drops: "drops" },
};
let advRows = 0;
for (const y of [prev, season]) {
  for (const [kind, cols] of Object.entries(ADV)) {
    const f = files[`adv_${kind}_${y}`];
    if (!f) continue;
    const sums = new Map();
    await readCsv(f, (r) => {
      if (r.game_type && r.game_type !== "REG") return;
      const id = idOfPfr(r.pfr_player_id);
      if (!id) return;
      const s = sums.get(id) ?? sums.set(id, { g: 0 }).get(id);
      s.g++;
      for (const [col, key] of Object.entries(cols)) {
        const v = num(r[col]);
        if (v != null) s[key] = (s[key] ?? 0) + v;
      }
      advRows++;
    });
    for (const [id, s] of sums) {
      const p = slot(id);
      p.adv ??= {};
      p.adv[y] ??= {};
      for (const k of Object.keys(s)) s[k] = r1(s[k]);
      p.adv[y][kind] = s;
    }
  }
}
log("PFR advanced rows", advRows);

/* ------------------------------------------------------------- Next Gen */
const NGS = {
  rushing: { rush_attempts: "att", rush_yards_over_expected: "ryoe", rush_yards_over_expected_per_att: "ryoePer", percent_attempts_gte_eight_defenders: "box8", avg_time_to_los: "ttl", efficiency: "eff" },
  receiving: { targets: "tgt", avg_separation: "sep", avg_cushion: "cush", avg_yac_above_expectation: "yacx", percent_share_of_intended_air_yards: "airShare", avg_intended_air_yards: "iay" },
  passing: { attempts: "att", avg_time_to_throw: "ttt", aggressiveness: "agg", completion_percentage_above_expectation: "cpoe", avg_intended_air_yards: "iay" },
};
let ngsRows = 0;
for (const [kind, cols] of Object.entries(NGS)) {
  const f = files[`ngs_${kind}`];
  if (!f) continue;
  await readCsv(f, (r) => {
    const y = Number(r.season);
    if (r.week !== "0" || r.season_type !== "REG" || (y !== season && y !== prev)) return;
    const id = idByGsis.get(r.player_gsis_id);
    if (!id) return;
    const line = {};
    for (const [col, key] of Object.entries(cols)) {
      const v = num(r[col]);
      if (v != null) line[key] = r3(v);
    }
    const p = slot(id);
    p.ngs ??= {};
    p.ngs[y] ??= {};
    p.ngs[y][kind === "rushing" ? "rush" : kind === "receiving" ? "rec" : "pass"] = line;
    ngsRows++;
  });
}
log("Next Gen season lines", ngsRows);

/* --------------------------------------------------- expected fantasy points */
// ffopportunity scores PPR without DraftKings' 100/300-yard bonuses; kept per game so the DFS lens and its backtest
// can compare a player's points with what his usage was worth.
let epRows = 0;
for (const y of [prev, season]) {
  const f = files[`ep_${y}`];
  if (!f) continue;
  await readCsv(f, (r) => {
    const id = idByGsis.get(r.player_id);
    if (!id) return;
    const xfp = num(r.total_fantasy_points_exp);
    const fp = num(r.total_fantasy_points);
    if (xfp == null) return;
    const p = slot(id);
    (p.xfp ??= []).push([y, Number(r.week), r1(xfp), r1(fp ?? 0)]);
    epRows++;
  });
}
for (const p of Object.values(out.players)) p.xfp?.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
log("expected fantasy point lines", epRows);

/* ------------------------------------------------------------- combine */
let combineRows = 0;
// Rookies often have no PFR id on the roster yet, so fall back to name plus draft class (rookie year), unique matches only.
const normName = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const byNameYear = new Map();
for (const p of players) {
  const k = `${normName(p.n)}|${p.r?.yr ?? ""}`;
  byNameYear.set(k, byNameYear.has(k) ? null : p.id);
}
if (files.combine) {
  await readCsv(files.combine, (r) => {
    const id = (r.pfr_id ? idOfPfr(r.pfr_id) : undefined) ?? byNameYear.get(`${normName(r.player_name)}|${r.draft_year || r.season}`) ?? undefined;
    if (!id) return;
    const c = { yr: Number(r.draft_year || r.season) || undefined, ht: r.ht || undefined, wt: num(r.wt) ?? undefined, forty: num(r.forty) ?? undefined, vert: num(r.vertical) ?? undefined, broad: num(r.broad_jump) ?? undefined, bench: num(r.bench) ?? undefined, cone: num(r.cone) ?? undefined, shuttle: num(r.shuttle) ?? undefined };
    if (c.forty == null && c.vert == null && c.broad == null && c.bench == null && c.cone == null && c.shuttle == null) return;
    slot(id).combine = c;
    combineRows++;
  });
}
log("combine players", combineRows);

/* ------------------------------------------------------- weekly rosters */
// Week-over-week changes this season. A player on a team's active list, inactive list, or practice squad in week w
// who was on another team in the week before joined from that team; one on no roster the week before signed; a
// practice-squad player now active was promoted; an active player now on reserve went to IR or another reserve list.
if (files.weekly) {
  const byPlayer = new Map();
  await readCsv(files.weekly, (r) => {
    if (r.game_type !== "REG" || !r.gsis_id) return;
    const arr = byPlayer.get(r.gsis_id) ?? byPlayer.set(r.gsis_id, []).get(r.gsis_id);
    arr.push({ wk: Number(r.week), team: nick(r.team), status: r.status, name: r.full_name, pos: r.position });
  });
  const ON = new Set(["ACT", "INA", "DEV"]);
  for (const [gsis, rows] of byPlayer) {
    rows.sort((a, b) => a.wk - b.wk);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      const base = { id: idByGsis.get(gsis) ?? gsis, name: b.name, pos: b.pos, team: b.team, week: b.wk };
      if (b.team !== a.team && ON.has(b.status)) out.moves.push({ ...base, kind: "joined", from: a.team });
      else if (b.team === a.team && a.status === "DEV" && (b.status === "ACT" || b.status === "INA")) out.moves.push({ ...base, kind: "promoted" });
      else if (b.team === a.team && (a.status === "ACT" || a.status === "INA") && b.status === "RES") out.moves.push({ ...base, kind: "reserve" });
    }
    const first = rows[0];
    if (first.wk > 1 && ON.has(first.status)) out.moves.push({ id: idByGsis.get(gsis) ?? gsis, name: first.name, pos: first.pos, team: first.team, week: first.wk, kind: "signed" });
  }
  out.moves.sort((a, b) => b.week - a.week || a.team.localeCompare(b.team));
  log("roster moves", out.moves.length);
}

/* --------------------------------------------------------------- trades */
if (files.trades) {
  const byId = new Map();
  await readCsv(files.trades, (r) => {
    const y = Number(r.season);
    if (y !== season && y !== prev) return;
    const t = byId.get(r.trade_id) ?? byId.set(r.trade_id, { date: r.trade_date, season: y, items: [] }).get(r.trade_id);
    // Each row is one asset moving: from `gave` to `received`; players carry a PFR id, picks a season and round.
    if (r.pfr_name) t.items.push({ from: nick(r.gave), to: nick(r.received), player: r.pfr_name, id: r.pfr_id ? idOfPfr(r.pfr_id) : undefined });
    else if (r.pick_season) t.items.push({ from: nick(r.gave), to: nick(r.received), pick: `${r.pick_season} round ${r.pick_round}${r.conditional === "1" || r.conditional === "TRUE" ? " (conditional)" : ""}` });
  });
  out.trades = [...byId.values()].filter((t) => t.items.length).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  log("trades this season and last", out.trades.length);
}

out.sources = { pfr: Boolean(files[`adv_def_${season}`]), ngs: Boolean(files.ngs_rushing), xfp: Boolean(files[`ep_${season}`]), weekly: Boolean(files.weekly), trades: Boolean(files.trades), combine: Boolean(files.combine) };
const json = JSON.stringify(out);
await writeFile(path.join(OUT, "extras.json"), json);
log("wrote extras.json", `${(json.length / 1e6).toFixed(2)} MB`, Object.keys(out.players).length, "players");
