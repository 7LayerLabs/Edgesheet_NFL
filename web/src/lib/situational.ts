/**
 * Situational tendencies from play-by-play (data/generated/situational.json,
 * written by scripts/ingest.mjs from nflverse play-by-play). Server-only: reads the disk digest,
 * memoized by file mtime like generated.ts.
 *
 * Every number shown comes from counted plays. Rates carry their sample size,
 * and ranks are inside the classification among teams with at least
 * MIN_SAMPLE plays in that split. Teams under the sample get no rank.
 *
 * Public surface:
 *   situationsFor(school)                 ranked offense and defense splits, names, tempo
 *   situationCues(offSchool, defSchool)   plain-English lines pairing one offense with one defense
 *   gameCues(away, home)                  the 2 or 3 strongest cues for a game, both directions
 *   thirdDownTargets(school) / redZoneTargets(school)   top ball carriers and targets (for player cues)
 *   gradePassingDowns(gameId, offSchool, defSchool, edge)   postgame grade for the passing-downs axis
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

const FILE = path.join(process.cwd(), "data", "generated", "situational.json");
export const MIN_SAMPLE = 15;

/* ------------------------------------------------------------ digest */

interface Bucket { n: number; pass: number; succ: number; conv: number; td: number; havoc: number; x: number }
interface RawUnit {
  plays: number;
  early: Bucket;
  sd: Bucket;
  pd: Bucket;
  third: { short: Bucket; medium: Bucket; long: Bucket };
  fourth: Bucket;
  rz: Bucket & { trips: number; tdTrips: number };
  gl: Bucket;
  score: { lead: Bucket; close: Bucket; trail: Bucket };
  explosive: { rush: Bucket; pass: Bucket };
  tempo: { noHuddle: number; tagged: number; secsPerSnap: number | null; snapPairs: number; drivePlays: number; driveSecs: number };
}
export interface SituationName { name: string; id?: string; n: number; unmatched?: boolean }
interface RawTeam {
  c: "nfl" | "fbs" | "fcs" | "ii" | "iii" | null;
  games: number;
  off: RawUnit;
  def: RawUnit;
  thirdCarriers: SituationName[];
  thirdTargets: SituationName[];
  rzCarriers: SituationName[];
  rzTargets: SituationName[];
}
interface GameRow { plays: number; third: { n: number; conv: number }; pd: { n: number; succ: number } }
export interface SituationalDigest {
  meta: { ingestedAt: string; season: number; weeks: number[]; plays: number; games: number; teams: number; namesMatched: number; namesUnmatched: number; runtimeSec: number };
  teams: Record<string, RawTeam>;
  games: Record<string, { week: number; seasonType: string; teams: Record<string, GameRow> }>;
}

function stamp() {
  try {
    return String(statSync(FILE).mtimeMs);
  } catch {
    return "missing";
  }
}

export function situationalDigest(): SituationalDigest | undefined {
  return memoSync(`sit:digest:${stamp()}`, 3600, () => {
    if (!existsSync(FILE)) return undefined;
    try {
      return JSON.parse(readFileSync(FILE, "utf8")) as SituationalDigest;
    } catch {
      return undefined;
    }
  });
}

export const situationalLoaded = () => situationalDigest() !== undefined;
export const situationalAsOf = () => situationalDigest()?.meta.ingestedAt;

/* ------------------------------------------------------------ splits */

export interface SplitRow {
  key: string;
  /** Short label for tables: "3rd and medium pass rate". */
  label: string;
  /** Plain words for sentences: "throws on third-and-medium". */
  rate: number | null;
  n: number;
  /** "71% (17 of 24)" or "unmeasured". */
  value: string;
  /** style = how they play (rank 1 = highest rate). quality = how well (rank 1 = best for that side). */
  kind: "style" | "quality" | "tempo";
  rank?: number;
  of?: number;
  pct?: number;
  small: boolean;
}

