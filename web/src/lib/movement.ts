/**
 * Memory for the radar. scripts/snapshot.mjs writes data/snapshots/<date>/
 * {radar.json, forecast.json} once a week. This module reads them back and
 * answers "who moved": score deltas between the last two snapshots, band and
 * overall changes on the forecast board, and the full score series for a
 * sparkline. It never imports radar.ts (radar imports this), only the files.
 *
 * With one snapshot there is no movement yet, and every caller says so.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

export const SNAPSHOT_DIR = path.join(process.cwd(), "data", "snapshots");

export interface SnapshotRadarRow {
  id: string;
  name: string;
  team: string;
  pos: string;
  group: string;
  cls: string;
  classification: string | null;
  draftClass: number;
  score: number;
  tier: string;
  production: number;
  pedigree: number;
  usage: number;
}

export interface SnapshotForecastRow {
  id: string;
  name: string;
  team: string;
  pos: string;
  group: string;
  band: string;
  overall: number;
  posRank: number;
  estPick: number;
  adjusted: number;
  decision: string;
}

export interface RadarSnapshot {
  takenAt: string;
  date: string;
  season: number | null;
  ingestedAt: string | null;
  gamelogsAt: string | null;
  players: SnapshotRadarRow[];
}

export interface ForecastSnapshot {
  takenAt: string;
  date: string;
  draftYear: number;
  entries: SnapshotForecastRow[];
}

/* ------------------------------------------------------------ reading */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Snapshot dates, oldest first. Only folders that hold a radar.json count. */
export function listSnapshots(): string[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  try {
    return readdirSync(SNAPSHOT_DIR)
      .filter((d) => DATE_RE.test(d) && existsSync(path.join(SNAPSHOT_DIR, d, "radar.json")))
      .sort();
  } catch {
    return [];
  }
}

