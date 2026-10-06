/**
 * Watch radar: who is worth your eyes in an NFL game, built only from verified
 * inputs: nflverse weekly stats (this season and last), snap counts, the draft
 * file, the official injury report, and the depth chart.
 *
 * Three lenses, all from real data:
 *   Rookie    first-year players ranked by production against their draft slot
 *             ("drafted 118th, producing like a top-30 pick")
 *   Breakout  year 2 and 3 players whose target share or production per game
 *             jumped against last season
 *   Matchup   the player a unit edge puts on the spot in one game (assigned per
 *             game in slate.ts through matchupPlayers())
 *   Watch     a starter worth knowing, by production and snap share
 *
 * It is not a grade and never claims to be one. It ranks evidence. Every number
 * on a card can be traced to a source row.
 */
import { genPlayers, genMeta, type GenPlayer, type StatLine } from "./generated";
import { memoSync } from "./memo";
import { adjustedIndex, type QocLabel } from "./adjusted";
import { movementFor, movementStamp } from "./movement";

export type PosGroup = "QB" | "RB" | "WR" | "TE" | "OL" | "DL" | "EDGE" | "LB" | "CB" | "S" | "ST";
export type RadarTier = "Rookie" | "Breakout" | "Matchup" | "Watch";

export interface Evidence {
  label: string; // "612 rec yds"
  note?: string; // "top 4% of NFL WR"
  kind: "production" | "pedigree" | "size" | "usage" | "unit" | "breakout" | "injury" | "matchup";
}

export interface Breakout {
  metric: string; // "target share", "production per game"
  last: number;
  now: number;
  delta: number; // now - last, same unit
  label: string; // "Target share 14% to 24%"
}

export interface RadarPlayer {
  id: string;
  name: string;
  team: string; // nickname
  classification: "nfl";
  conference: string | null;
  pos: string;
  group: PosGroup;
  /** Years in the league, 1 = rookie. */
  classYear: number | null;
  /** "Rookie", "Year 2", "Year 3", "10th season". */
  cls: string;
  /** Draft year (rookie year for undrafted players). */
  draftClass: number;
  eligibilityNote: string;
  height: number | null;
  weight: number | null;
  jersey: number | null;
  score: number; // 0..100 Watch Score for the player
  production: number; // 0..100 percentile within NFL + group
  /** Draft slot score 0..100 (pick 1 = 100, pick 32 = 75, pick 100 = 55, undrafted = 8). Kept under the college name so shared UI compiles. */
  pedigree: number;
  usage: number; // 0..100 snap share
  size: boolean | null;
  tier: RadarTier;
  evidence: Evidence[];
  stat: string;
  statLine: { label: string; value: string }[];
  watch: string;
  /** Unused in the NFL (recruiting stars); null. */
  stars: number | null;
  /** Overall draft pick. */
  recruitRank: number | null;
  hometown: string | null; // college
  gamesPlayed: number | null;
  rawProduction: number;
  adjustedProduction: number | null;
  qoc: number | null;
  qocLabel: QocLabel;
  delta: number | null;
  /* NFL additions */
  slot: number | null;
  slotYear: number | null;
  /** Production percentile minus the slot score. Positive = producing above his draft slot. Rookies and second-year players only. */
  vsSlot: number | null;
  /** The pick his production percentile would correspond to ("producing like pick No. 21"). */
  eqPick: number | null;
  breakout: Breakout | null;
  injury: { status: string | null; practice: string | null; injury: string | null; week: number } | null;
  depth: { pos: string; rank: number } | null;
  snapShare: number | null;
  lastSeason: string | null;
  college: string | null;
  draftedBy: string | null;
  /** nflverse headshot (nfl.com CDN), used when the ESPN id is missing. */
  headshot: string | null;
  /** Set by matchupPlayers(): why this player is on the spot in one game. */
  lensNote?: string;
}

/* ----------------------------------------------------------- helpers */

