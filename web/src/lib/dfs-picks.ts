/**
 * The value picks' record. Server-only.
 *
 * Lock: the first time a slate's value lists are built while a pick's game is still to kick off, the picks (only those
 * not yet started) and the slate's whole priced pool are written to data/dk/picks-<date>.json and never rewritten.
 * Grade: once a pick's game has posted stat lines (gamelogs.json), his DraftKings points are compared with every player
 * at his position within $500 of his salary on that slate (his price-mates, 75%+ to play like the picks; a player with no
 * stat line in a posted game scored 0, for picks and mates alike). Beat = more points than the price-mates' average.
 * There is no free history of DraftKings salaries, so this forward record is the only test of the value lists.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dkPoints } from "./dfs";
import type { SlateSim } from "./dfs-slate";
import type { ValuePick } from "./dfs-value";
import { gamelogsStamp, genGamelogs } from "./generated";
import { memoSync } from "./memo";

const DIR = path.join(process.cwd(), "data", "dk");
const MATE_RANGE = 500;

interface PoolRow {
  key: string;
  id?: string;
  pos: string;
  salary: number;
  gameId: string;
  pPlay: number;
}
interface PicksFile {
  date: string;
  lockedAt: string;
  picks: (ValuePick & { list: "safest" | "upside" })[];
  pool: PoolRow[];
}

/** Save the slate's picks before kickoff (once; the file is never rewritten). */
export function lockPicks(sim: SlateSim, lists: { safest: ValuePick[]; upside: ValuePick[] }): void {
  const file = path.join(DIR, `picks-${sim.date}.json`);
  if (existsSync(file)) return;
  const now = Date.now();
  const picks = [...lists.safest.map((p) => ({ ...p, list: "safest" as const })), ...lists.upside.map((p) => ({ ...p, list: "upside" as const }))].filter((p) => Date.parse(p.kickoff) > now);
  if (!picks.length) return;
  const pool: PoolRow[] = sim.players.filter((p) => p.play.pos !== "DST").map((p) => ({ key: p.key, id: p.play.id, pos: p.play.pos, salary: p.play.salary, gameId: p.play.gameId, pPlay: p.pPlay }));
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ date: sim.date, lockedAt: new Date(now).toISOString(), picks, pool } satisfies PicksFile));
  } catch {
    /* the record skips a slate it could not save */
  }
}

export interface GradedPick {
  date: string;
  list: "safest" | "upside";
  name: string;
  pos: string;
  salary: number;
  gap: number;
  dk: number;
  mates: number; // the price-mates' average
  edge: number; // dk - mates
}

export interface PicksRecord {
  graded: GradedPick[];
  slates: number;
  pending: number;
  summary: Record<"all" | "safest" | "upside", { n: number; beat: number; edge: number }>;
}

/** Every saved pick graded so far, with the beat rate and the average edge over price-mates. */
export function picksRecord(): PicksRecord {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
  return memoSync(`dfs-picks:${gamelogsStamp()}:${files.join(",")}`, 300, () => {
    const logs = genGamelogs();
    const graded: GradedPick[] = [];
    let pending = 0;
    const slates = new Set<string>();
    // DK points by player and game (0 when his game posted and he has no line).
    const dkOf = (id: string | undefined, gameId: string): number | undefined => {
      if (!logs?.games[gameId]) return undefined;
      const line = id ? logs.players[id]?.find((l) => l.g === gameId) : undefined;
      return line ? dkPoints(line.s) : 0;
    };
    for (const f of files) {
      let file: PicksFile;
      try {
        file = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as PicksFile;
      } catch {
        continue;
      }
      for (const p of file.picks) {
        const dk = dkOf(p.id, p.gameId);
        if (dk === undefined) {
          pending++;
          continue;
        }
        const mates = file.pool
          .filter((m) => m.key !== p.key && m.pos === p.pos && Math.abs(m.salary - p.salary) <= MATE_RANGE && m.pPlay >= 0.75)
          .map((m) => dkOf(m.id, m.gameId))
          .filter((x): x is number => x !== undefined);
        if (!mates.length) continue;
        const avg = mates.reduce((t, x) => t + x, 0) / mates.length;
        graded.push({ date: file.date, list: p.list, name: p.name, pos: p.pos, salary: p.salary, gap: p.gap, dk: Math.round(dk * 10) / 10, mates: Math.round(avg * 10) / 10, edge: Math.round((dk - avg) * 10) / 10 });
        slates.add(file.date);
      }
    }
    const sum = (xs: GradedPick[]) => ({ n: xs.length, beat: xs.length ? xs.filter((x) => x.edge > 0).length / xs.length : 0, edge: xs.length ? Math.round((xs.reduce((t, x) => t + x.edge, 0) / xs.length) * 10) / 10 : 0 });
    return {
      graded: graded.sort((a, b) => b.date.localeCompare(a.date) || b.edge - a.edge),
      slates: slates.size,
      pending,
      summary: { all: sum(graded), safest: sum(graded.filter((x) => x.list === "safest")), upside: sum(graded.filter((x) => x.list === "upside")) },
    };
  });
}
