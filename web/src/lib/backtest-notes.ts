/**
 * Plain-words verdicts from the storyline and splits backtests (scripts/backtest-stories.mts, scripts/backtest-splits.mts;
 * results in data/backtest/stories.json and splits.json), for the pages that show those histories. Server-only. With no
 * results file, every note is undefined and the pages show the history without a verdict.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

interface StoryResult { n: number; diff: number; ci: number[]; beat: number; baseBeat: number; pass: boolean }
interface Stories { seasons: number[]; population: { games: number }; results: Record<string, StoryResult> }
interface Splits { vsOpponent?: { pairs: number; r: number; slope: number; pass: boolean } }

function load<T>(file: string): T | undefined {
  const f = path.join(process.cwd(), "data", "backtest", file);
  if (!existsSync(f)) return undefined;
  return memoSync(`backtest:${file}:${statSync(f).mtimeMs}`, 3600, () => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as T;
    } catch {
      return undefined;
    }
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
const STORY: Record<string, { key: string; words: string; base: string }> = {
  revenge: { key: "revenge", words: "revenge games", base: "their other games" },
  hometown: { key: "hometown", words: "birth-city games", base: "their other road games" },
  college: { key: "college-state", words: "college-state games", base: "their other road games" },
  "home-state": { key: "home-state", words: "birth-state games", base: "their other road games" },
};

/** The backtest line for one storyline kind (revenge, hometown, college, home-state). */
export function storyNote(kind: string): string | undefined {
  const s = load<Stories>("stories.json");
  const m = STORY[kind];
  const r = m ? s?.results[m.key] : undefined;
  if (!s || !m || !r) return undefined;
  return `Tested on ${s.seasons[0]}-${s.seasons[1]}: in ${r.n.toLocaleString("en-US")} ${m.words}, players averaged ${signed(r.diff)} DK against ${m.base} and beat their own average ${pct(r.beat)} of the time (${pct(r.baseBeat)} in ${m.base}). ${r.pass ? "That passes our test." : "Not a measured edge."}`;
}

/** One line for the whole set of storylines. */
export function storiesSummary(): string | undefined {
  const s = load<Stories>("stories.json");
  if (!s) return undefined;
  const passed = Object.entries(s.results).filter(([, r]) => r.pass).map(([k]) => k);
  return passed.length
    ? `Tested on ${s.seasons[0]}-${s.seasons[1]}: ${passed.join(", ")} beat players' normal games by our test.`
    : `Tested on ${s.seasons[0]}-${s.seasons[1]} (${s.population.games.toLocaleString("en-US")} games): no storyline beat a player's normal games. Players beat their own average in ${pct(s.results.hometown?.beat ?? 0)} of birth-city games. They make good stories, not edges.`;
}

/** The backtest line for history against one opponent. */
export function vsOpponentNote(): string | undefined {
  const v = load<Splits>("splits.json")?.vsOpponent;
  if (!v) return undefined;
  return v.pass
    ? `Past games against one team carried into the next meeting in 2019-2025 (correlation ${v.r}).`
    : `Past games against one team did not predict the next meeting: across ${v.pairs.toLocaleString("en-US")} games since 2019 the correlation was ${v.r.toFixed(2)}. A player who beat his average by 10 DK against a team beat it by ${(v.slope * 10).toFixed(1)} the next time, on average.`;
}
