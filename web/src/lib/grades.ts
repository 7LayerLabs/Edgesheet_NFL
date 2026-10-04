/**
 * Derek's own grades. One file, data/grades.json, keyed by player id (CFBD
 * athlete id). Each player holds an array of game grades: a 1..5 star grade and
 * a one-line note for a game he watched. The board (/board) puts his score next
 * to the radar and the forecast so the gap between his eyes and the model is
 * visible, and the tuner can later test whose read held up.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

export interface Grade {
  /** Game id, or "" when graded from the player page without a game in context. */
  gameId: string;
  /** Calendar date (YYYY-MM-DD, Eastern) of the game or of the grade. */
  date: string;
  /** 1..5 stars. */
  grade: number;
  note: string;
  /** When the grade was saved (ISO). */
  at: string;
  /** Display hints saved with the grade so the board can show a player even if the radar no longer has him. */
  name?: string;
  team?: string;
  pos?: string;
  cls?: string;
}

export type GradeStore = Record<string, Grade[]>;

const FILE = path.join(process.cwd(), "data", "grades.json");

function stamp() {
  try {
    return String(statSync(FILE).mtimeMs);
  } catch {
    return "missing";
  }
}

function readRaw(): GradeStore {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as GradeStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function readGrades(): GradeStore {
  return memoSync(`grades:${stamp()}`, 300, readRaw);
}

/** All grades for one player, newest first. */
export function gradesFor(playerId: string): Grade[] {
  const g = readGrades()[playerId] ?? [];
  return [...g].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
}

/** Average grade mapped to 0..100 (1 star = 0, 5 stars = 100). Undefined when ungraded. */
export function myScore(playerId: string): number | undefined {
  const g = gradesFor(playerId);
  if (!g.length) return undefined;
  const avg = g.reduce((s, x) => s + x.grade, 0) / g.length;
  return Math.round(((avg - 1) / 4) * 100);
}

export interface GradedPlayer {
  id: string;
  grades: Grade[];
  myScore: number;
  avgGrade: number;
  last: Grade;
}

/** Every player with at least one grade, highest score first. */
export function allGraded(): GradedPlayer[] {
  const store = readGrades();
  const out: GradedPlayer[] = [];
  for (const id of Object.keys(store)) {
    const grades = gradesFor(id);
    if (!grades.length) continue;
    const avgGrade = grades.reduce((s, x) => s + x.grade, 0) / grades.length;
    out.push({ id, grades, avgGrade, myScore: Math.round(((avgGrade - 1) / 4) * 100), last: grades[0] });
  }
  return out.sort((a, b) => b.myScore - a.myScore || b.grades.length - a.grades.length);
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

/** Save or replace the grade for (player, game). Returns the stored grade. */
export function setGrade(input: { playerId: string; gameId?: string; date?: string; grade: number; note?: string; name?: string; team?: string; pos?: string; cls?: string }): Grade {
  const store = readRaw();
  const list = store[input.playerId] ?? [];
  const gameId = clip(input.gameId, 40);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") ? input.date! : new Date().toISOString().slice(0, 10);
  const key = gameId || date;
  const grade: Grade = {
    gameId,
    date,
    grade: Math.max(1, Math.min(5, Math.round(input.grade))),
    note: clip(input.note, 240),
    at: new Date().toISOString(),
  };
  if (input.name) grade.name = clip(input.name, 80);
  if (input.team) grade.team = clip(input.team, 80);
  if (input.pos) grade.pos = clip(input.pos, 10);
  if (input.cls) grade.cls = clip(input.cls, 10);
  const idx = list.findIndex((g) => (g.gameId || g.date) === key);
  if (idx >= 0) {
    // Keep the note if the new save did not carry one (star tap after a note).
    if (!grade.note && list[idx].note) grade.note = list[idx].note;
    list[idx] = grade;
  } else list.push(grade);
  store[input.playerId] = list;
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 1));
  return grade;
}

/** Remove one grade (by game id or date key), or every grade for the player when no key is given. */
export function removeGrade(playerId: string, key?: string): number {
  const store = readRaw();
  const list = store[playerId] ?? [];
  const next = key ? list.filter((g) => (g.gameId || g.date) !== key) : [];
  const removed = list.length - next.length;
  if (next.length) store[playerId] = next;
  else delete store[playerId];
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 1));
  return removed;
}
