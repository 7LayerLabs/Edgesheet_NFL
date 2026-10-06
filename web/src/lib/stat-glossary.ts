/**
 * What each season-line stat means and what counts as good, for the player page's info tips. Server-only.
 *
 * "Good" is never a number typed in here: it is this season's league at his position, among players over a volume bar
 * (10 pass attempts a week for quarterbacks, 5 carries for backs, 3 targets for receivers, half the games and 30% of the
 * defense's snaps for defenders): the average, where the top quarter starts, the best, and his rank. Season totals (EPA)
 * are compared per play, so games played do not decide the rank.
 */
import { genMeta, genPlayers, playersStamp, type GenPlayer, type StatLine } from "./generated";
import { groupOf, type PosGroup } from "./radar";
import { memoSync } from "./memo";

export interface StatInfo {
  what: string;
  /** The league at his position and his place in it, or why there is no comparison. */
  context?: string;
}

type Bench = {
  value: (s: StatLine) => number | undefined;
  higher: boolean;
  fmt: (n: number) => string;
  /** "per dropback": the comparison's unit when it differs from the number shown. */
  basis?: string;
};

const n = (s: StatLine, k: string) => s[k] ?? 0;
const per = (k: string, d: string) => (s: StatLine) => (n(s, d) > 0 ? n(s, k) / n(s, d) : undefined);
const perGame = (k: string) => per(k, "gp");
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => (Math.round(x * 100) / 100 || 0).toFixed(2);
const signed = (fmt: (x: number) => string) => (x: number) => `${x > 0 ? "+" : ""}${fmt(x)}`;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const game = (fmt: (x: number) => string = f1): Pick<Bench, "fmt" | "basis"> => ({ fmt, basis: "per game" });

/** Definitions by label, with position overrides as "QB:TD". */
const WHAT: Record<string, string> = {
  "Comp / Att": "Completions and pass attempts. The comparison uses completion rate.",
  "Pass yds": "Passing yards.",
  "QB:TD": "Touchdown passes.",
  "QB:INT": "Interceptions thrown. The comparison uses interceptions per attempt, where lower is better.",
  "Y/A": "Yards per pass attempt: passing yards divided by attempts. Sacks are not attempts.",
  CPOE: "Completion percentage over expected: how much more or less often his passes are completed than an average quarterback would complete the same throws, judged by how far downfield, where on the field, and the down and distance (nflverse model). 0 means exactly what the model expects; the number is in percentage points.",
  "Pass EPA": "Expected points added on his dropbacks, added up. Every play moves the offense's expected points (set by down, distance, and field position): a completion that moves the chains adds, a sack or interception takes away. This is a season total, so the comparison uses EPA per dropback.",
  Sacked: "Times sacked. The comparison uses sacks per dropback, where lower is better.",
  "QB:Rush yds": "Rushing yards: scrambles and designed runs.",
  Carries: "Rushing attempts.",
  "Rush yds": "Rushing yards.",
  "Y/C": "Yards per carry.",
  "Rush TD": "Rushing touchdowns.",
  "Rush EPA": "Expected points added on his carries, added up (see Pass EPA for how a play is scored). Compared per carry.",
  Targets: "Passes thrown his way, caught or not.",
  Rec: "Catches.",
  "Rec yds": "Receiving yards.",
  "Y/R": "Yards per catch.",
  TD: "Receiving touchdowns.",
  "Target share": "His share of the team's targets in the games he played.",
  "Air yards share": "His share of the team's air yards in the games he played: how far passes thrown his way traveled past the line of scrimmage, caught or not. A high share means he gets the downfield looks.",
  "Rec EPA": "Expected points added on passes thrown his way, added up (see Pass EPA for how a play is scored). Compared per target.",
  Tackles: "Total tackles: solo plus assisted.",
  Solo: "Tackles made without help.",
  TFL: "Tackles for loss: tackles behind the line of scrimmage.",
  Sacks: "Sacks; a shared sack counts as half.",
  "QB hits": "Times he hit the quarterback on a pass play.",
  PD: "Passes defended: throws he got a hand on, broken up or tipped.",
  INT: "Interceptions.",
  FF: "Forced fumbles.",
  "INT yds": "Return yards after his interceptions.",
  "Def TD": "Touchdowns scored on defense.",
  FG: "Field goals made and attempted. The comparison uses the make rate.",
  Long: "Longest field goal.",
  Pct: "Field goal make rate.",
  Punts: "Punts.",
  Avg: "Gross yards per punt, before the return.",
  "Inside 20": "Punts that ended inside the opponent's 20-yard line. The comparison uses the share of his punts.",
};