type Side = "off" | "def";
interface SplitDef {
  key: string;
  label: string;
  kind: SplitRow["kind"];
  /** quality only: does the offense want this high? The defense wants the opposite. */
  offHigh?: boolean;
  /** tempo only: rank 1 = fastest. */
  fastHigh?: boolean;
  offenseOnly?: boolean;
  get: (u: RawUnit) => { num: number; den: number };
}

const SPLITS: SplitDef[] = [
  { key: "earlyPass", label: "Early-down pass rate", kind: "style", get: (u) => ({ num: u.early.pass, den: u.early.n }) },
  { key: "pdPass", label: "Passing-downs pass rate", kind: "style", get: (u) => ({ num: u.pd.pass, den: u.pd.n }) },
  { key: "pdSucc", label: "Passing-downs success", kind: "quality", offHigh: true, get: (u) => ({ num: u.pd.succ, den: u.pd.n }) },
  { key: "pdHavoc", label: "Havoc on passing downs", kind: "quality", offHigh: false, get: (u) => ({ num: u.pd.havoc, den: u.pd.n }) },
  { key: "thirdShortPass", label: "3rd and short (1-3) pass rate", kind: "style", get: (u) => ({ num: u.third.short.pass, den: u.third.short.n }) },
  { key: "thirdShortConv", label: "3rd and short conversion", kind: "quality", offHigh: true, get: (u) => ({ num: u.third.short.conv, den: u.third.short.n }) },
  { key: "thirdMedPass", label: "3rd and medium (4-6) pass rate", kind: "style", get: (u) => ({ num: u.third.medium.pass, den: u.third.medium.n }) },
  { key: "thirdMedConv", label: "3rd and medium conversion", kind: "quality", offHigh: true, get: (u) => ({ num: u.third.medium.conv, den: u.third.medium.n }) },
  { key: "thirdLongPass", label: "3rd and long (7+) pass rate", kind: "style", get: (u) => ({ num: u.third.long.pass, den: u.third.long.n }) },
  { key: "thirdLongConv", label: "3rd and long conversion", kind: "quality", offHigh: true, get: (u) => ({ num: u.third.long.conv, den: u.third.long.n }) },
  { key: "rzPass", label: "Red zone pass rate", kind: "style", get: (u) => ({ num: u.rz.pass, den: u.rz.n }) },
  { key: "rzTd", label: "Red zone TD rate (per trip)", kind: "quality", offHigh: true, get: (u) => ({ num: u.rz.tdTrips, den: u.rz.trips }) },
  { key: "glPass", label: "Goal line (inside 5) pass rate", kind: "style", get: (u) => ({ num: u.gl.pass, den: u.gl.n }) },
  { key: "glTd", label: "Goal line TD rate (per play)", kind: "quality", offHigh: true, get: (u) => ({ num: u.gl.td, den: u.gl.n }) },
  { key: "leadPass", label: "Pass rate leading by 9+", kind: "style", get: (u) => ({ num: u.score.lead.pass, den: u.score.lead.n }) },
  { key: "closePass", label: "Pass rate within 8", kind: "style", get: (u) => ({ num: u.score.close.pass, den: u.score.close.n }) },
  { key: "trailPass", label: "Pass rate trailing by 9+", kind: "style", get: (u) => ({ num: u.score.trail.pass, den: u.score.trail.n }) },
  { key: "xRush", label: "Explosive rush rate (12+)", kind: "quality", offHigh: true, get: (u) => ({ num: u.explosive.rush.x, den: u.explosive.rush.n }) },
  { key: "xPass", label: "Explosive pass rate (20+)", kind: "quality", offHigh: true, get: (u) => ({ num: u.explosive.pass.x, den: u.explosive.pass.n }) },
  { key: "noHuddle", label: "No-huddle rate", kind: "tempo", fastHigh: true, offenseOnly: true, get: (u) => ({ num: u.tempo.noHuddle, den: u.tempo.tagged }) },
  { key: "playsPerMin", label: "Plays per minute of possession", kind: "tempo", fastHigh: true, offenseOnly: true, get: (u) => ({ num: u.tempo.drivePlays * 60, den: u.tempo.driveSecs }) },
  { key: "secsPerSnap", label: "Seconds between snaps (median)", kind: "tempo", fastHigh: false, offenseOnly: true, get: (u) => ({ num: (u.tempo.secsPerSnap ?? 0) * u.tempo.snapPairs, den: u.tempo.snapPairs }) },
];
const BY_KEY = new Map(SPLITS.map((s) => [s.key, s]));

