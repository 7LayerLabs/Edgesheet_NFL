/**
 * Opponent-adjusted production. A 150-yard game against the best rush defense
 * in the league is worth more than 150 against the worst, and the radar
 * should know the difference.
 *
 * Inputs: data/generated/gamelogs.json (per-player game lines, from
 * scripts/ingest.mjs) and data/generated/teams.json (play-by-play tendencies). Each game's production is weighted by the
 * opponent's quality on the axis that matters for the position:
 *   rushers (RB)                 opponent rush-defense success rate (lower is better defense)
 *   passers, receivers (QB WR TE) opponent pass-defense success rate and explosiveness allowed
 *   defenders (DL EDGE LB CB S)  opponent offensive line yards (higher is a better offense)
 * The weight is 1.0 for a league-average opponent, about 1.5 for the best unit
 * and about 0.6 for the worst. An FCS opponent with no advanced stats counts 0.6
 * for an FBS player. FCS-vs-FCS games have no opponent data at all: they get a
 * neutral 1.0 and do not count toward the schedule label.
 *
 * Nothing here is a claim about the player beyond what the box score and the
 * opponent's season numbers say.
 */
import { genGamelogs, genPlayers, genTeams, gamelogsStamp, type GenGameLine, type GenTeam } from "./generated";
import { memoSync } from "./memo";

export type Axis = "rush" | "pass" | "def";
export type QocLabel = "soft" | "average" | "tough" | "unmeasured";

/** Position group names match radar.ts PosGroup. Kept local so this module never imports radar.ts (radar imports us). */
const GROUP: Record<string, string> = {
  QB: "QB", RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE",
  OL: "OL", OT: "OL", OG: "OL", C: "OL", G: "OL", T: "OL", LT: "OL", RT: "OL", LG: "OL", RG: "OL",
  DL: "DL", DT: "DL", NT: "DL", DE: "EDGE", EDGE: "EDGE", OLB: "EDGE",
  LB: "LB", ILB: "LB", MLB: "LB",
  DB: "CB", CB: "CB", NB: "CB", S: "S", FS: "S", SS: "S", SAF: "S",
  PK: "ST", K: "ST", P: "ST", LS: "ST",
};

export const AXIS_OF_GROUP: Record<string, Axis | null> = {
  QB: "pass", RB: "rush", WR: "pass", TE: "pass",
  DL: "def", EDGE: "def", LB: "def", CB: "def", S: "def",
  OL: null, ST: null,
};

export const AXIS_LABEL: Record<Axis, string> = { rush: "rush defense", pass: "pass defense", def: "offensive run game" };

/* -------------------------------------------------------------- weights */

/** Opponent percentile (100 = toughest) to a production weight: 0.6 worst, 1.0 average, 1.5 best. */
export function weightFor(pct: number): number {
  const p = Math.max(0, Math.min(100, pct));
  return p < 50 ? 0.6 + 0.4 * (p / 50) : 1.0 + 0.5 * ((p - 50) / 50);
}

export const FCS_OPPONENT_WEIGHT = 0.6;

/**
 * Per-game production, same weights as the season formula in radar.ts with the
 * per-game divisor removed and the volume gates dropped (one game is one game).
 */
export function gameProduction(s: Record<string, number>, group: string): number {
  switch (group) {
    case "QB": {
      const pa = s.pa ?? 0;
      if (pa < 5) return 0;
      const ypa = s.ypa ?? (s.py ?? 0) / Math.max(1, pa);
      const pct = (s.pc ?? 0) / Math.max(1, pa);
      return (s.py ?? 0) * 0.5 + (s.ptd ?? 0) * 12 - (s.pint ?? 0) * 14 + ypa * 18 + pct * 120 + (s.ry ?? 0) * 0.6 + (s.rtd ?? 0) * 6;
    }
    case "RB": {
      const ra = s.ra ?? 0;
      if (ra < 3) return 0;
      const ypc = s.ypc ?? (s.ry ?? 0) / Math.max(1, ra);
      return (s.ry ?? 0) * 1.0 + (s.rtd ?? 0) * 10 + ypc * 12 + (s.rcy ?? 0) * 0.8 + (s.rec ?? 0) * 1.5;
    }
    case "WR":
    case "TE": {
      if ((s.rec ?? 0) < 1) return 0;
      const ypr = s.ypr ?? (s.rcy ?? 0) / Math.max(1, s.rec ?? 1);
      return (s.rcy ?? 0) * 1.2 + (s.rec ?? 0) * 6 + (s.rctd ?? 0) * 10 + ypr * (group === "TE" ? 2.5 : 2);
    }
    case "EDGE":
    case "DL":
      return (s.sk ?? 0) * 22 + (s.tfl ?? 0) * 10 + (s.hur ?? 0) * 6 + (s.tk ?? 0) * 3 + (s.pd ?? 0) * 3 + (s.fr ?? 0) * 5;
    case "LB":
      return (s.tk ?? 0) * 7 + (s.tfl ?? 0) * 8 + (s.sk ?? 0) * 12 + (s.pd ?? 0) * 5 + (s.int ?? 0) * 12 + (s.hur ?? 0) * 3;
    case "CB":
    case "S":
      return (s.int ?? 0) * 25 + (s.pd ?? 0) * 10 + (s.tk ?? 0) * 4 + (s.tfl ?? 0) * 5 + (s.dtd ?? 0) * 15;
    default:
      return 0;
  }
}