const GROUP: Record<string, PosGroup> = {
  QB: "QB", RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE",
  OL: "OL", OT: "OL", OG: "OL", C: "OL", G: "OL", T: "OL", LT: "OL", RT: "OL", LG: "OL", RG: "OL",
  DL: "DL", DT: "DL", NT: "DL", DE: "EDGE", EDGE: "EDGE", OLB: "EDGE",
  LB: "LB", ILB: "LB", MLB: "LB",
  DB: "CB", CB: "CB", NB: "CB", S: "S", FS: "S", SS: "S", SAF: "S",
  PK: "ST", K: "ST", P: "ST", LS: "ST",
};

export const GROUP_LABEL: Record<PosGroup, string> = {
  QB: "Quarterback", RB: "Running back", WR: "Wide receiver", TE: "Tight end", OL: "Offensive line",
  DL: "Interior D-line", EDGE: "Edge", LB: "Linebacker", CB: "Cornerback", S: "Safety", ST: "Specialist",
};

export function groupOf(p: GenPlayer): PosGroup | null {
  const raw = p.p ?? p.pg ?? "";
  const g = GROUP[raw] ?? GROUP[p.pg ?? ""] ?? null;
  if (!g) return null;
  // OLB is an edge rusher in a 3-4 and an off-ball linebacker in a 4-3: let the stat line decide.
  if (raw === "OLB") {
    const s = p.s ?? p.ps ?? {};
    return (s.sk ?? 0) + (s.hur ?? 0) >= 2 || (s.tfl ?? 0) >= 2 ? "EDGE" : "LB";
  }
  // "DL" generic: an end-sized player is an edge.
  if (raw === "DL" && p.w && p.w < 275) return "EDGE";
  return g;
}

const OFFENSE = new Set<PosGroup>(["QB", "RB", "WR", "TE", "OL"]);

/** NFL size norms (height inches, weight lbs). Rough, public, position-standard. */
const SIZE: Partial<Record<PosGroup, { h?: number; w?: number }>> = {
  QB: { h: 73 }, RB: { w: 205 }, WR: { h: 72 }, TE: { h: 76, w: 240 }, OL: { h: 75, w: 300 },
  DL: { w: 290 }, EDGE: { h: 75, w: 245 }, LB: { w: 228 }, CB: { h: 71 }, S: { w: 195 },
};

/** Draft slot to a 0..100 score: pick 1 = 100, pick 32 = 75, pick 100 = 55, pick 224 = 33, undrafted = 8. */
export function slotScore(pick: number | null): number {
  if (pick == null) return 8;
  return Math.max(5, Math.round(100 - 25 * Math.sqrt((pick - 1) / 31)));
}
/** Inverse of slotScore: the pick a production percentile corresponds to. */
export function pickForPercentile(pct: number): number {
  return Math.max(1, Math.round(1 + 31 * Math.pow((100 - pct) / 25, 2)));
}

const perGame = (s: StatLine, k: string) => (s[k] ?? 0) / Math.max(1, s.gp ?? 1);