/** How each stat is compared; labels without an entry get the definition only. */
const BENCH: Record<string, Bench> = {
  "Comp / Att": { value: (s) => (n(s, "pa") ? n(s, "pc") / n(s, "pa") : undefined), higher: true, fmt: pct, basis: "completion rate" },
  "Pass yds": { value: perGame("py"), higher: true, ...game((x) => String(Math.round(x))) },
  "QB:TD": { value: perGame("ptd"), higher: true, ...game() },
  "QB:INT": { value: per("pint", "pa"), higher: false, fmt: pct, basis: "per attempt" },
  "Y/A": { value: (s) => s.ypa, higher: true, fmt: f1 },
  CPOE: { value: (s) => s.cpoe, higher: true, fmt: signed(f1) },
  "Pass EPA": { value: (s) => (n(s, "pa") + n(s, "sks") > 0 ? n(s, "pepa") / (n(s, "pa") + n(s, "sks")) : undefined), higher: true, fmt: signed(f2), basis: "per dropback" },
  Sacked: { value: (s) => (n(s, "pa") + n(s, "sks") > 0 ? n(s, "sks") / (n(s, "pa") + n(s, "sks")) : undefined), higher: false, fmt: pct, basis: "per dropback" },
  "QB:Rush yds": { value: perGame("ry"), higher: true, ...game() },
  Carries: { value: perGame("ra"), higher: true, ...game() },
  "Rush yds": { value: perGame("ry"), higher: true, ...game() },
  "Y/C": { value: (s) => s.ypc, higher: true, fmt: f1 },
  "Rush TD": { value: perGame("rtd"), higher: true, ...game(f2) },
  "Rush EPA": { value: per("repa", "ra"), higher: true, fmt: signed(f2), basis: "per carry" },
  Targets: { value: perGame("tgt"), higher: true, ...game() },
  Rec: { value: perGame("rec"), higher: true, ...game() },
  "Rec yds": { value: perGame("rcy"), higher: true, ...game() },
  "Y/R": { value: (s) => s.ypr, higher: true, fmt: f1 },
  TD: { value: perGame("rctd"), higher: true, ...game(f2) },
  "Target share": { value: (s) => s.tshare, higher: true, fmt: pct0 },
  "Air yards share": { value: (s) => s.ayshare, higher: true, fmt: pct0 },
  "Rec EPA": { value: per("rcepa", "tgt"), higher: true, fmt: signed(f2), basis: "per target" },
  Tackles: { value: perGame("tk"), higher: true, ...game() },
  Solo: { value: perGame("solo"), higher: true, ...game() },
  TFL: { value: perGame("tfl"), higher: true, ...game(f2) },
  Sacks: { value: perGame("sk"), higher: true, ...game(f2) },
  "QB hits": { value: perGame("hur"), higher: true, ...game(f2) },
  PD: { value: perGame("pd"), higher: true, ...game(f2) },
  INT: { value: perGame("int"), higher: true, ...game(f2) },
  FF: { value: perGame("ff"), higher: true, ...game(f2) },
  FG: { value: (s) => (n(s, "fga") ? n(s, "fgm") / n(s, "fga") : undefined), higher: true, fmt: pct, basis: "make rate" },
  Pct: { value: (s) => (n(s, "fga") ? n(s, "fgm") / n(s, "fga") : undefined), higher: true, fmt: pct },
  Avg: { value: (s) => s.ypp, higher: true, fmt: f1 },
  "Inside 20": { value: per("pin20", "pno"), higher: true, fmt: pct0, basis: "of his punts" },
};

