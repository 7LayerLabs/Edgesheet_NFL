/**
 * Inputs for the full replay of the live side model (audit 2026-10-12, items 2.1, 3.4 and 4.2), rebuilt walk-forward
 * from nflverse files and cached in data/cache/replay/replay-<season>.json. Read by scripts/backtest-replay.mjs.
 *
 *   node scripts/replay-build.mjs              # 2019..2025
 *   SEASONS=2024 node scripts/replay-build.mjs
 *
 * Per game in data/generated/schedule.json, using only what was known before kickoff:
 *
 *   edges   The unit-edge term as src/lib/slate.ts and projection.ts build it. This season's play-by-play from weeks
 *           before the game (same play filter as scripts/ingest.mjs: pass and run plays with an EPA, no aborted plays
 *           or two-point tries), each team's rush success, pass explosiveness (EPA on successful passes) and
 *           passing-down success, rounded to 3 places and ranked as percentiles among the teams with data
 *           (tendencies.ts rankIn). Six offense-vs-defense gaps, the four biggest kept, gaps under 20 count 0,
 *           net / 40 x 0.4 = points to the home side.
 *   avail   Non-QB availability (src/lib/availability.ts), per team. Status: the week's nflverse roster (reserve,
 *           inactive, suspended, exempt = out) and the official injury report (Out 1, Doubtful 0.85, Questionable 0.25,
 *           0.5 with no practice on the final day). Value: RB/WR/TE EPA a touch or target over the position's 25th
 *           percentile x touches a game x 0.5 (cap 3), this season once he has 2 games, else last season; OL 0.4,
 *           DL 0.4, LB 0.25, CB 0.4, S 0.25 x his snap share (0.5+ only), pass rushers with 1.5+ QB hits a game x1.5.
 *           Charged x the share of the team's games he played. Players who played for the team this season and are
 *           off its roster now (traded, cut, retired, sent to the practice squad) are charged in full weight.
 *           Arrivals who were starters elsewhere (0.5+ snap share; live uses the depth chart, which this replay does
 *           not load) add half their value. Offense and defense each capped at 4.
 *   ol      Item 4.2: starting linemen = the 5 OL with the most offensive snaps in the team's previous 3 regular season
 *           games; out = a starter with 0 offensive snaps in this game. Regular season, from each team's second game.
 *   epa     Offense EPA and plays per team in the game (same play filter), for the ridge rating in item 3.4.
 *
 * Downloads the play-by-play, weekly rosters, injuries and snap counts to data/cache (about 140 MB for 2019-2025).
 */
import { mkdir, writeFile, access, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamCsv } from "./lib/csv-stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(CACHE, "replay");
const SEASONS = (process.env.SEASONS ?? "2019,2020,2021,2022,2023,2024,2025").split(",").map(Number);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);
const num = (v) => (v === "" || v == null || v === "NA" ? 0 : Number(v) || 0);
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
/** Team codes as schedule.json writes them (older nflverse files use the old cities). */
const ALIAS = { OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA", WSH: "WAS" };
const norm = (t) => ALIAS[t] ?? t;

async function fetchTo(release, name) {
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  log("download", name);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/${release}/${name}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${name} ${res.status}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

const schedule = JSON.parse(await readFile(path.join(root, "data", "generated", "schedule.json"), "utf8"));

/* ------------------------------------------------------------ unit edges */
const AXES = ["rushSr", "passEx", "pdSr"];
const emptyUnit = () => ({ plays: 0, epa: 0, rushN: 0, rushSucc: 0, passExEpa: 0, passExN: 0, pdN: 0, pdSucc: 0 });
const addUnit = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; };
const metric = (u, k) => (k === "rushSr" ? (u.rushN ? r3(u.rushSucc / u.rushN) : null) : k === "passEx" ? (u.passExN ? r3(u.passExEpa / u.passExN) : null) : u.pdN ? r3(u.pdSucc / u.pdN) : null);

/** tendencies.ts rankIn: percentile 0..100, 100 = best for that side. */
function rankIn(sorted, v, wantHigh) {
  const n = sorted.length;
  let below = 0;
  while (below < n && sorted[below] < v) below++;
  const pct = Math.round(((wantHigh ? below : n - below - 1) / Math.max(1, n - 1)) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** The live edge term for one game from the season's units so far: { net, points } or undefined before both teams have data. */
function edgesFor(cum, home, away) {
  if (!cum.has(home) || !cum.has(away)) return undefined;
  const tables = { off: {}, def: {} };
  for (const side of ["off", "def"]) for (const k of AXES) tables[side][k] = [...cum.values()].map((t) => metric(t[side], k)).filter((v) => v !== null).sort((a, b) => a - b);
  const pct = (team, side, k) => {
    const v = metric(cum.get(team)[side], k);
    return v === null ? undefined : rankIn(tables[side][k], v, side === "off");
  };
  const unit = (o, d) =>
    AXES.map((k) => {
      const x = pct(o, "off", k);
      const y = pct(d, "def", k);
      if (x === undefined || y === undefined) return undefined;
      const gap = x - y;
      return { off: o, gap, edge: gap >= 20 ? "offense" : gap <= -20 ? "defense" : "even" };
    })
      .filter(Boolean)
      .sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap));
  const top = [...unit(away, home), ...unit(home, away)].sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap)).slice(0, 4);
  if (!top.length) return undefined;
  let net = 0;
  for (const m of top) {
    const g = m.edge === "offense" ? Math.abs(m.gap) : m.edge === "defense" ? -Math.abs(m.gap) : 0;
    net += m.off === home ? g : -g;
  }
  return { net, points: r3((0.4 * net) / 40) };
}

