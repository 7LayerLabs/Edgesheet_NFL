#!/usr/bin/env node
/**
 * Leaders boards from play-by-play: rushing, receiving, passing, and team efficiency, this season and last, with ranks.
 * Writes data/generated/leaders.json for the /leaders page, player pages, and the DraftKings why lines.
 *
 *   node scripts/ingest-leaders.mjs          (npm run ingest runs it after ingest-extras)
 *
 * Reads data/cache/play_by_play_<season>.csv (the main ingest downloads it) and play_by_play_<last season>.csv.gz
 * (downloaded here if missing). Stat definitions live in scripts/lib/leaders-agg.mjs. Charting and tracking columns
 * (yards before contact, rush yards over expected, separation, pressures) come from extras.json when present.
 *
 * Qualified (ranked) players: per team game played, 6.25 carries, 1.875 targets, or 14 dropbacks (the paces sites use
 * for leaderboards, rounded). Everyone with 10 carries, 8 targets, or 40 dropbacks is listed; the rest are left off.
 * Routes run are not in any free data, so yards per route run is not shown; yards per offensive snap stands in.
 */
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregatePbp, sumWeeks } from "./lib/leaders-agg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "generated");
const t0 = Date.now();
const log = (...a) => console.log(`[leaders ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);

const meta = JSON.parse(await readFile(path.join(OUT, "meta.json"), "utf8"));
const season = meta.season;
const prev = season - 1;
const teamsFile = JSON.parse(await readFile(path.join(root, "data", "nfl-teams.json"), "utf8")).teams;
const ALIAS = { LAR: "LA", WSH: "WAS", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LA" };
const nick = (c) => teamsFile.find((t) => t.code === (ALIAS[c] ?? c))?.short ?? c;
const players = JSON.parse(await readFile(path.join(OUT, "players.json"), "utf8"));
const byGsis = new Map(players.filter((p) => p.gsis).map((p) => [p.gsis, p]));
let gamelogs;
try {
  gamelogs = JSON.parse(await readFile(path.join(OUT, "gamelogs.json"), "utf8"));
} catch {
  gamelogs = undefined;
}
let extras;
try {
  extras = JSON.parse(await readFile(path.join(OUT, "extras.json"), "utf8"));
} catch {
  extras = undefined;
}

async function pbpFile(y) {
  const csv = path.join(CACHE, `play_by_play_${y}.csv`);
  if (await exists(csv)) return csv;
  const gz = path.join(CACHE, `play_by_play_${y}.csv.gz`);
  if (await exists(gz)) return gz;
  log("download", `play_by_play_${y}.csv.gz`);
  const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${y}.csv.gz`, { redirect: "follow" });
  if (!res.ok) return undefined;
  await writeFile(`${gz}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${gz}.part`, gz);
  return gz;
}

const r1 = (x) => (x === undefined || !Number.isFinite(x) ? undefined : Math.round(x * 10) / 10);
const r3 = (x) => (x === undefined || !Number.isFinite(x) ? undefined : Math.round(x * 1000) / 1000);
const pct = (a, b) => (b ? r1((100 * a) / b) : undefined);

/** Rank every numeric key in `dirs` among qualified rows: 1 = best. dirs[k] = 1 higher is better, -1 lower is better. */
function rank(rows, dirs) {
  const q = rows.filter((r) => r.qualified);
  for (const [k, dir] of Object.entries(dirs)) {
    const sorted = q.filter((r) => r[k] !== undefined).sort((a, b) => dir * (b[k] - a[k]));
    sorted.forEach((r, i) => {
      (r.rank ??= {})[k] = i + 1;
    });
    for (const r of q) (r.of ??= {})[k] = sorted.length;
  }
}