/** Sample size that matters for a split: plays for most, trips for red zone TD, drive seconds for pace. */
function sampleOf(d: SplitDef, u: RawUnit): number {
  if (d.key === "rzTd") return u.rz.trips;
  if (d.key === "playsPerMin") return u.tempo.drivePlays;
  if (d.key === "secsPerSnap") return u.tempo.snapPairs;
  return d.get(u).den;
}

function rankIn(sorted: number[], v: number, wantHigh: boolean): { rank: number; of: number; pct: number } {
  const n = sorted.length;
  let below = 0;
  while (below < n && sorted[below] < v) below++;
  const rank = wantHigh ? n - below : below + 1;
  const pct = Math.round(((wantHigh ? below : n - below - 1) / Math.max(1, n - 1)) * 100);
  return { rank: Math.max(1, Math.min(n, rank)), of: n, pct: Math.max(0, Math.min(100, pct)) };
}

/** Sorted rate tables per classification, side, and split, over teams that meet the sample. */
function tables(): Map<string, number[]> {
  return memoSync(`sit:tables:${stamp()}`, 3600, () => {
    const out = new Map<string, number[]>();
    const dg = situationalDigest();
    if (!dg) return out;
    for (const t of Object.values(dg.teams)) {
      if (t.c !== "nfl" && t.c !== "fbs" && t.c !== "fcs") continue;
      for (const side of ["off", "def"] as Side[]) {
        const u = t[side];
        for (const d of SPLITS) {
          if (d.offenseOnly && side === "def") continue;
          const { num, den } = d.get(u);
          if (!den || sampleOf(d, u) < MIN_SAMPLE) continue;
          const k = `${t.c}|${side}|${d.key}`;
          (out.get(k) ?? out.set(k, []).get(k)!).push(num / den);
        }
      }
    }
    for (const arr of out.values()) arr.sort((a, b) => a - b);
    return out;
  });
}

const pctF = (r: number) => `${Math.round(r * 100)}%`;
function fmtValue(d: SplitDef, rate: number | null, num: number, den: number): string {
  if (rate === null) return "unmeasured";
  if (d.key === "playsPerMin") return `${rate.toFixed(2)} per min`;
  if (d.key === "secsPerSnap") return `${rate.toFixed(0)}s (${den} snaps)`;
  if (d.key === "rzTd") return `${pctF(rate)} (${num} of ${den} trips)`;
  return `${pctF(rate)} (${num} of ${den})`;
}

function rows(t: RawTeam, side: Side): SplitRow[] {
  const u = t[side];
  const out: SplitRow[] = [];
  for (const d of SPLITS) {
    if (d.offenseOnly && side === "def") continue;
    const { num, den } = d.get(u);
    const n = sampleOf(d, u);
    const rate = den > 0 ? num / den : null;
    const small = n < MIN_SAMPLE;
    let r: { rank: number; of: number; pct: number } | undefined;
    if (rate !== null && !small && (t.c === "nfl" || t.c === "fbs" || t.c === "fcs")) {
      const sorted = tables().get(`${t.c}|${side}|${d.key}`);
      // style: rank 1 = highest rate (most pass-heavy). quality: rank 1 = best for this side. tempo: rank 1 = fastest.
      const wantHigh = d.kind === "style" ? true : d.kind === "tempo" ? Boolean(d.fastHigh) : side === "off" ? Boolean(d.offHigh) : !d.offHigh;
      if (sorted?.length) r = rankIn(sorted, rate, wantHigh);
    }
    out.push({ key: d.key, label: d.label, rate, n, value: fmtValue(d, rate, num, den), kind: d.kind, rank: r?.rank, of: r?.of, pct: r?.pct, small });
  }
  return out;
}