/** Raw production number per group. Higher is better. Per-game where it matters. Zero under the volume gate. */
export function production(s: StatLine | null, group: PosGroup): number {
  if (!s) return 0;
  switch (group) {
    case "QB": {
      if ((s.pa ?? 0) < 30) return 0;
      return perGame(s, "pepa") * 1.2 + (s.ypa ?? 0) * 6 + (s.cpoe ?? 0) * 3 + (s.ptd ?? 0) * 4 - (s.pint ?? 0) * 5 + (s.cmp ?? 0) * 0.4 + perGame(s, "ry") * 0.25 + (s.rtd ?? 0) * 3;
    }
    case "RB": {
      if ((s.ra ?? 0) < 10) return 0;
      return perGame(s, "ry") * 1.0 + (s.rtd ?? 0) * 8 + (s.repa ?? 0) * 1.5 + perGame(s, "rcy") * 0.8 + (s.rec ?? 0) * 1 + ((s.ra ?? 0) >= 25 ? (s.ypc ?? 0) * 6 : 0);
    }
    case "WR":
    case "TE": {
      if ((s.tgt ?? 0) < 5) return 0;
      return perGame(s, "rcy") * 1.2 + perGame(s, "rec") * 5 + (s.rctd ?? 0) * 8 + (s.rcepa ?? 0) * 1.2 + (s.tshare ?? 0) * 100 * (group === "TE" ? 1.2 : 0.8);
    }
    case "EDGE":
    case "DL":
      return (s.sk ?? 0) * 20 + (s.hur ?? 0) * 7 + (s.tfl ?? 0) * 8 + perGame(s, "tk") * 2 + (s.ff ?? 0) * 6 + (s.pd ?? 0) * 3;
    case "LB":
      return perGame(s, "tk") * 6 + (s.tfl ?? 0) * 7 + (s.sk ?? 0) * 10 + (s.pd ?? 0) * 5 + (s.int ?? 0) * 12 + (s.hur ?? 0) * 3 + (s.ff ?? 0) * 5;
    case "CB":
    case "S":
      return (s.int ?? 0) * 20 + (s.pd ?? 0) * 9 + perGame(s, "tk") * 3 + (s.tfl ?? 0) * 4 + (s.dtd ?? 0) * 12 + (s.ff ?? 0) * 5;
    case "OL":
      return 0;
    case "ST":
      if ((s.fga ?? 0) >= 4) return (s.fgm ?? 0) * 4 + (s.fgp ?? 0) * 0.4 + (s.fglg ?? 0) * 0.4;
      if ((s.pno ?? 0) >= 8) return (s.ypp ?? 0) * 2 + (s.pin20 ?? 0) * 2;
      return 0;
  }
}