/** One-line box score for a game, by position group. Only shows what the line has. */
export function gameLineText(s: Record<string, number>, group: string): string {
  const parts: string[] = [];
  switch (group) {
    case "QB":
      if (s.pa !== undefined) parts.push(`${s.pc ?? 0}/${s.pa}, ${s.py ?? 0} yds, ${s.ptd ?? 0} TD, ${s.pint ?? 0} INT`);
      if (s.ry) parts.push(`${s.ry} rush yds${s.rtd ? `, ${s.rtd} rush TD` : ""}`);
      break;
    case "RB":
      if (s.ra !== undefined) parts.push(`${s.ra} car, ${s.ry ?? 0} yds, ${s.rtd ?? 0} TD`);
      if (s.rec) parts.push(`${s.rec} rec, ${s.rcy ?? 0} yds`);
      break;
    case "WR":
    case "TE":
      if (s.rec !== undefined) parts.push(`${s.rec} rec, ${s.rcy ?? 0} yds, ${s.rctd ?? 0} TD`);
      if (s.ry) parts.push(`${s.ry} rush yds`);
      break;
    case "DL":
    case "EDGE":
    case "LB":
    case "CB":
    case "S":
      if (s.tk !== undefined) parts.push(`${s.tk} tkl${s.tfl ? `, ${s.tfl} TFL` : ""}${s.sk ? `, ${s.sk} sack${s.sk === 1 ? "" : "s"}` : ""}${s.pd ? `, ${s.pd} PD` : ""}${s.hur ? `, ${s.hur} hur` : ""}`);
      if (s.int) parts.push(`${s.int} INT`);
      break;
  }
  return parts.join(" · ") || "no line in this category";
}

/* -------------------------------------------------------- opponent tables */

interface OppQuality {
  /** percentile per axis, 100 = toughest. */
  pct: Record<Axis, number>;
  rank: Record<Axis, number>;
  of: number;
  team: GenTeam;
}

function pctBelow(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length > 1 ? Math.round((lo / (sorted.length - 1)) * 100) : 50;
}

/** Opponent quality on every axis, all 32 teams, from the play-by-play digest. */
function opponentTable(): Map<string, OppQuality> {
  return memoSync("adj:opp", 3600, () => {
    const teams = genTeams().filter((t) => t.def && t.off);
    const rushSr = teams.map((t) => t.def.rushSr).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const passSr = teams.map((t) => t.def.passSr).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const passEx = teams.map((t) => t.def.passEx).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const ly = teams.map((t) => t.off.ly).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const out = new Map<string, OppQuality>();
    const n = teams.length;
    for (const t of teams) {
      // Defense: lower success and explosiveness allowed is better, so toughness = 100 - percentile.
      const rush = typeof t.def.rushSr === "number" ? 100 - pctBelow(rushSr, t.def.rushSr) : 50;
      const ps = typeof t.def.passSr === "number" ? 100 - pctBelow(passSr, t.def.passSr) : 50;
      const pe = typeof t.def.passEx === "number" ? 100 - pctBelow(passEx, t.def.passEx) : 50;
      const pass = Math.round((ps + pe) / 2);
      // Offense line yards: higher is a tougher opponent for a defender.
      const def = typeof t.off.ly === "number" ? pctBelow(ly, t.off.ly) : 50;
      const pct = { rush, pass, def };
      const rank = { rush: Math.max(1, Math.round(n - (rush / 100) * (n - 1))), pass: Math.max(1, Math.round(n - (pass / 100) * (n - 1))), def: Math.max(1, Math.round(n - (def / 100) * (n - 1))) };
      out.set(t.team, { pct, rank, of: n, team: t });
    }
    return out;
  });
}

