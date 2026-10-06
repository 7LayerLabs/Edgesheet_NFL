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
interface CarryOver { pairs: number; r: number | null; pass: boolean }
interface LeagueWide { diff: number; ci: number[]; nIn: number }
type SplitGroup = Record<string, { leagueWide: LeagueWide; carryOver: CarryOver }>;
interface Splits { vsOpponent?: { pairs: number; r: number; slope: number; pass: boolean }; players?: SplitGroup; teams?: SplitGroup; defenses?: SplitGroup }

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

const SPLIT_WORDS: Record<string, string> = { home: "home and away", division: "division", primetime: "primetime", short: "short-week", "home-division": "home against a division rival" };

/** What the splits backtest found for one group (players, teams, defenses), in plain words, one line per finding. */
export function splitsNotes(group: "players" | "teams" | "defenses"): string[] {
  const s = load<Splits>("splits.json")?.[group];
  if (!s) return [];
  const carried = Object.entries(s).filter(([, v]) => v.carryOver.pass).map(([k]) => k);
  const out: string[] = [];
  if (group === "players") {
    const h = s.home?.carryOver;
    if (h?.pass) out.push(`A player's own home and away gap carried over in 2019-2025, weakly: about a fifth of it repeated (correlation ${h.r}).`);
    const not = Object.keys(s).filter((k) => !carried.includes(k)).map((k) => SPLIT_WORDS[k] ?? k);
    if (not.length) out.push(`His ${not.join(", ")} splits did not carry over.`);
  } else {
    out.push(carried.length ? `Carried over in 2019-2025: ${carried.map((k) => SPLIT_WORDS[k] ?? k).join(", ")}.` : `No ${group === "teams" ? "team's" : "defense's"} own split carried over from one season to the next in 2019-2025.`);
    // League-wide differences whose interval clears zero: "in the situation" against the other side of it.
    const WHERE: Record<string, [string, string]> = {
      home: ["at home", "on the road"],
      division: ["in division games", "in other games"],
      primetime: ["in primetime", "in other games"],
      short: ["on a short week", "on normal rest"],
      "home-division": ["at home against a division rival", "in their other games"],
    };
    for (const [k, v] of Object.entries(s)) {
      const lw = v.leagueWide;
      if (!(lw.ci[0] > 0 || lw.ci[1] < 0) || !WHERE[k]) continue;
      const [inS, outS] = WHERE[k];
      const who = group === "teams" ? "teams" : "defenses";
      const bet = group === "teams" && k === "primetime" ? primetimeBetNote() : undefined;
      const what = group === "teams" ? `${Math.abs(lw.diff).toFixed(1)} ${lw.diff > 0 ? "more" : "fewer"} points against the closing line than ${outS}${bet ? "" : " (not tested against the vig)"}` : `${Math.abs(lw.diff).toFixed(1)} ${lw.diff > 0 ? "more" : "fewer"} DK points than ${outS}`;
      out.push(`League-wide, ${who} ${inS} scored ${what}.${bet ? ` ${bet}` : ""}`);
    }
  }
  return out;
}

interface PrimetimeEra { seasons: string; window: string; underRate: number; roi: number }
interface Primetime { breakEven: number; eras: PrimetimeEra[]; bySeason: { season: number; underRate: number; games: number }[] }

/**
 * The primetime under as a bet (scripts/backtest-primetime.mjs, data/backtest/primetime.json): the hit rate by era
 * against the break-even, and the last two full seasons, so the 2019-2025 average is not read as a standing edge.
 */
export function primetimeBetNote(): string | undefined {
  const p = load<Primetime>("primetime.json");
  if (!p) return undefined;
  // One decimal: 51.9% and the 52.4% break-even must not both read "52%".
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const era = (s: string) => p.eras.find((e) => e.seasons === s && e.window === "primetime");
  const a = era("1999-2009");
  const b = era("2010-2018");
  const c = era("2019-2025");
  if (!a || !b || !c) return undefined;
  const full = p.bySeason.filter((s) => s.games >= 40).slice(-2);
  const recent = full.map((s) => `${pct(s.underRate)} in ${s.season}`).join(" and ");
  const now = p.bySeason.find((s) => s.games < 40);
  const lead = `Betting the under in every primetime game hit ${pct(c.underRate)} in 2019-2025`;
  const past = `but ${pct(a.underRate)} in 1999-2009 and ${pct(b.underRate)} in 2010-2018`;
  const lately = `${recent}${now ? `, ${pct(now.underRate)} so far in ${now.season} (${now.games} games)` : ""}`;
  return `${lead}, ${past}, and ${lately}, against ${pct(p.breakEven)} to break even: a stretch the market has caught up to, not a bet.`;
}

/** The backtest line for history against one opponent. */
export function vsOpponentNote(): string | undefined {
  const v = load<Splits>("splits.json")?.vsOpponent;
  if (!v) return undefined;
  return v.pass
    ? `Past games against one team carried into the next meeting in 2019-2025 (correlation ${v.r}).`
    : `Past games against one team did not predict the next meeting: across ${v.pairs.toLocaleString("en-US")} games since 2019 the correlation was ${v.r.toFixed(2)}. A player who beat his average by 10 DK against a team beat it by ${(v.slope * 10).toFixed(1)} the next time, on average.`;
}
