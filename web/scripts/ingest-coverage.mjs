/**
 * Coverage tendencies for the game page, from nflverse pbp_participation (FTN charting) joined to play-by-play.
 *
 *   node scripts/ingest-coverage.mjs            # latest season that has coverage charting (2025 during the 2026 season)
 *   SEASON=2024 node scripts/ingest-coverage.mjs
 *
 * nflverse posts participation after a season ends, so during the season this is LAST season's picture: say so
 * wherever it is shown. Downloads to data/cache (participation CSV about 50 MB, play-by-play .csv.gz about 19 MB) when
 * missing; never re-downloads. Writes data/generated/coverage.json:
 *   teams[nickname].def   pass plays charted, man and zone share, shell mix, 5+ rushers share, pressure rate, EPA per
 *                         dropback allowed against man and against zone, each with a league rank (1 = most)
 *   teams[nickname].off   personnel mix (11, 12, 21 ...), EPA per dropback against man and against zone, ranked
 *   players[espn id]      targets, catches, yards, TD, EPA per target overall and against man and zone, with counts;
 *                         a side with fewer than 15 targets is flagged so the page says "not enough targets"
 * Every number carries its sample size. src/lib/coverage.ts reads the file.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.mjs";
import { aggregateSeason, ONE_HIGH, TWO_HIGH } from "./lib/coverage-agg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "generated");
const BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const MIN_SPLIT = 15; // targets on each side before a man/zone split is shown
const MIN_TARGETS = 10; // receivers below this are left out of the file
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function download(rel, name) {
  const file = path.join(CACHE, name);
  if (existsSync(file)) return file;
  log("download", rel);
  const res = await fetch(`${BASE}/${rel}`, { redirect: "follow" });
  if (!res.ok) return undefined;
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${file}.part`, file);
  log("saved", name, `${(statSync(file).size / 1e6).toFixed(1)} MB`);
  return file;
}

const now = new Date();
const current = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
const candidates = process.env.SEASON ? [Number(process.env.SEASON)] : [current - 1, current - 2];
let agg;
for (const season of candidates) {
  const part = await download(`pbp_participation/pbp_participation_${season}.csv`, `pbp_participation_${season}.csv`);
  const pbp = (await download(`pbp/play_by_play_${season}.csv.gz`, `play_by_play_${season}.csv.gz`)) ?? (await download(`pbp/play_by_play_${season}.csv`, `play_by_play_${season}.csv`));
  if (!part || !pbp) {
    log("no participation or play-by-play for", season);
    continue;
  }
  agg = await aggregateSeason(season, CACHE);
  const charted = Object.values(agg?.teams ?? {}).reduce((a, t) => a + t.def.charted, 0);
  if (agg && charted > 1000) break;
  log("season", season, "has no coverage charting");
  agg = undefined;
}
if (!agg) {
  console.error("No season with coverage charting found.");
  process.exit(1);
}
log("season", agg.season, "teams", Object.keys(agg.teams).length, "receivers", Object.keys(agg.receivers).length);

// Teams: nflverse code to the app's nickname.
const TEAMS = JSON.parse(readFileSync(path.join(root, "data", "nfl-teams.json"), "utf8")).teams;
const ALIAS = { LAR: "LA", WSH: "WAS", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LA" };
const nick = (c) => TEAMS.find((t) => t.code === (ALIAS[c] ?? c))?.short ?? c;

// Players: gsis id to the app's id (ESPN id), name, position, and current team.
const players = existsSync(path.join(OUT, "players.json")) ? JSON.parse(readFileSync(path.join(OUT, "players.json"), "utf8")) : [];
const byGsis = new Map(players.filter((p) => p.gsis).map((p) => [p.gsis, p]));
const roster = new Map();
const rosterFile = path.join(CACHE, `roster_${agg.season}.csv`);
if (existsSync(rosterFile)) await readCsv(rosterFile, (r) => r.gsis_id && roster.set(r.gsis_id, r));

const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b ? r3(a / b) : null);

/** Rank every team on one value, 1 = most. Ties share the better rank. */
function rankOf(rows, get) {
  const vals = rows.map((r) => [r.key, get(r)]).filter(([, v]) => v != null);
  const sorted = [...vals].sort((a, b) => b[1] - a[1]);
  const out = new Map();
  for (const [k, v] of vals) out.set(k, sorted.findIndex(([, x]) => x === v) + 1);
  return out;
}