/* -------------------------------------------------------------- per player */

export interface GameLogRow {
  gameId: string;
  week: number;
  opponent: string;
  homeAway: "home" | "away";
  /** Opponent's percentile on the player's axis, 100 = toughest. null when unmeasured. */
  oppPct: number | null;
  oppRank: number | null;
  oppOf: number | null;
  oppNote: string; // "No. 12 of 136 rush defense" | "FCS, no advanced stats" | "unmeasured"
  weight: number;
  raw: number; // this game's production
  adjusted: number; // raw * weight
  line: string;
  stats: Record<string, number>;
}

export interface AdjustedProduction {
  playerId: string;
  group: string;
  axis: Axis | null;
  games: number; // games with a line
  rawAvg: number; // mean per-game production
  adjAvg: number; // mean weighted production
  /** adjAvg / rawAvg; above 1 means the schedule made his numbers harder to get than they look. */
  ratio: number | null;
  rows: GameLogRow[];
}

export interface QualityOfCompetition {
  playerId: string;
  axis: Axis | null;
  /** Average opponent percentile on his axis, over games with a measured opponent. */
  avgPct: number | null;
  measured: number; // games with a measured opponent
  games: number;
  label: QocLabel;
  text: string; // "vs tough schedule, avg opponent 71st pct rush defense over 5 games"
}

const groupOf = (pos: string | null | undefined) => GROUP[pos ?? ""] ?? null;

function classOf(): Map<string, string> {
  return memoSync("adj:teamClass", 3600, () => {
    const m = new Map<string, string>();
    for (const p of genPlayers()) if (p.c && !m.has(p.t)) m.set(p.t, p.c);
    return m;
  });
}

function rowsFor(lines: GenGameLine[], group: string, playerClass: string | null): GameLogRow[] {
  const axis = AXIS_OF_GROUP[group] ?? null;
  const opp = opponentTable();
  const cls = classOf();
  return lines.map((l) => {
    const raw = gameProduction(l.s, group);
    const q = axis ? opp.get(l.opp) : undefined;
    let weight = 1;
    let oppPct: number | null = null;
    let oppRank: number | null = null;
    let oppOf: number | null = null;
    let oppNote = "unmeasured";
    if (axis && q) {
      oppPct = q.pct[axis];
      oppRank = q.rank[axis];
      oppOf = q.of;
      weight = weightFor(oppPct);
      oppNote = `No. ${oppRank} of ${oppOf} ${AXIS_LABEL[axis]}`;
    } else if (axis && !cls.get(l.opp)) {
      oppNote = "opponent not in the team digest";
    } else if (axis) {
      oppNote = "no advanced stats for this opponent";
    } else {
      oppNote = "no production axis for this position";
    }
    return {
      gameId: l.g, week: l.wk, opponent: l.opp, homeAway: l.ha, oppPct, oppRank, oppOf, oppNote, weight,
      raw: Math.round(raw * 10) / 10, adjusted: Math.round(raw * weight * 10) / 10, line: gameLineText(l.s, group), stats: l.s,
    };
  });
}

/** Opponent-adjusted production for one player. Undefined when there is no game log. */
export function adjustedProduction(playerId: string, group?: string): AdjustedProduction | undefined {
  const logs = genGamelogs();
  const lines = logs?.players[playerId];
  if (!lines?.length) return undefined;
  const p = playerById().get(playerId);
  const g = group ?? groupOf(p?.p);
  if (!g) return undefined;
  const rows = rowsFor(lines, g, p?.c ?? null);
  const n = rows.length;
  const rawAvg = rows.reduce((s, r) => s + r.raw, 0) / n;
  const adjAvg = rows.reduce((s, r) => s + r.adjusted, 0) / n;
  return { playerId, group: g, axis: AXIS_OF_GROUP[g] ?? null, games: n, rawAvg: Math.round(rawAvg * 10) / 10, adjAvg: Math.round(adjAvg * 10) / 10, ratio: rawAvg > 0 ? Math.round((adjAvg / rawAvg) * 100) / 100 : null, rows };
}