/* ------------------------------------------------------------ one season */
async function season(y) {
  // Play-by-play: per game and offense, the unit counts.
  const pbpFile = await fetchTo("pbp", `play_by_play_${y}.csv.gz`);
  const pbp = new Map(); // game_id -> { week, teams: Map(team -> { off, def }) }
  const keep = ["game_id", "week", "posteam", "defteam", "aborted_play", "two_point_attempt", "epa", "pass", "rush", "success", "down", "ydstogo"];
  await streamCsv(pbpFile, (r) => {
    if (r.aborted_play === "1" || !r.posteam || !r.defteam || r.two_point_attempt === "1") return;
    if (r.epa === "" || r.epa === "NA") return;
    const isPass = r.pass === "1";
    const isRush = !isPass && r.rush === "1";
    if (!isPass && !isRush) return;
    const epa = Number(r.epa);
    const succ = r.success === "1";
    const down = Number(r.down) || 0;
    const dist = r.ydstogo === "" ? 10 : Number(r.ydstogo);
    const standard = down === 1 || (down === 2 && dist <= 7) || ((down === 3 || down === 4) && dist <= 4);
    const g = pbp.get(r.game_id) ?? pbp.set(r.game_id, { week: Number(r.week), teams: new Map() }).get(r.game_id);
    for (const [team, side] of [[norm(r.posteam), "off"], [norm(r.defteam), "def"]]) {
      const t = g.teams.get(team) ?? g.teams.set(team, { off: emptyUnit(), def: emptyUnit() }).get(team);
      const u = t[side];
      u.plays++;
      u.epa += epa;
      if (isRush) { u.rushN++; if (succ) u.rushSucc++; } else if (succ) { u.passExEpa += epa; u.passExN++; }
      if (!standard) { u.pdN++; if (succ) u.pdSucc++; }
    }
  }, keep);
  log(y, "play-by-play games", pbp.size);

  // Weekly rosters, injuries, snap counts, player stats.
  const roster = new Map(); // `${week}|${team}` -> Map(gsis -> { pos, dcp, status })
  const posOf = new Map(); // gsis -> roster position (latest)
  const pfrToGsis = new Map();
  const statusCount = {};
  await streamCsv(await fetchTo("weekly_rosters", `roster_weekly_${y}.csv`), (r) => {
    if (!r.gsis_id) return;
    const key = `${Number(r.week)}|${norm(r.team)}`;
    (roster.get(key) ?? roster.set(key, new Map()).get(key)).set(r.gsis_id, { pos: r.position, dcp: r.depth_chart_position, status: r.status });
    posOf.set(r.gsis_id, r.position);
    if (r.pfr_id) pfrToGsis.set(r.pfr_id, r.gsis_id);
    statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
  }, ["gsis_id", "week", "team", "position", "depth_chart_position", "status", "pfr_id"]);
  log(y, "roster statuses", JSON.stringify(statusCount));

  const injuries = new Map(); // `${week}|${team}` -> Map(gsis -> { status, practice })
  await streamCsv(await fetchTo("injuries", `injuries_${y}.csv`), (r) => {
    if (!r.gsis_id) return;
    const key = `${Number(r.week)}|${norm(r.team)}`;
    (injuries.get(key) ?? injuries.set(key, new Map()).get(key)).set(r.gsis_id, { status: r.report_status, practice: r.practice_status });
  }, ["gsis_id", "week", "team", "report_status", "practice_status"]);

  const snaps = new Map(); // gsis -> [{ gid, week, team, reg, o, d, oSnaps, pos }]
  const snapsByGame = new Map(); // `${gid}|${team}` -> Map(key -> offense snaps) for OL
  await streamCsv(await fetchTo("snap_counts", `snap_counts_${y}.csv`), (r) => {
    const id = pfrToGsis.get(r.pfr_player_id) ?? `pfr:${r.pfr_player_id}`;
    const row = { gid: r.game_id, week: Number(r.week), team: norm(r.team), reg: r.game_type === "REG", o: num(r.offense_pct), d: num(r.defense_pct), oSnaps: num(r.offense_snaps), pos: r.position };
    (snaps.get(id) ?? snaps.set(id, []).get(id)).push(row);
    const gk = `${r.game_id}|${norm(r.team)}`;
    (snapsByGame.get(gk) ?? snapsByGame.set(gk, new Map()).get(gk)).set(id, row);
  }, ["game_id", "week", "game_type", "pfr_player_id", "team", "offense_pct", "defense_pct", "offense_snaps", "position"]);

  const loadStats = async (yy) => {
    const lines = new Map(); // gsis -> [{ week, team, tgt, ra, e, hits }] regular season
    const f = await fetchTo("stats_player", `stats_player_week_${yy}.csv`);
    await streamCsv(f, (r) => {
      if (r.season_type !== "REG" || !r.player_id) return;
      (lines.get(r.player_id) ?? lines.set(r.player_id, []).get(r.player_id)).push({ week: Number(r.week), team: norm(r.team), tgt: num(r.targets), ra: num(r.carries), e: num(r.receiving_epa) + num(r.rushing_epa), hits: num(r.def_qb_hits) });
    }, ["player_id", "season_type", "week", "team", "targets", "carries", "receiving_epa", "rushing_epa", "def_qb_hits"]);
    return lines;
  };
  const stats = await loadStats(y);
  const prevStats = await loadStats(y - 1);
  log(y, "loaded rosters, injuries, snaps, stats");

  const games = schedule.filter((g) => g.season === y && g.played).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const regGamesBefore = (team, week) => games.filter((g) => g.type === "REG" && g.week < week && (g.homeCode === team || g.awayCode === team)).length;

  // Skill replacement level per position at a week: 25th percentile EPA a touch or target, 30+ plays this season so far plus last season.
  const replCache = new Map();
  function skillRepl(week) {
    if (replCache.has(week)) return replCache.get(week);
    const out = {};
    for (const pos of ["RB", "WR", "TE"]) {
      const rates = [];
      for (const [id, p] of posOf) {
        if (p !== pos) continue;
        let n = 0, e = 0;
        for (const l of stats.get(id) ?? []) if (l.week < week) { n += l.tgt + l.ra; e += l.e; }
        for (const l of prevStats.get(id) ?? []) { n += l.tgt + l.ra; e += l.e; }
        if (n >= 30) rates.push(e / n);
      }
      rates.sort((a, b) => a - b);
      out[pos] = rates.length ? rates[Math.floor(0.25 * (rates.length - 1))] : 0;
    }
    replCache.set(week, out);
    return out;
  }

  /** availability.ts playerValue at a week, from what was known before it. */
  function playerValue(id, week, rost) {
    const pos = rost?.pos ?? posOf.get(id);
    if (pos === "RB" || pos === "WR" || pos === "TE") {
      const now = (stats.get(id) ?? []).filter((l) => l.week < week);
      const src = now.length >= 2 ? now : prevStats.get(id) ?? [];
      const gp = src.length;
      const plays = src.reduce((a, l) => a + l.tgt + l.ra, 0);
      if (!gp || plays < 8) return undefined;
      const per = src.reduce((a, l) => a + l.e, 0) / plays;
      const over = (per - skillRepl(week)[pos]) * (plays / gp) * 0.5;
      return { pts: over <= 0 ? 0 : Math.min(3, r1(over)), side: "offense" };
    }
    const group = pos === "OL" ? "OL" : pos === "DL" ? "DL" : pos === "LB" ? "LB" : pos === "DB" ? (/^(CB|DB)$/.test(rost?.dcp ?? "") ? "CB" : "S") : undefined;
    if (!group) return undefined;
    const rows = (snaps.get(id) ?? []).filter((s) => s.week < week);
    if (!rows.length) return undefined;
    const share = rows.reduce((a, s) => a + (group === "OL" ? s.o : s.d), 0) / rows.length;
    if (share < 0.5) return undefined;
    const lines = (stats.get(id) ?? []).filter((l) => l.week < week);
    const hits = lines.reduce((a, l) => a + l.hits, 0) / Math.max(1, lines.length);
    const rusher = (group === "DL" || group === "LB") && hits >= 1.5;
    const FIXED = { OL: 0.4, DL: 0.4, LB: 0.25, CB: 0.4, S: 0.25 };
    return { pts: r1(FIXED[group] * share * (rusher ? 1.5 : 1)), side: group === "OL" ? "offense" : "defense" };
  }

  const absenceOf = (rost, inj) => {
    let a = 0;
    if (rost && rost.status !== "ACT") a = 1; // reserve, inactive, suspended, exempt
    const s = (inj?.status ?? "").toLowerCase();
    if (s.startsWith("out")) a = Math.max(a, 1);
    else if (s.startsWith("doubtful")) a = Math.max(a, 0.85);
    else if (s.startsWith("questionable")) a = Math.max(a, /did not participate/i.test(inj?.practice ?? "") ? 0.5 : 0.25);
    return a;
  };

  function teamAvail(team, week) {
    const teamGames = regGamesBefore(team, week);
    if (!teamGames) return { off: 0, def: 0, items: [] };
    // No roster for the week (should not happen for a team that plays): unknown, not "everyone left".
    if (!roster.has(`${week}|${team}`)) return undefined;
    const rost = new Map([...(roster.get(`${week}|${team}`) ?? new Map())].filter(([, r]) => r.status !== "DEV"));
    const inj = injuries.get(`${week}|${team}`) ?? new Map();
    const gamesFor = (id) => new Set((stats.get(id) ?? []).filter((l) => l.team === team && l.week < week).map((l) => l.week)).size;
    const snapGames = (id) => (snaps.get(id) ?? []).filter((s) => s.week < week && s.reg).length;
    const items = [];
    const skip = (pos) => !pos || pos === "QB" || pos === "K" || pos === "P" || pos === "LS";
    // On the roster and out, doubtful or questionable.
    for (const [id, r] of rost) {
      if (skip(r.pos)) continue;
      const a = absenceOf(r, inj.get(id));
      if (a <= 0) continue;
      const played = gamesFor(id) || Math.min(snapGames(id), teamGames);
      if (!played) continue;
      const v = playerValue(id, week, r);
      if (!v) continue;
      const pts = -r1(v.pts * Math.min(1, played / teamGames) * a) || 0;
      if (pts) items.push({ id, side: v.side, kind: "out", pts });
    }
    // Played for the team this season and off its active roster now.
    const seen = new Set();
    for (const [id, lines] of stats) {
      if (rost.has(id) || seen.has(id) || skip(posOf.get(id))) continue;
      if (!lines.some((l) => l.team === team && l.week < week)) continue;
      seen.add(id);
      const v = playerValue(id, week, undefined);
      if (!v || v.pts <= 0) continue;
      const pts = -r1(v.pts * Math.min(1, gamesFor(id) / teamGames));
      if (pts) items.push({ id, side: v.side, kind: "left", pts });
    }
    // Linemen and defenders with snaps but no stat line leave through the snap counts.
    for (const [id, rows] of snaps) {
      if (rost.has(id) || seen.has(id) || skip(posOf.get(id)) || id.startsWith("pfr:")) continue;
      const here = rows.filter((s) => s.team === team && s.week < week && s.reg);
      if (!here.length) continue;
      seen.add(id);
      const v = playerValue(id, week, undefined);
      if (!v || v.pts <= 0) continue;
      const pts = -r1(v.pts * Math.min(1, here.length / teamGames));
      if (pts) items.push({ id, side: v.side, kind: "left", pts });
    }
    // Arrived in season from another team where he started: half his value.
    for (const [id, r] of rost) {
      if (skip(r.pos) || r.status !== "ACT") continue;
      const prior = (snaps.get(id) ?? []).filter((s) => s.week < week && s.reg);
      if (!prior.length || prior[prior.length - 1].team === team) continue;
      const share = prior.reduce((a, s) => a + Math.max(s.o, s.d), 0) / prior.length;
      if (share < 0.5) continue;
      const v = playerValue(id, week, r);
      if (!v || v.pts <= 0) continue;
      items.push({ id, side: v.side, kind: "arrived", pts: r1(v.pts * 0.5) });
    }
    const cap = (x) => Math.max(-4, Math.min(4, x));
    const off = r1(cap(items.filter((i) => i.side === "offense").reduce((a, b) => a + b.pts, 0)));
    const def = r1(cap(items.filter((i) => i.side === "defense").reduce((a, b) => a + b.pts, 0)));
    return { off, def, items: items.sort((a, b) => a.pts - b.pts).slice(0, 4) };
  }

  // Item 4.2: starting linemen out.
  const OL_POS = new Set(["T", "G", "C", "OL", "OT", "OG"]);
  function olOut(team, game) {
    const prev = games.filter((g) => g.type === "REG" && g.week < game.week && (g.homeCode === team || g.awayCode === team)).slice(-3);
    if (!prev.length) return undefined;
    const tally = new Map();
    for (const g of prev) for (const [id, s] of snapsByGame.get(`${g.gid}|${team}`) ?? []) if (OL_POS.has(s.pos)) tally.set(id, (tally.get(id) ?? 0) + s.oSnaps);
    const starters = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    if (starters.length < 5) return undefined;
    const now = snapsByGame.get(`${game.gid}|${team}`);
    if (!now) return undefined;
    return { out: starters.filter((id) => !(now.get(id)?.oSnaps > 0)).length, prevGames: prev.length };
  }

  // Walk the season in kickoff order.
  const cum = new Map(); // team -> { off, def } over the season's earlier weeks
  const doneWeeks = new Set();
  const out = {};
  let lastWeek = null;
  for (const g of games) {
    // Units grow by whole weeks: everything from weeks before this game's week.
    if (g.week !== lastWeek) {
      for (const [, pg] of pbp) {
        if (pg.week >= g.week || doneWeeks.has(pg)) continue;
        doneWeeks.add(pg);
        for (const [team, t] of pg.teams) {
          const c = cum.get(team) ?? cum.set(team, { off: emptyUnit(), def: emptyUnit() }).get(team);
          addUnit(c.off, t.off);
          addUnit(c.def, t.def);
        }
      }
      lastWeek = g.week;
    }
    const edges = edgesFor(cum, g.homeCode, g.awayCode);
    const pg = pbp.get(g.gid);
    const epa = pg ? Object.fromEntries([...pg.teams].map(([t, u]) => [t, { plays: u.off.plays, epa: r3(u.off.epa) }])) : undefined;
    out[g.id] = {
      gid: g.gid,
      week: g.week,
      type: g.type,
      home: g.homeCode,
      away: g.awayCode,
      edges,
      avail: { home: teamAvail(g.homeCode, g.week), away: teamAvail(g.awayCode, g.week) },
      ol: g.type === "REG" ? { home: olOut(g.homeCode, g), away: olOut(g.awayCode, g) } : undefined,
      epa,
    };
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, `replay-${y}.json`), JSON.stringify({ season: y, builtAt: new Date().toISOString(), games: out }));
  const withEdges = Object.values(out).filter((x) => x.edges).length;
  log(y, "games", games.length, "with edges", withEdges, "written");
}

for (const y of SEASONS) await season(y);
log("done");