export function statLine(s: StatLine | null, group: PosGroup): { line: string; table: { label: string; value: string }[] } {
  const t: { label: string; value: string }[] = [];
  const x = s ?? {};
  const add = (label: string, v: number | undefined, fmt: (n: number) => string = (n) => String(n)) => {
    if (v !== undefined && v !== null) t.push({ label, value: fmt(v) });
  };
  const f1 = (n: number) => n.toFixed(1);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  switch (group) {
    case "QB":
      if (x.pc !== undefined && x.pa !== undefined) t.push({ label: "Comp / Att", value: `${x.pc} / ${x.pa}` });
      add("Pass yds", x.py); add("TD", x.ptd); add("INT", x.pint); add("Y/A", x.ypa, f1); add("CPOE", x.cpoe, (n) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`); add("Pass EPA", x.pepa, f1); add("Sacked", x.sks); add("Rush yds", x.ry);
      return { line: s ? `${x.py ?? 0} pass yds, ${x.ptd ?? 0} TD, ${x.pint ?? 0} INT${x.ypa ? `, ${x.ypa.toFixed(1)} Y/A` : ""}${x.cpoe !== undefined ? `, CPOE ${x.cpoe > 0 ? "+" : ""}${x.cpoe.toFixed(1)}` : ""}` : "No stat line yet", table: t };
    case "RB":
      add("Carries", x.ra); add("Rush yds", x.ry); add("Y/C", x.ypc, f1); add("Rush TD", x.rtd); add("Rush EPA", x.repa, f1); add("Targets", x.tgt); add("Rec", x.rec); add("Rec yds", x.rcy);
      return { line: s ? `${x.ry ?? 0} rush yds on ${x.ra ?? 0} carries, ${x.rtd ?? 0} TD${x.rcy ? `, ${x.rcy} rec yds` : ""}` : "No stat line yet", table: t };
    case "WR":
    case "TE":
      add("Targets", x.tgt); add("Rec", x.rec); add("Rec yds", x.rcy); add("Y/R", x.ypr, f1); add("TD", x.rctd); add("Target share", x.tshare, pct); add("Air yards share", x.ayshare, pct); add("Rec EPA", x.rcepa, f1);
      return { line: s ? `${x.rec ?? 0} rec, ${x.rcy ?? 0} yds, ${x.rctd ?? 0} TD${x.tshare ? `, ${Math.round(x.tshare * 100)}% target share` : ""}` : "No stat line yet", table: t };
    case "EDGE":
    case "DL":
    case "LB":
      add("Tackles", x.tk); add("Solo", x.solo); add("TFL", x.tfl); add("Sacks", x.sk); add("QB hits", x.hur); add("PD", x.pd); add("INT", x.int); add("FF", x.ff);
      return { line: s ? `${x.tk ?? 0} tkl, ${x.tfl ?? 0} TFL, ${x.sk ?? 0} sacks${x.hur ? `, ${x.hur} QB hits` : ""}` : "No stat line yet", table: t };
    case "CB":
    case "S":
      add("Tackles", x.tk); add("INT", x.int); add("PD", x.pd); add("TFL", x.tfl); add("INT yds", x.inty); add("Def TD", x.dtd); add("FF", x.ff);
      return { line: s ? `${x.int ?? 0} INT, ${x.pd ?? 0} PD, ${x.tk ?? 0} tkl` : "No stat line yet", table: t };
    case "OL":
      return { line: "No box-score stats for linemen. See unit evidence.", table: t };
    case "ST":
      if ((x.fga ?? 0) > 0) { t.push({ label: "FG", value: `${x.fgm ?? 0} / ${x.fga}` }); add("Long", x.fglg); add("Pct", x.fgp, (n) => `${n}%`); return { line: `${x.fgm ?? 0}/${x.fga ?? 0} FG, long ${x.fglg ?? 0}`, table: t }; }
      add("Punts", x.pno); add("Avg", x.ypp, f1); add("Inside 20", x.pin20);
      return { line: `${x.pno ?? 0} punts, ${x.ypp?.toFixed(1) ?? "0"} avg`, table: t };
  }
}

/** Position-specific viewing checklist. Domain knowledge, not a claim about the player. */
const WATCH: Record<PosGroup, string> = {
  QB: "Ball placement outside the numbers, how he resets his feet when the first read is covered, and whether he throws on time against pressure.",
  RB: "Contact balance through the first tackler, vision on zone cuts, and whether he stays on the field on third down.",
  WR: "Release against press, separation at the top of the route, and hands away from his frame in traffic.",
  TE: "Whether he stays in to block on early downs, how he wins in the seam, and if the offense trusts him on third down.",
  OL: "Pass-set depth against speed off the edge, hand placement on first contact, and whether he climbs cleanly to linebackers.",
  DL: "First-step quickness, anchor against double teams, and whether his pass-rush plan has a counter when the first move fails.",
  EDGE: "Get-off at the snap, bend around the arc, and whether he sets the edge against the run instead of only chasing sacks.",
  LB: "Diagnosis speed on run fits, sideline-to-sideline range, and how he handles tight ends and backs in coverage.",
  CB: "Press technique at the line, hip fluidity in transition, and ball production when the throw comes his way.",
  S: "Alignment versatility (deep, slot, box), tackling angles in space, and range from the middle of the field.",
  ST: "Leg strength on long attempts, operation time, and consistency in wind.",
};

function pct(sorted: number[], v: number): number {
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

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;

/** Rate stats. Everything else in a StatLine is a count (gp aside). */
const RATES = new Set(["ypa", "cmp", "cpoe", "ypc", "ypr", "tshare", "ayshare", "wopr", "racr", "fgp", "ypp", "fglg", "ptlg"]);

/**
 * A season line restated over `gp` games at the same per-game pace. production() mixes per-game rates with
 * season totals, and the totals grow with games played, so two seasons only compare at the same game count.
 */
function atGames(s: StatLine, gp: number): StatLine {
  const k = gp / Math.max(1, s.gp ?? 1);
  const out: StatLine = { gp };
  for (const [key, v] of Object.entries(s)) if (key !== "gp") out[key] = typeof v === "number" && !RATES.has(key) ? v * k : v;
  return out;
}

/** Breakout test for year 2 and 3 players: target share up 7 points, or production per game up 40% on a real base. */
function detectBreakout(p: GenPlayer, group: PosGroup): Breakout | null {
  if (!p.s || !p.ps) return null;
  const gpNow = p.s.gp ?? 0;
  const gpLast = p.ps.gp ?? 0;
  if (gpNow < 2 || gpLast < 4) return null;
  if ((group === "WR" || group === "TE" || group === "RB") && p.s.tshare !== undefined && p.ps.tshare !== undefined) {
    const d = p.s.tshare - p.ps.tshare;
    if (d >= 0.07 && p.s.tshare >= 0.15) return { metric: "target share", last: p.ps.tshare, now: p.s.tshare, delta: d, label: `Target share ${Math.round(p.ps.tshare * 100)}% to ${Math.round(p.s.tshare * 100)}%` };
  }
  // Last season restated at this season's game count, then both put on a per-game scale the same way.
  const now = production(p.s, group) / gpNow;
  const last = production(atGames(p.ps, gpNow), group) / gpNow;
  if (now > 0 && last > 0 && now >= last * 1.4 && now - last > 2) {
    return { metric: "production per game", last, now, delta: now - last, label: `Production per game up ${Math.round(((now - last) / last) * 100)}% on last season` };
  }
  return null;
}

/* ----------------------------------------------------------- index */

export interface RadarIndex {
  byId: Map<string, RadarPlayer>;
  byTeam: Map<string, RadarPlayer[]>;
  all: RadarPlayer[]; // sorted by score desc
  season: number;
  /** Every tracked player by team, radar or not (for matchup lookups). */
  rosterByTeam: Map<string, RadarPlayer[]>;
}

function buildIndex(): RadarIndex {
  const players = genPlayers();
  const season = genMeta()?.season ?? new Date().getFullYear();
  const adjIdx = adjustedIndex();

  const tables = new Map<string, number[]>();
  const raw = new Map<string, number>();
  for (const p of players) {
    const group = groupOf(p);
    if (!group) continue;
    const v = production(p.s, group);
    raw.set(p.id, v);
    if (v > 0) (tables.get(group) ?? tables.set(group, []).get(group)!).push(v);
  }
  for (const arr of tables.values()) arr.sort((a, b) => a - b);
  // Snap share ranked inside the position group too: starting DBs and linebackers play nearly every snap while
  // backs and receivers rotate, so raw share handed defenders up to 13 points of score for their position alone.
  const shareTables = new Map<string, number[]>();
  for (const p of players) {
    const group = groupOf(p);
    const share = group && p.u ? (OFFENSE.has(group) ? p.u.o : p.u.d) : 0;
    if (group && share > 0) (shareTables.get(group) ?? shareTables.set(group, []).get(group)!).push(share);
  }
  for (const arr of shareTables.values()) arr.sort((a, b) => a - b);

  const all: RadarPlayer[] = [];
  const roster: RadarPlayer[] = [];
  for (const p of players) {
    const group = groupOf(p);
    if (!group || !p.p) continue;
    if (group === "ST") continue;
    const v = raw.get(p.id) ?? 0;
    const rawPct = v > 0 ? pct(tables.get(group) ?? [], v) : 0;
    const adj = adjIdx.byId.get(p.id);
    const prodPct = adj && v > 0 ? Math.round(0.5 * rawPct + 0.5 * adj.adjPct) : rawPct;

    const pick = p.r.pk;
    const slot = slotScore(pick);
    const share = p.u ? (OFFENSE.has(group) ? p.u.o : p.u.d) : null;
    const usage = share === null ? 0 : Math.min(100, Math.round(share * 100));
    const usagePct = share ? pct(shareTables.get(group) ?? [], share) : 0;
    const norm = SIZE[group];
    const size = norm && (p.h || p.w) ? (norm.h ? (p.h ?? 0) >= norm.h : true) && (norm.w ? (p.w ?? 0) >= norm.w : true) : null;
    const y = p.y ?? null;
    const cls = y === 1 ? "Rookie" : y === 2 ? "Year 2" : y === 3 ? "Year 3" : y ? `${ordinal(y)} season` : "";
    const draftClass = p.r.yr ?? p.r.entry ?? season;
    const breakout = y === 2 || y === 3 ? detectBreakout(p, group) : null;
    const rookie = y === 1 || p.r.yr === season;
    const vsSlot = (rookie || y === 2) && v > 0 ? prodPct - slot : null;
    const eqPick = vsSlot !== null ? pickForPercentile(prodPct) : null;

    // Watch Score for the player: production 50%, snap share 30% (both as percentiles inside the position group), context 20% (slot beaten, breakout, or starter default).
    const context = breakout ? 100 : vsSlot !== null ? Math.max(0, Math.min(100, 50 + vsSlot)) : p.dc?.rank === 1 ? 60 : 40;
    let score: number;
    if (group === "OL") score = Math.round((p.dc?.rank === 1 ? 45 : 25) + usage * 0.3 + (size ? 10 : 0));
    else score = Math.round(Math.min(100, 0.5 * prodPct + 0.3 * usagePct + 0.2 * context));

    const eligibilityNote = rookie
      ? pick ? `Rookie, pick No. ${pick}${p.r.rd ? ` (round ${p.r.rd})` : ""} in ${draftClass} by the ${p.r.club ?? "team"}${p.home ? `, out of ${p.home}` : ""}.` : `Rookie, undrafted${p.home ? `, out of ${p.home}` : ""}.`
      : pick ? `${cls}. Pick No. ${pick} in the ${draftClass} draft by the ${p.r.club ?? "team"}.` : `${cls}. Undrafted (${draftClass}).`;

    let tier: RadarTier | null = null;
    const starter = (p.dc?.rank ?? 9) === 1 || (share ?? 0) >= 0.5;
    if (rookie && (prodPct >= 25 || usage >= 40 || (pick !== null && pick <= 64))) tier = "Rookie";
    else if (breakout && prodPct >= 45) tier = "Breakout";
    else if (group !== "OL" && starter && score >= 50) tier = "Watch";
    else if (group === "OL" && p.dc?.rank === 1 && usage >= 70) tier = "Watch";

    const evidence: Evidence[] = [];
    const sl = statLine(p.s, group);
    if (v > 0) evidence.push({ kind: "production", label: sl.line, note: prodPct >= 50 ? `top ${Math.max(1, 100 - prodPct)}% of NFL ${group}` : `${ordinal(prodPct)} percentile of NFL ${group}` });
    if (vsSlot !== null && eqPick !== null) evidence.push({ kind: "pedigree", label: pick ? `Drafted No. ${pick}, producing like pick No. ${eqPick}` : `Undrafted, producing like pick No. ${eqPick}`, note: vsSlot >= 10 ? "above his slot" : vsSlot <= -10 ? "below his slot" : "about on slot" });
    else if (pick) evidence.push({ kind: "pedigree", label: `Pick No. ${pick}, ${draftClass}${p.r.club ? ` (${p.r.club})` : ""}` });
    if (breakout) evidence.push({ kind: "breakout", label: breakout.label, note: `last season ${p.ps?.gp ?? 0} games` });
    if (p.h && p.w) evidence.push({ kind: "size", label: `${Math.floor(p.h / 12)}-${p.h % 12}, ${p.w} lb`, note: size ? "NFL size for the position" : size === false ? "under NFL size norms" : undefined });
    if (share !== null && share >= 0.1) evidence.push({ kind: "usage", label: `${Math.round(share * 100)}% of ${OFFENSE.has(group) ? "offensive" : "defensive"} snaps`, note: p.s?.tshare ? `${Math.round(p.s.tshare * 100)}% target share` : p.dc ? `${p.dc.pos} No. ${p.dc.rank} on the depth chart` : undefined });
    if (p.inj?.st) evidence.push({ kind: "injury", label: `${p.inj.st}${p.inj.inj ? ` (${p.inj.inj.toLowerCase()})` : ""}`, note: p.inj.pr ? `week ${p.inj.wk} report: ${p.inj.pr.toLowerCase()}` : `week ${p.inj.wk} report` });

    const lastLine = p.ps ? statLine(p.ps, group).line : null;
    const row: RadarPlayer = {
      id: p.id,
      name: p.n,
      team: p.t,
      classification: "nfl",
      conference: p.cf,
      pos: p.p,
      group,
      classYear: y,
      cls,
      draftClass,
      eligibilityNote,
      height: p.h,
      weight: p.w,
      jersey: p.j,
      score,
      production: prodPct,
      pedigree: slot,
      usage,
      size,
      tier: tier ?? "Watch",
      evidence,
      stat: sl.line,
      statLine: sl.table,
      watch: WATCH[group],
      stars: null,
      recruitRank: pick,
      hometown: p.home,
      gamesPlayed: p.s?.gp ?? null,
      rawProduction: rawPct,
      adjustedProduction: adj && v > 0 ? adj.adjPct : null,
      qoc: adj?.qoc ?? null,
      qocLabel: adj?.qocLabel ?? "unmeasured",
      delta: movementFor(p.id)?.scoreDelta ?? null,
      slot: pick,
      slotYear: pick ? draftClass : null,
      vsSlot,
      eqPick,
      breakout,
      injury: p.inj ? { status: p.inj.st, practice: p.inj.pr, injury: p.inj.inj, week: p.inj.wk } : null,
      depth: p.dc ? { pos: p.dc.pos, rank: p.dc.rank } : null,
      snapShare: share,
      lastSeason: lastLine && lastLine !== "No stat line yet" ? lastLine : null,
      college: p.home,
      draftedBy: p.r.club,
      headshot: p.r.hs,
    };
    roster.push(row);
    if (tier) all.push(row);
  }

  all.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const byId = new Map(roster.map((p) => [p.id, p]));
  const byTeam = new Map<string, RadarPlayer[]>();
  for (const p of all) (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(p);
  const rosterByTeam = new Map<string, RadarPlayer[]>();
  for (const p of roster) (rosterByTeam.get(p.team) ?? rosterByTeam.set(p.team, []).get(p.team)!).push(p);
  return { byId, byTeam, all, season, rosterByTeam };
}

export const radarIndex = (): RadarIndex => memoSync(`radar:${genMeta()?.ingestedAt ?? "none"}:${adjustedIndex().stamp}:${movementStamp()}`, 3600, buildIndex);

export const radarForTeam = (team: string): RadarPlayer[] => radarIndex().byTeam.get(team) ?? [];
export const radarPlayer = (id: string): RadarPlayer | undefined => radarIndex().byId.get(id);
export const rosterForTeam = (team: string): RadarPlayer[] => radarIndex().rosterByTeam.get(team) ?? [];

export interface BoardFilter {
  tier?: RadarTier;
  group?: PosGroup;
  team?: string;
  q?: string;
  limit?: number;
}

export function radarBoard(f: BoardFilter = {}): RadarPlayer[] {
  const q = f.q?.trim().toLowerCase();
  let list = radarIndex().all;
  if (f.tier) list = list.filter((p) => p.tier === f.tier);
  if (f.group) list = list.filter((p) => p.group === f.group);
  if (f.team) list = list.filter((p) => p.team === f.team);
  if (q) list = list.filter((p) => `${p.name} ${p.team} ${p.pos} ${p.college ?? ""}`.toLowerCase().includes(q));
  return list.slice(0, f.limit ?? 100);
}

/** Players a game report should surface for one team: top rookies, breakouts, then watch names, capped. `sits` drops players who will not play. */
export function radarForGame(team: string, cap = 6, sits: (id: string) => boolean = () => false, groups?: Set<PosGroup>): RadarPlayer[] {
  const list = radarForTeam(team).filter((p) => !sits(p.id) && (!groups || groups.has(p.group)));
  const rookies = list.filter((p) => p.tier === "Rookie" && p.production > 0).slice(0, 2);
  const breakouts = list.filter((p) => p.tier === "Breakout").slice(0, 2);
  const watch = list.filter((p) => p.tier === "Watch").slice(0, 3);
  const seen = new Set<string>();
  return [...rookies, ...breakouts, ...watch].filter((p) => (seen.has(p.id) ? false : seen.add(p.id))).slice(0, cap);
}

/* ------------------------------------------------------------ lenses */

export type EdgeAxis = "rush" | "pass" | "line" | "pd";

/**
 * The player a unit edge puts on the spot. Offense edge: the man who carries that
 * unit (RB1 by carries, WR1 by target share, the starting QB). Defense edge: the
 * defender who produces there (top DB by passes defended plus picks, top front
 * player by tackles for loss plus sacks). Returns a copy tagged Matchup with a
 * one-line note. Undefined when nobody on the roster has the volume.
 */
export function matchupPlayer(axis: EdgeAxis, side: "offense" | "defense", team: string, note: string, sits: (id: string) => boolean = () => false): RadarPlayer | undefined {
  const roster = rosterForTeam(team).filter((p) => !sits(p.id));
  const stat = (p: RadarPlayer, k: string) => Number(p.statLine.find((s) => s.label === k)?.value ?? 0);
  let pick: RadarPlayer | undefined;
  const byMax = (list: RadarPlayer[], f: (p: RadarPlayer) => number) => list.filter((p) => f(p) > 0).sort((a, b) => f(b) - f(a))[0];
  // Defensive picks count box-score plays, so weight them by snap share: one interception by a special-teamer playing 15%
  // of the defense's snaps should not outrank the starting corners.
  const playing = (f: (p: RadarPlayer) => number) => (p: RadarPlayer) => f(p) * (0.25 + p.usage / 100);
  if (side === "offense") {
    if (axis === "rush" || axis === "line") pick = byMax(roster.filter((p) => p.group === "RB"), (p) => stat(p, "Carries"));
    else if (axis === "pass") pick = byMax(roster.filter((p) => p.group === "WR" || p.group === "TE"), (p) => parseFloat(p.statLine.find((s) => s.label === "Target share")?.value ?? "0"));
    else pick = byMax(roster.filter((p) => p.group === "QB"), (p) => Number((p.statLine.find((s) => s.label === "Comp / Att")?.value ?? "0 / 0").split("/")[1]));
  } else {
    if (axis === "pass") pick = byMax(roster.filter((p) => p.group === "CB" || p.group === "S"), playing((p) => stat(p, "PD") * 2 + stat(p, "INT") * 4 + stat(p, "Tackles") * 0.1));
    else if (axis === "pd") pick = byMax(roster.filter((p) => p.group === "EDGE" || p.group === "DL"), playing((p) => stat(p, "Sacks") * 3 + stat(p, "QB hits")));
    else pick = byMax(roster.filter((p) => p.group === "EDGE" || p.group === "DL" || p.group === "LB"), playing((p) => stat(p, "TFL") * 2 + stat(p, "Sacks") + stat(p, "Tackles") * 0.1));
  }
  if (!pick) return undefined;
  return { ...pick, tier: "Matchup", lensNote: note, evidence: [{ kind: "matchup", label: note }, ...pick.evidence] };
}