const SHELL = { COVER_0: "Cover 0", COVER_1: "Cover 1", COVER_2: "Cover 2", COVER_3: "Cover 3", COVER_4: "Cover 4", COVER_6: "Cover 6", COVER_9: "Cover 9", "2_MAN": "2-man", PREVENT: "Prevent", COMBO: "Combination", BLOWN: "Blown coverage" };
const shellName = (s) => SHELL[s] ?? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const rows = Object.entries(agg.teams).map(([code, t]) => ({ key: nick(code), code, ...t }));
const defMetrics = {
  // Safety shells: the read that carries over season to season (scripts/backtest-coverage.mjs).
  twoHighPct: (r) => pct(TWO_HIGH.reduce((a, k) => a + (r.def.shells[k] ?? 0), 0), r.def.charted),
  oneHighPct: (r) => pct(ONE_HIGH.reduce((a, k) => a + (r.def.shells[k] ?? 0), 0), r.def.charted),
  manPct: (r) => pct(r.def.man, r.def.charted),
  zonePct: (r) => pct(r.def.zone, r.def.charted),
  rush5Pct: (r) => pct(r.def.rush5, r.def.rushKnown),
  pressurePct: (r) => pct(r.def.press, r.def.pressKnown),
  epaVsMan: (r) => (r.def.vsMan.n ? r3(r.def.vsMan.epa / r.def.vsMan.n) : null),
  epaVsZone: (r) => (r.def.vsZone.n ? r3(r.def.vsZone.epa / r.def.vsZone.n) : null),
};
const offMetrics = {
  epaVsMan: (r) => (r.off.vsMan.n ? r3(r.off.vsMan.epa / r.off.vsMan.n) : null),
  epaVsZone: (r) => (r.off.vsZone.n ? r3(r.off.vsZone.epa / r.off.vsZone.n) : null),
};
const defRanks = Object.fromEntries(Object.entries(defMetrics).map(([k, f]) => [k, rankOf(rows, f)]));
const offRanks = Object.fromEntries(Object.entries(offMetrics).map(([k, f]) => [k, rankOf(rows, f)]));
// Shell ranks: share of charted plays in each shell, ranked across teams.
const allShells = [...new Set(rows.flatMap((r) => Object.keys(r.def.shells)))];
const shellRanks = Object.fromEntries(allShells.map((s) => [s, rankOf(rows, (r) => pct(r.def.shells[s] ?? 0, r.def.charted))]));

const teams = {};
for (const r of rows) {
  const d = r.def;
  const o = r.off;
  const metric = (m, k) => ({ value: m[k](r), rank: (m === defMetrics ? defRanks : offRanks)[k].get(r.key) });
  teams[r.key] = {
    code: r.code,
    def: {
      dropbacks: d.dropbacks,
      charted: d.charted,
      twoHigh: { ...metric(defMetrics, "twoHighPct"), n: TWO_HIGH.reduce((a, k) => a + (d.shells[k] ?? 0), 0) },
      oneHigh: { ...metric(defMetrics, "oneHighPct"), n: ONE_HIGH.reduce((a, k) => a + (d.shells[k] ?? 0), 0) },
      man: { ...metric(defMetrics, "manPct"), n: d.man },
      zone: { ...metric(defMetrics, "zonePct"), n: d.zone },
      shells: Object.entries(d.shells)
        .map(([s, n]) => ({ shell: shellName(s), key: s, pct: pct(n, d.charted), n, rank: shellRanks[s].get(r.key) }))
        .sort((a, b) => b.n - a.n),
      rush5: { ...metric(defMetrics, "rush5Pct"), of: d.rushKnown },
      pressure: { ...metric(defMetrics, "pressurePct"), of: d.pressKnown },
      epaVsMan: { ...metric(defMetrics, "epaVsMan"), n: d.vsMan.n },
      epaVsZone: { ...metric(defMetrics, "epaVsZone"), n: d.vsZone.n },
    },
    off: {
      plays: o.plays,
      personnel: Object.entries(o.personnel)
        .map(([group, n]) => ({ group, pct: pct(n, o.plays), n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 6),
      epaVsMan: { ...metric(offMetrics, "epaVsMan"), n: o.vsMan.n },
      epaVsZone: { ...metric(offMetrics, "epaVsZone"), n: o.vsZone.n },
    },
  };
}

const side = (s) => ({ tgt: s.tgt, catches: s.catches, yards: s.yards, td: s.td, ypt: s.tgt ? r1(s.yards / s.tgt) : null, epa: s.tgt ? r3(s.epa / s.tgt) : null, enough: s.tgt >= MIN_SPLIT });
const out = {};
let skipped = 0;
for (const [gsis, rc] of Object.entries(agg.receivers)) {
  if (rc.targets < MIN_TARGETS) continue;
  const p = byGsis.get(gsis);
  const ro = roster.get(gsis);
  const pos = p?.pg ?? ro?.position ?? "";
  if (!["WR", "TE", "RB", "FB"].includes(pos)) {
    skipped++;
    continue;
  }
  const id = p?.id ?? (ro?.espn_id || gsis);
  const seasonTeam = Object.entries(rc.teams).sort((a, b) => b[1] - a[1])[0]?.[0];
  out[id] = {
    gsis,
    id,
    name: p?.n ?? ro?.full_name ?? rc.name,
    pos: pos === "FB" ? "RB" : pos,
    team: seasonTeam ? nick(seasonTeam) : undefined, // the team he played for most that season
    now: p?.t, // his team on today's roster, when he has one
    targets: rc.targets,
    catches: rc.catches,
    yards: rc.yards,
    td: rc.td,
    ypt: r1(rc.yards / rc.targets),
    epa: r3(rc.epa / rc.targets),
    man: side(rc.man),
    zone: side(rc.zone),
  };
}

const file = { season: agg.season, builtAt: new Date().toISOString(), minSplitTargets: MIN_SPLIT, source: "nflverse pbp_participation (FTN charting) joined to nflverse play-by-play, regular season", teams, players: out };
mkdirSync(OUT, { recursive: true });
const target = path.join(OUT, "coverage.json");
await writeFile(target, JSON.stringify(file));
log("wrote", target, `${(statSync(target).size / 1e3).toFixed(0)} KB`, "teams", Object.keys(teams).length, "receivers", Object.keys(out).length, "non-skill targets left out", skipped);