async function board(y) {
  const file = await pbpFile(y);
  if (!file) return undefined;
  log("aggregate", y);
  const { players: P, teams: T, teamOf, nameOf } = await aggregatePbp(file);
  const teamGames = new Map([...T].map(([code, weeks]) => [code, weeks.size]));
  const maxGames = Math.max(1, ...teamGames.values());
  const teamTot = new Map([...T].map(([code, weeks]) => [code, sumWeeks(weeks)]));
  // Team targets and intended air yards, for shares.
  const teamRec = new Map();
  for (const [id, weeks] of P) {
    const s = sumWeeks(weeks).rec;
    if (!s) continue;
    const code = teamOf.get(id);
    const t = teamRec.get(code) ?? teamRec.set(code, { tgt: 0, air: 0 }).get(code);
    t.tgt += s.tgt ?? 0;
    t.air += s.air ?? 0;
  }
  const ex = (gsis) => {
    const p = byGsis.get(gsis);
    return p ? extras?.players?.[p.id] : undefined;
  };
  const who = (gsis) => {
    const p = byGsis.get(gsis);
    const code = teamOf.get(gsis);
    return { id: p?.id ?? gsis, name: p?.n ?? nameOf.get(gsis) ?? gsis, team: nick(code), pos: p?.pg ?? "", tg: teamGames.get(code) ?? maxGames };
  };

  const rushing = [];
  const receiving = [];
  const passing = [];
  for (const [gsis, weeks] of P) {
    const s = sumWeeks(weeks);
    const w = who(gsis);
    const e = ex(gsis);
    if (s.rush && s.rush.att >= 10 && w.pos !== "QB") {
      const a = s.rush;
      const adv = e?.adv?.[String(y)]?.rush;
      const ngs = e?.ngs?.[String(y)]?.rush;
      rushing.push({
        ...w, games: a.games, att: a.att, yds: a.yds, ypc: r1(a.yds / a.att), td: a.td, epa: r1(a.epa), epaPer: r3(a.epa / a.att),
        succ: pct(a.succ, a.att), expl: pct(a.expl, a.att), stuff: pct(a.stuff, a.att), fd: a.fd,
        sy: a.syAtt ? `${a.syConv}/${a.syAtt}` : undefined, syPct: a.syAtt >= 3 ? pct(a.syConv, a.syAtt) : undefined,
        ybc: adv?.att ? r1(adv.ybc / adv.att) : undefined, ryoe: ngs?.ryoePer !== undefined ? r1(ngs.ryoePer) : undefined,
        qualified: a.att >= 6.25 * w.tg,
      });
    }
    if (s.rec && s.rec.tgt >= 8) {
      const a = s.rec;
      const t = teamRec.get(teamOf.get(gsis));
      const pl = byGsis.get(gsis);
      // Yards per offensive snap over the games that have snap counts (the snap file lags the stats by a few days).
      const lines = y === season && pl ? (gamelogs?.players?.[pl.id] ?? []).filter((l) => l.st === "regular" && l.sn?.os) : [];
      const snaps = lines.reduce((acc, l) => acc + l.sn.os, 0);
      const snapYds = lines.reduce((acc, l) => acc + (l.s?.rcy ?? 0), 0);
      const ngs = e?.ngs?.[String(y)]?.rec;
      receiving.push({
        ...w, games: a.games, tgt: a.tgt, rec: a.rec, yds: a.yds, td: a.td, epa: r1(a.epa), epaPer: r3(a.epa / a.tgt), succ: pct(a.succ, a.tgt),
        catchPct: pct(a.rec, a.tgt), adot: a.airN ? r1(a.air / a.airN) : undefined, tgtShare: t?.tgt ? pct(a.tgt, t.tgt) : undefined, airShare: t?.air ? pct(a.air ?? 0, t.air) : undefined,
        yacoe: a.yacN ? r1((a.yac - a.xyac) / a.yacN) : undefined, fd: a.fd, rz: a.rz ?? 0, deep: a.deep ?? 0,
        ydsSnap: snaps >= 120 ? r3(snapYds / snaps) : undefined, // a real sample only: one odd snap count can top a short board sep: ngs?.sep !== undefined ? r1(ngs.sep) : undefined,
        qualified: a.tgt >= 1.875 * w.tg,
      });
    }
    if (s.pass && s.pass.db >= 40) {
      const a = s.pass;
      const adv = e?.adv?.[String(y)]?.pass;
      passing.push({
        ...w, games: a.games, db: a.db, att: a.att ?? 0, cmp: a.cmp ?? 0, yds: a.yds ?? 0, td: a.td ?? 0, int: a.int ?? 0, sk: a.sk ?? 0,
        epa: r1(a.epa), epaPer: r3(a.epa / a.db), succ: pct(a.succ, a.db), cpoe: a.cpoeN ? r1(a.cpoe / a.cpoeN) : undefined,
        adot: a.airN ? r1(a.air / a.airN) : undefined, sackRate: pct(a.sk ?? 0, a.db), expl: pct(a.expl, a.db), neg: pct(a.neg, a.db),
        scr: a.scr ?? 0, scrEpa: a.scr ? r1(a.scrEpa) : undefined,
        pressured: adv?.press !== undefined ? pct(adv.press, a.db) : undefined, p2s: adv?.press ? pct(adv.sk ?? 0, adv.press) : undefined,
        qualified: a.db >= 14 * w.tg,
      });
    }
  }
  rank(rushing, { yds: 1, ypc: 1, epa: 1, epaPer: 1, succ: 1, expl: 1, stuff: -1, syPct: 1, ybc: 1, ryoe: 1, td: 1 });
  rank(receiving, { yds: 1, epa: 1, epaPer: 1, succ: 1, catchPct: 1, adot: 1, tgtShare: 1, airShare: 1, yacoe: 1, ydsSnap: 1, td: 1, sep: 1 });
  rank(passing, { yds: 1, epa: 1, epaPer: 1, succ: 1, cpoe: 1, adot: 1, sackRate: -1, expl: 1, neg: -1, pressured: -1, p2s: -1, td: 1, int: -1 });

  const teams = [...teamTot].map(([code, t]) => {
    const o = t.off ?? {};
    const d = t.def ?? {};
    const side = (x, flip) => ({
      plays: x.plays, epaPer: r3(x.epa / x.plays), succ: pct(x.succ, x.plays), expl: pct(x.expl, x.plays), neg: pct(x.neg, x.plays),
      dbEpa: x.db ? r3(x.dbEpa / x.db) : undefined, rushEpa: x.rush ? r3(x.rushEpa / x.rush) : undefined, rushSucc: x.rush ? pct(x.rushSucc, x.rush) : undefined,
      earlyEpa: x.early ? r3(x.earlyEpa / x.early) : undefined, sackRate: x.db ? pct(x.sk ?? 0, x.db) : undefined, hitRate: x.db ? pct(x.hitSk ?? 0, x.db) : undefined,
      proe: x.poeN ? r1(x.poe / x.poeN) : undefined, flip, // nflverse pass_oe is already in percentage points
    });
    return { code, team: nick(code), games: teamGames.get(code), off: side(o, false), def: side(d, true), qualified: true };
  });
  // Team ranks: offense higher EPA is better, defense lower EPA allowed is better (and more sacks and hits).
  const rankSide = (side, dirs) => {
    for (const [k, dir] of Object.entries(dirs)) {
      const sorted = teams.filter((t) => t[side][k] !== undefined).sort((a, b) => dir * (b[side][k] - a[side][k]));
      sorted.forEach((t, i) => {
        (t[side].rank ??= {})[k] = i + 1;
      });
    }
  };
  rankSide("off", { epaPer: 1, succ: 1, expl: 1, neg: -1, dbEpa: 1, rushEpa: 1, rushSucc: 1, earlyEpa: 1, sackRate: -1, proe: 1 });
  rankSide("def", { epaPer: -1, succ: -1, expl: -1, neg: 1, dbEpa: -1, rushEpa: -1, rushSucc: -1, earlyEpa: -1, sackRate: 1, hitRate: 1 });

  const by = (k) => (a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity);
  return { season: y, teamGames: maxGames, rushing: rushing.sort(by("yds")), receiving: receiving.sort(by("yds")), passing: passing.sort(by("epa")), teams };
}

const out = { asOf: new Date().toISOString(), seasons: [], boards: {} };
for (const y of [season, prev]) {
  const b = await board(y);
  if (!b) continue;
  out.seasons.push(y);
  out.boards[y] = b;
  log(y, "rushers", b.rushing.length, "receivers", b.receiving.length, "passers", b.passing.length, "teams", b.teams.length);
}
const json = JSON.stringify(out);
await writeFile(path.join(OUT, "leaders.json"), json);
log("wrote leaders.json", `${(json.length / 1e6).toFixed(2)} MB`);
