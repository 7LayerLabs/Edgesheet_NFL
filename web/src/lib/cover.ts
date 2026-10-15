/**
 * Cover chances from what actually happened at each closing line (audit 2026-10-12, item 3.2). scripts/backtest-replay.mjs
 * writes data/backtest/margins.json: for each favorite line from 0 to 20 by half points, the share of games the favorite
 * won by each margin, 2015 to 2025, blended 80/20 with a normal curve so thin tails are not zero. The key numbers (3, 7,
 * 10) keep their real weight, so half a point through 3 is priced the way games actually land. Checked on 2022-25: the
 * table gave closing favorites a 49.7% chance to cover, and they covered 49.6%. Server-only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

interface MarginTable {
  minMargin: number;
  maxMargin: number;
  lines: { line: number; games: number; pmf: number[] }[];
}

const table = (): MarginTable | undefined =>
  memoSync("cover:margins", 3600, () => {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), "data", "backtest", "margins.json"), "utf8")) as MarginTable;
    } catch {
      return undefined;
    }
  });

/**
 * Each side's chance to cover the posted spread, and the chance of a push, when the fair home margin is `fairHome`.
 * Both numbers are home margins in points (positive = home favored).
 */
export function coverChance(fairHome: number, postedHome: number): { home: number; away: number; push: number } | undefined {
  const t = table();
  if (!t) return undefined;
  const favHome = fairHome >= 0;
  const pmf = t.lines[Math.round(Math.min(20, Math.abs(fairHome)) * 2)]?.pmf;
  if (!pmf) return undefined;
  // The table is the fair favorite's margin; he covers when he wins by more than the posted number from his side.
  const need = favHome ? postedHome : -postedHome;
  let over = 0;
  let push = 0;
  pmf.forEach((p, i) => {
    const m = i + t.minMargin;
    if (m > need) over += p;
    else if (m === need) push += p;
  });
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const fav = r(over);
  const dog = r(Math.max(0, 1 - over - push));
  return favHome ? { home: fav, away: dog, push: r(push) } : { home: dog, away: fav, push: r(push) };
}