export interface TeamSituations {
  team: string;
  classification: string | null;
  games: number;
  plays: { offense: number; defense: number };
  offense: SplitRow[];
  defense: SplitRow[];
  thirdCarriers: SituationName[];
  thirdTargets: SituationName[];
  rzCarriers: SituationName[];
  rzTargets: SituationName[];
  asOf: string;
}

export function situationsFor(school: string): TeamSituations | undefined {
  const dg = situationalDigest();
  const t = dg?.teams[school];
  if (!dg || !t) return undefined;
  return memoSync(`sit:team:${school}:${stamp()}`, 3600, () => ({
    team: school,
    classification: t.c,
    games: t.games,
    plays: { offense: t.off.plays, defense: t.def.plays },
    offense: rows(t, "off"),
    defense: rows(t, "def"),
    thirdCarriers: t.thirdCarriers,
    thirdTargets: t.thirdTargets,
    rzCarriers: t.rzCarriers,
    rzTargets: t.rzTargets,
    asOf: dg.meta.ingestedAt,
  }));
}

/** Top ball carriers and targets on third down, for player cue wiring. Names are as the play text spells them when unmatched. */
export function thirdDownTargets(school: string): { carriers: SituationName[]; targets: SituationName[] } | undefined {
  const t = situationalDigest()?.teams[school];
  return t ? { carriers: t.thirdCarriers, targets: t.thirdTargets } : undefined;
}

/** Top ball carriers and targets inside the 20, for player cue wiring. */
export function redZoneTargets(school: string): { carriers: SituationName[]; targets: SituationName[] } | undefined {
  const t = situationalDigest()?.teams[school];
  return t ? { carriers: t.rzCarriers, targets: t.rzTargets } : undefined;
}

/* -------------------------------------------------------------- cues */

export interface SituationCue {
  text: string;
  /** How far from the middle the two ranks sit, 0..100. Used to pick the strongest cues. */
  weight: number;
  offTeam: string;
  defTeam: string;
  key: string;
}

const rankText = (r: SplitRow) => (r.rank && r.of ? `No. ${r.rank} of ${r.of}` : "unranked");
const row = (s: TeamSituations | undefined, side: Side, key: string) => s?.[side === "off" ? "offense" : "defense"].find((r) => r.key === key);
const ok = (r?: SplitRow): r is SplitRow => Boolean(r && r.rate !== null && !r.small);

