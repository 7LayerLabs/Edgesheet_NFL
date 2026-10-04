/**
 * Reads data/backtest/results.json, written by scripts/backtest.mjs. Server only (node:fs).
 * Missing file is not an error: the Track record page says the backtest has not been run.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

const FILE = path.join(process.cwd(), "data", "backtest", "results.json");

export interface GradeRow {
  games: number;
  withLine: number;
  winnerRate: number | null;
  winnerRight: number;
  winnerGraded: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  marketWinnerRate: number | null;
  marketMae: number | null;
  marketRmse: number | null;
  coverRate: number | null;
  coverRight: number;
  coverGraded: number;
  lean2CoverRate: number | null;
  lean2Graded: number;
  lean4CoverRate: number | null;
  lean4Graded: number;
  favoriteCoverRate: number | null;
  favoriteGraded: number;
  pushes: number;
  homeWinRate: number | null;
  calibration: { bucket: string; games: number; winRate: number | null }[];
}

export interface FitRow {
  home: number;
  perPoint: number;
  mae: number | null;
  winnerRate: number | null;
  coverRate: number | null;
  lean4CoverRate: number | null;
}

export interface BacktestResults {
  ranAt: string;
  seasons: number[];
  live: { home: number; perPoint: number; k: number; regress: string; sigma: number };
  overall: GradeRow;
  overallRegular: GradeRow;
  perSeason: { season: number; regular: GradeRow; all: GradeRow }[];
  fit: { best: FitRow; top: FitRow[] };
  notes: string[];
}

function stamp() {
  try {
    return String(statSync(FILE).mtimeMs);
  } catch {
    return "missing";
  }
}

export function backtestResults(): BacktestResults | undefined {
  return memoSync(`backtest:${stamp()}`, 300, () => {
    if (!existsSync(FILE)) return undefined;
    try {
      return JSON.parse(readFileSync(FILE, "utf8")) as BacktestResults;
    } catch {
      return undefined;
    }
  });
}