const PLURAL: Record<PosGroup, string> = {
  QB: "quarterbacks", RB: "running backs", WR: "wide receivers", TE: "tight ends", OL: "linemen", DL: "interior linemen",
  EDGE: "edge rushers", LB: "linebackers", CB: "cornerbacks", S: "safeties", ST: "specialists",
};

/** The volume bar for a comparison at a position, through `weeks` weeks: who counts, in words. */
function bar(group: PosGroup, label: string, weeks: number): { ok: (p: GenPlayer) => boolean; words: string } {
  const w = Math.max(1, weeks);
  const s = (p: GenPlayer) => p.s ?? {};
  if (group === "QB") return { ok: (p) => n(s(p), "pa") >= 10 * w, words: `${10 * w}+ pass attempts` };
  if (group === "RB") return { ok: (p) => n(s(p), "ra") >= 5 * w, words: `${5 * w}+ carries` };
  if (group === "WR" || group === "TE") return { ok: (p) => n(s(p), "tgt") >= 3 * w, words: `${3 * w}+ targets` };
  if (group === "ST") {
    if (label === "Avg" || label === "Inside 20") return { ok: (p) => n(s(p), "pno") >= 2 * w, words: `${2 * w}+ punts` };
    return { ok: (p) => n(s(p), "fga") >= w, words: `${w}+ field goal tries` };
  }
  const games = Math.ceil(w / 2);
  return { ok: (p) => n(s(p), "gp") >= games && (p.u?.d ?? 0) >= 0.3, words: `${games}+ games and 30%+ of the defense's snaps` };
}

/** The definition and, where it applies, the league comparison for one season-line stat. */
export function statInfo(group: PosGroup, label: string, playerId: string): StatInfo | undefined {
  const key = WHAT[`${group}:${label}`] ? `${group}:${label}` : label;
  const what = WHAT[key];
  if (!what) return undefined;
  const bench = BENCH[key];
  if (!bench) return { what };
  const weeks = genMeta()?.statsThroughWeek ?? 1;
  const board = memoSync(`statbench:${group}:${key}:${playersStamp()}`, 3600, () => {
    const b = bar(group, label, weeks);
    const rows = genPlayers()
      .filter((p) => groupOf(p) === group && p.s && b.ok(p))
      .map((p) => ({ id: p.id, v: bench.value(p.s!) }))
      .filter((x): x is { id: string; v: number } => x.v !== undefined && Number.isFinite(x.v))
      .sort((a, b2) => (bench.higher ? b2.v - a.v : a.v - b2.v));
    return { rows, words: b.words };
  });
  const { rows, words } = board;
  if (rows.length < 5) return { what, context: `Too few ${PLURAL[group]} over the bar (${words}) to compare yet.` };
  const avg = rows.reduce((t, x) => t + x.v, 0) / rows.length;
  const top = rows[Math.floor(rows.length / 4)].v; // where the top quarter starts
  const basis = bench.basis ? ` (${bench.basis})` : "";
  const mine = rows.findIndex((x) => x.id === playerId);
  const him = mine >= 0 ? `He is No. ${mine + 1} of ${rows.length} at ${bench.fmt(rows[mine].v)}.` : `He is under the bar so far.`;
  return {
    what,
    context: `This season, ${PLURAL[group]} with ${words}${basis}: average ${bench.fmt(avg)}, top quarter ${bench.fmt(top)} ${bench.higher ? "or better" : "or lower"}, best ${bench.fmt(rows[0].v)}. ${him}`,
  };
}