/** Pair one offense's habits with the opposing defense's results in the same situation. */
export function situationCues(offSchool: string, defSchool: string): SituationCue[] {
  const o = situationsFor(offSchool);
  const d = situationsFor(defSchool);
  if (!o || !d) return [];
  const out: SituationCue[] = [];
  const push = (key: string, text: string, ...rs: SplitRow[]) => {
    const weight = rs.reduce((s, r) => s + Math.abs((r.pct ?? 50) - 50), 0) / rs.length;
    out.push({ text, weight, offTeam: offSchool, defTeam: defSchool, key });
  };

  // Third down: medium and long, each only when both samples clear the bar.
  for (const [pk, ck, words] of [
    ["thirdMedPass", "thirdMedConv", "third-and-medium (4 to 6)"],
    ["thirdLongPass", "thirdLongConv", "third-and-long (7+)"],
    ["thirdShortPass", "thirdShortConv", "third-and-short (1 to 3)"],
  ] as const) {
    const p = row(o, "off", pk);
    const c = row(d, "def", ck);
    const oc = row(o, "off", ck);
    if (ok(p) && ok(c) && ok(oc)) {
      push(ck, `The ${offSchool} throw on ${p.value} of ${words} and convert ${oc.value.replace(/ \(.*/, "")} (${rankText(oc)}). The ${defSchool} allow a ${c.value.replace(/ \(.*/, "")} conversion rate there (${rankText(c)}, ${c.n} plays).`, oc, c);
    }
  }

  // Passing downs: offense success vs defense havoc.
  const ps = row(o, "off", "pdSucc");
  const dh = row(d, "def", "pdHavoc");
  const ds = row(d, "def", "pdSucc");
  if (ok(ps) && ok(dh) && ok(ds)) {
    push("pd", `On passing downs the ${offSchool} succeed ${ps.value} (${rankText(ps)}). The ${defSchool} create havoc on ${dh.value.replace(/ \(.*/, "")} of those snaps (${rankText(dh)}) and allow ${ds.value.replace(/ \(.*/, "")} success (${rankText(ds)}).`, ps, dh);
  }

  // Red zone: offense run/pass habit and TD rate vs defense TD rate allowed.
  const rp = row(o, "off", "rzPass");
  const rt = row(o, "off", "rzTd");
  const dt = row(d, "def", "rzTd");
  if (ok(rp) && ok(rt) && ok(dt)) {
    const habit = (rp.rate ?? 0.5) >= 0.55 ? "throw" : (rp.rate ?? 0.5) <= 0.4 ? "run" : "stay balanced";
    push("rz", `Inside the 20 the ${offSchool} ${habit} (${rp.value} pass) and score a touchdown on ${rt.value.replace(/ \(.*/, "")} of trips (${rankText(rt)}, ${rt.n} trips). The ${defSchool} allow a touchdown on ${dt.value.replace(/ \(.*/, "")} of trips (${rankText(dt)}, ${dt.n} trips).`, rt, dt);
  }

  // Explosives: which kind the offense makes and the defense gives up.
  const xr = row(o, "off", "xRush");
  const xp = row(o, "off", "xPass");
  const dxr = row(d, "def", "xRush");
  const dxp = row(d, "def", "xPass");
  if (ok(xr) && ok(dxr) && ok(xp) && ok(dxp)) {
    const rushGap = Math.abs((xr.pct ?? 50) - 50) + Math.abs((dxr.pct ?? 50) - 50);
    const passGap = Math.abs((xp.pct ?? 50) - 50) + Math.abs((dxp.pct ?? 50) - 50);
    if (rushGap >= passGap) push("xRush", `The ${offSchool} rip a 12-plus yard run on ${xr.value} of carries (${rankText(xr)}). The ${defSchool} allow one on ${dxr.value.replace(/ \(.*/, "")} (${rankText(dxr)}).`, xr, dxr);
    else push("xPass", `The ${offSchool} complete a 20-plus yard pass on ${xp.value} of dropbacks (${rankText(xp)}). The ${defSchool} allow one on ${dxp.value.replace(/ \(.*/, "")} (${rankText(dxp)}).`, xp, dxp);
  }

  // Score state: how the offense changes when behind, and the defense's record against trailing offenses.
  const tp = row(o, "off", "trailPass");
  const cp = row(o, "off", "closePass");
  const dts = row(d, "def", "pdSucc");
  if (ok(tp) && ok(cp) && ok(dts) && Math.abs((tp.rate ?? 0) - (cp.rate ?? 0)) >= 0.12) {
    push("trail", `The ${offSchool} throw on ${tp.value} when trailing by 9 or more, against ${cp.value.replace(/ \(.*/, "")} in one-score games. If they fall behind, the ${defSchool} passing-downs defense (${rankText(dts)}) is the unit that matters.`, tp, dts);
  }

  // Tempo: only when the offense is at either end.
  const nh = row(o, "off", "noHuddle");
  const ppm = row(o, "off", "playsPerMin");
  if (ok(nh) && ok(ppm) && ((nh.pct ?? 50) >= 80 || (nh.pct ?? 50) <= 20)) {
    push("tempo", `The ${offSchool} go no-huddle on ${nh.value} of tagged snaps (${rankText(nh)} fastest) and run ${ppm.value.replace(/ \(.*/, "")} of possession (${rankText(ppm)}).`, nh, ppm);
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** The 2 or 3 strongest cues for a game, mixing both directions, no duplicate situation. */
export function gameCues(away: string, home: string, max = 3): SituationCue[] {
  const all = [...situationCues(away, home), ...situationCues(home, away)].sort((a, b) => b.weight - a.weight);
  const out: SituationCue[] = [];
  const seen = new Set<string>();
  for (const c of all) {
    const k = `${c.key}|${c.offTeam}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/* ----------------------------------------------------------- grading */

export interface GameSituation {
  third: { n: number; conv: number; rate: number | null };
  pd: { n: number; succ: number; rate: number | null };
  plays: number;
}

/** One offense's third-down and passing-downs line in one game, from the digest. */
export function gameSituation(gameId: string, offSchool: string): GameSituation | undefined {
  const g = situationalDigest()?.games[gameId]?.teams[offSchool];
  if (!g) return undefined;
  return {
    third: { ...g.third, rate: g.third.n ? g.third.conv / g.third.n : null },
    pd: { ...g.pd, rate: g.pd.n ? g.pd.succ / g.pd.n : null },
    plays: g.plays,
  };
}

/** Season rates for the passing-downs axis: the offense's own, or what the defense allows. */
function seasonPd(school: string, side: Side): { pd: number | null; third: number | null; pdN: number; thirdN: number } | undefined {
  const t = situationalDigest()?.teams[school];
  if (!t) return undefined;
  const u = t[side];
  const thirdN = u.third.short.n + u.third.medium.n + u.third.long.n;
  const thirdConv = u.third.short.conv + u.third.medium.conv + u.third.long.conv;
  return { pd: u.pd.n ? u.pd.succ / u.pd.n : null, third: thirdN ? thirdConv / thirdN : null, pdN: u.pd.n, thirdN };
}

export type PassingDownsVerdict = "played out" | "mixed" | "did not play out" | "unmeasured";

/**
 * Grade the passing-downs edge after the final. The favored side's number in this game is
 * compared with its own season rate. An offense edge plays out when the offense beat its season
 * passing-downs success by 8 points (or beat both passing-downs and third-down rates by 4). A
 * defense edge plays out when the offense was held 8 points under what that defense allows all season.
 * Fewer than 8 passing downs in the game stays unmeasured.
 */
export function gradePassingDowns(gameId: string, offSchool: string, defSchool: string, edge: "offense" | "defense" | "even"): { verdict: PassingDownsVerdict; actual: string } | undefined {
  const g = gameSituation(gameId, offSchool);
  if (!g) return undefined;
  const line = `The ${offSchool} on passing downs: ${g.pd.succ} of ${g.pd.n} successful${g.pd.rate !== null ? ` (${pctF(g.pd.rate)})` : ""}; third down ${g.third.conv} of ${g.third.n}${g.third.rate !== null ? ` (${pctF(g.third.rate)})` : ""}.`;
  if (edge === "even") return { verdict: "unmeasured", actual: line };
  if (g.pd.n < 8 || g.pd.rate === null) return { verdict: "unmeasured", actual: `${line} Too few passing downs to grade.` };
  const base = seasonPd(edge === "offense" ? offSchool : defSchool, edge === "offense" ? "off" : "def");
  if (!base || base.pd === null) return { verdict: "unmeasured", actual: `${line} No season baseline.` };
  const pdDelta = g.pd.rate - base.pd; // positive = offense did better than the baseline
  const thirdDelta = g.third.rate !== null && base.third !== null ? g.third.rate - base.third : 0;
  const sign = edge === "offense" ? 1 : -1; // defense edge plays out when the offense did worse
  const pdFor = pdDelta * sign;
  const thirdFor = thirdDelta * sign;
  const verdict: PassingDownsVerdict = pdFor >= 0.08 || (pdFor >= 0.04 && thirdFor >= 0.04) ? "played out" : pdFor <= -0.08 ? "did not play out" : "mixed";
  const who = edge === "offense" ? `the ${offSchool} season rate` : `what the ${defSchool} allow all season`;
  return { verdict, actual: `${line} Season baseline ${pctF(base.pd)} (${who}, ${base.pdN} plays).` };
}