/** Changes when a snapshot is added or rewritten. Used in memo keys. */
export function movementStamp(): string {
  const dates = listSnapshots();
  if (!dates.length) return "none";
  const last = dates[dates.length - 1];
  let m = "";
  try {
    m = String(statSync(path.join(SNAPSHOT_DIR, last, "radar.json")).mtimeMs);
  } catch {}
  return `${dates.length}:${last}:${m}`;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function loadRadarSnapshot(date: string): RadarSnapshot | undefined {
  return memoSync(`snap:radar:${date}:${movementStamp()}`, 3600, () => readJson<RadarSnapshot>(path.join(SNAPSHOT_DIR, date, "radar.json")));
}

export function loadForecastSnapshot(date: string): ForecastSnapshot | undefined {
  return memoSync(`snap:forecast:${date}:${movementStamp()}`, 3600, () => readJson<ForecastSnapshot>(path.join(SNAPSHOT_DIR, date, "forecast.json")));
}

interface Loaded {
  dates: string[];
  latest?: { date: string; radar: Map<string, SnapshotRadarRow>; forecast: Map<string, SnapshotForecastRow>; radarRows: SnapshotRadarRow[] };
  previous?: { date: string; radar: Map<string, SnapshotRadarRow>; forecast: Map<string, SnapshotForecastRow> };
  /** Score series per player across every snapshot, oldest first. */
  series: Map<string, { date: string; score: number }[]>;
}

function loadAll(): Loaded {
  return memoSync(`snap:all:${movementStamp()}`, 3600, () => {
    const dates = listSnapshots();
    const series = new Map<string, { date: string; score: number }[]>();
    const maps = dates.map((date) => {
      const r = loadRadarSnapshot(date);
      const f = loadForecastSnapshot(date);
      const radar = new Map((r?.players ?? []).map((p) => [p.id, p]));
      const forecast = new Map((f?.entries ?? []).map((e) => [e.id, e]));
      for (const p of r?.players ?? []) (series.get(p.id) ?? series.set(p.id, []).get(p.id)!).push({ date, score: p.score });
      return { date, radar, forecast, radarRows: r?.players ?? [] };
    });
    const latest = maps[maps.length - 1];
    const previous = maps.length >= 2 ? maps[maps.length - 2] : undefined;
    return { dates, latest, previous, series };
  });
}

/* ----------------------------------------------------------- movement */

export type MoveReason = "declared" | "returning" | "production" | "pedigree" | "usage" | "tier" | "board" | "new" | "none";

export interface Movement {
  id: string;
  date: string; // latest snapshot
  prevDate: string; // previous snapshot
  score: number;
  prevScore: number;
  scoreDelta: number;
  productionDelta: number;
  pedigreeDelta: number;
  usageDelta: number;
  tierFrom: string;
  tierTo: string;
  bandFrom: string | null;
  bandTo: string | null;
  overallFrom: number | null;
  overallTo: number | null;
  /** Positive means he moved up the board (lower overall number). null when not on both boards. */
  overallDelta: number | null;
  decisionFrom: string | null;
  decisionTo: string | null;
  reason: MoveReason;
  reasonText: string;
}

function reasonFor(m: Omit<Movement, "reason" | "reasonText">): { reason: MoveReason; reasonText: string } {
  if (m.decisionTo === "declared" && m.decisionFrom !== "declared") return { reason: "declared", reasonText: "declared for the draft" };
  if (m.decisionTo === "returning" && m.decisionFrom !== "returning") return { reason: "returning", reasonText: "marked as returning to school" };
  const ap = Math.abs(m.productionDelta);
  const ag = Math.abs(m.pedigreeDelta);
  const au = Math.abs(m.usageDelta);
  if (ap && ap >= ag && ap >= au) return { reason: "production", reasonText: `production percentile ${m.productionDelta > 0 ? "up" : "down"} ${ap}` };
  if (ag && ag >= au) return { reason: "pedigree", reasonText: `pedigree ${m.pedigreeDelta > 0 ? "up" : "down"} ${ag} (recruiting rating changed in the source)` };
  if (au) return { reason: "usage", reasonText: `usage share ${m.usageDelta > 0 ? "up" : "down"} ${au}` };
  if (m.tierFrom !== m.tierTo) return { reason: "tier", reasonText: `tier ${m.tierFrom} to ${m.tierTo}` };
  if (m.overallDelta) return { reason: "board", reasonText: `board moved around him, ${m.overallDelta > 0 ? "up" : "down"} ${Math.abs(m.overallDelta)}` };
  return { reason: "none", reasonText: "no change" };
}

/** Movement between the last two snapshots for one player. Undefined with fewer than two snapshots or when he is missing from either. */
export function movementFor(id: string): Movement | undefined {
  const all = loadAll();
  if (!all.latest || !all.previous) return undefined;
  const cur = all.latest.radar.get(id);
  const prev = all.previous.radar.get(id);
  if (!cur || !prev) return undefined;
  const fc = all.latest.forecast.get(id);
  const fp = all.previous.forecast.get(id);
  const base = {
    id,
    date: all.latest.date,
    prevDate: all.previous.date,
    score: cur.score,
    prevScore: prev.score,
    scoreDelta: cur.score - prev.score,
    productionDelta: cur.production - prev.production,
    pedigreeDelta: cur.pedigree - prev.pedigree,
    usageDelta: cur.usage - prev.usage,
    tierFrom: prev.tier,
    tierTo: cur.tier,
    bandFrom: fp?.band ?? null,
    bandTo: fc?.band ?? null,
    overallFrom: fp?.overall ?? null,
    overallTo: fc?.overall ?? null,
    overallDelta: fp && fc ? fp.overall - fc.overall : null,
    decisionFrom: fp?.decision ?? null,
    decisionTo: fc?.decision ?? null,
  };
  return { ...base, ...reasonFor(base) };
}

/** Radar score at every snapshot, oldest first. Empty when the player has never been snapshotted. */
export function scoreSeries(id: string): { date: string; score: number }[] {
  return loadAll().series.get(id) ?? [];
}

export interface MoveRow {
  id: string;
  name: string;
  team: string;
  pos: string;
  group: string;
  cls: string;
  draftClass: number;
  score: number;
  prevScore: number;
  scoreDelta: number;
  tier: string;
  bandFrom: string | null;
  bandTo: string | null;
  overallFrom: number | null;
  overallTo: number | null;
  overallDelta: number | null;
  reason: MoveReason;
  reasonText: string;
}

export interface BiggestMoves {
  /** False until two snapshots exist. */
  available: boolean;
  snapshots: string[];
  latest: string | null;
  previous: string | null;
  /** Plain sentence for the UI when movement is not available yet. */
  note: string;
  risers: MoveRow[];
  fallers: MoveRow[];
  forecastRisers: MoveRow[];
  forecastFallers: MoveRow[];
}

function longDate(date: string): string {
  return new Date(`${date}T12:00:00-04:00`).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

/** Top n risers and fallers by radar score delta, and by forecast overall change, Division I only. */
export function biggestMoves(n = 5): BiggestMoves {
  const all = loadAll();
  const dates = all.dates;
  if (!all.latest || !all.previous) {
    const note = dates.length
      ? `First snapshot taken ${longDate(dates[0])}. Movement appears after the next weekly snapshot.`
      : "No snapshot taken yet. Run npm run snapshot once a week; movement appears after the second one.";
    return { available: false, snapshots: dates, latest: dates[dates.length - 1] ?? null, previous: null, note, risers: [], fallers: [], forecastRisers: [], forecastFallers: [] };
  }
  const rows: MoveRow[] = [];
  for (const cur of all.latest.radarRows) {
    if (cur.classification !== "fbs" && cur.classification !== "fcs") continue;
    const m = movementFor(cur.id);
    if (!m) continue;
    rows.push({
      id: cur.id, name: cur.name, team: cur.team, pos: cur.pos, group: cur.group, cls: cur.cls, draftClass: cur.draftClass,
      score: m.score, prevScore: m.prevScore, scoreDelta: m.scoreDelta, tier: m.tierTo,
      bandFrom: m.bandFrom, bandTo: m.bandTo, overallFrom: m.overallFrom, overallTo: m.overallTo, overallDelta: m.overallDelta,
      reason: m.reason, reasonText: m.reasonText,
    });
  }
  const byScore = [...rows].sort((a, b) => b.scoreDelta - a.scoreDelta || b.score - a.score);
  const risers = byScore.filter((r) => r.scoreDelta > 0).slice(0, n);
  const fallers = byScore.filter((r) => r.scoreDelta < 0).reverse().slice(0, n);
  const onBoard = rows.filter((r) => r.overallDelta !== null).sort((a, b) => (b.overallDelta ?? 0) - (a.overallDelta ?? 0));
  const forecastRisers = onBoard.filter((r) => (r.overallDelta ?? 0) > 0).slice(0, n);
  const forecastFallers = onBoard.filter((r) => (r.overallDelta ?? 0) < 0).reverse().slice(0, n);
  return {
    available: true,
    snapshots: dates,
    latest: all.latest.date,
    previous: all.previous.date,
    note: `Movement from the ${longDate(all.previous.date)} snapshot to ${longDate(all.latest.date)}.`,
    risers, fallers, forecastRisers, forecastFallers,
  };
}

export const snapshotDateLabel = longDate;