export function qocLabel(avgPct: number | null): QocLabel {
  if (avgPct === null) return "unmeasured";
  return avgPct >= 62 ? "tough" : avgPct <= 38 ? "soft" : "average";
}

/** Average opponent percentile faced on the player's production axis, with a plain label. */
export function qualityOfCompetition(playerId: string, group?: string): QualityOfCompetition {
  const a = adjustedProduction(playerId, group);
  const axis = a?.axis ?? null;
  if (!a || !axis) return { playerId, axis, avgPct: null, measured: 0, games: a?.games ?? 0, label: "unmeasured", text: "Schedule strength unmeasured: no game log or no opponent data." };
  const measured = a.rows.filter((r) => r.oppPct !== null);
  const pool = measured.map((r) => r.oppPct as number);
  if (!pool.length) return { playerId, axis, avgPct: null, measured: 0, games: a.games, label: "unmeasured", text: "Schedule strength unmeasured: no opponent in the advanced-stats digest." };
  const avgPct = Math.round(pool.reduce((s, v) => s + v, 0) / pool.length);
  const label = qocLabel(avgPct);
  const text = `vs ${label} schedule so far: average opponent in the ${ordinal(avgPct)} percentile of ${AXIS_LABEL[axis]} over ${pool.length} ${pool.length === 1 ? "game" : "games"}`;
  return { playerId, axis, avgPct, measured: pool.length, games: a.games, label, text };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function playerById() {
  return memoSync("adj:playerById", 3600, () => new Map(genPlayers().map((p) => [p.id, p])));
}

/* ------------------------------------------------------------- index */

export interface AdjustedIndexEntry {
  rawAvg: number;
  adjAvg: number;
  games: number;
  adjPct: number; // percentile of adjAvg within classification + group, among players with logs and production
  rawLogPct: number; // percentile of rawAvg in the same pool (for the report: how much the adjustment moved him)
  qoc: number | null;
  qocLabel: QocLabel;
}

export interface AdjustedIndex {
  byId: Map<string, AdjustedIndexEntry>;
  stamp: string;
  loaded: boolean;
}

function pctLE(sorted: number[], v: number): number {
  if (!sorted.length) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / sorted.length) * 100);
}

/** Every player with a game log, scored and ranked within classification + group. radar.ts blends adjPct into production. */
export function adjustedIndex(): AdjustedIndex {
  const stamp = gamelogsStamp();
  return memoSync(`adj:index:${stamp}`, 3600, () => {
    const logs = genGamelogs();
    const byId = new Map<string, AdjustedIndexEntry>();
    if (!logs) return { byId, stamp, loaded: false };
    const players = playerById();
    const tables = new Map<string, { adj: number[]; raw: number[] }>();
    const tmp = new Map<string, { key: string; a: AdjustedProduction; q: QualityOfCompetition }>();
    for (const id of Object.keys(logs.players)) {
      const p = players.get(id);
      if (!p || !p.c) continue;
      const g = groupOf(p.p);
      if (!g || !AXIS_OF_GROUP[g]) continue;
      const a = adjustedProduction(id, g);
      if (!a || a.rawAvg <= 0) continue;
      const key = `${p.c}:${g}`;
      const t = tables.get(key) ?? tables.set(key, { adj: [], raw: [] }).get(key)!;
      t.adj.push(a.adjAvg);
      t.raw.push(a.rawAvg);
      tmp.set(id, { key, a, q: qualityOfCompetition(id, g) });
    }
    for (const t of tables.values()) {
      t.adj.sort((x, y) => x - y);
      t.raw.sort((x, y) => x - y);
    }
    for (const [id, { key, a, q }] of tmp) {
      const t = tables.get(key)!;
      byId.set(id, { rawAvg: a.rawAvg, adjAvg: a.adjAvg, games: a.games, adjPct: pctLE(t.adj, a.adjAvg), rawLogPct: pctLE(t.raw, a.rawAvg), qoc: q.avgPct, qocLabel: q.label });
    }
    return { byId, stamp, loaded: true };
  });
}

export const gamelogsLoaded = () => genGamelogs() !== undefined;
export const gamelogsMeta = () => genGamelogs()?.meta;
