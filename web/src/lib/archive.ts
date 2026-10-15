/**
 * Accountability archive. When a game is still upcoming, the report's call is
 * locked to disk: the edges, the pressure point, the radar names, the market,
 * the Watch Score. When the game goes final, the box score grades the call.
 * Nothing is edited after the fact. One JSON file per game under data/archive.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BoxScore } from "./boxscore";
import type { Game, Matchup } from "./types";
import { scoutScore } from "./score";
import { closingLine, closingValue, type ClvRecord, type LockedCall } from "./odds";
import { gradePassingDowns } from "./situational";
import { sideTier, totalTier, LEAN_THRESHOLDS } from "./leans";
import type { RecordBase } from "./record-base";

const DIR = path.join(process.cwd(), "data", "archive");

export type Verdict = "played out" | "mixed" | "did not play out" | "unmeasured";

export interface EdgeCall {
  a: string;
  b: string;
  edge: "offense" | "defense" | "even";
  axis: string; // rush, pass, line, passing-downs
  offTeam: string; // nickname
  why: string;
}

export interface ProspectCall {
  id: string;
  name: string;
  team: string; // nickname
  pos: string;
  group: string;
  tier: string;
  score: number;
}

export interface Pregame {
  capturedAt: string;
  kickoff: string;
  away: string;
  home: string;
  scoutScore: number;
  whyWatch: string;
  pressurePoint: string;
  edges: EdgeCall[];
  prospects: ProspectCall[];
  spread?: { team: string; line: number }; // abbr of favorite, negative line
  total?: number;
  abbr: { home: string; away: string };
  projection?: { winner: string; winProb: number; margin: number; home: number; away: number; modelSide?: string; confidence: string; modelTotal?: number; totalLean?: "over" | "under" | "none" };
  /** Consensus of outside systems (FPI, Elo, EPA model, market) plus ours: median home margin and the side most lean to against the number. */
  consensus?: { median: number; favorite: string; side?: string; sideCount?: number; of: number };
  /** When the call last moved before kickoff (injury news, a new starter, a line move). Grading uses the latest pregame call. */
  updatedAt?: string;
  /** The very first lock, kept so the record can show how far the news moved the call. */
  first?: { capturedAt: string; spread?: { team: string; line: number }; total?: number; projection?: Pregame["projection"] };
  /** The posted calls the ledger grades: frozen the first time the gap reached 2+ points on the side or 2.5+ on the total. */
  posted?: Posted;
}

/** A frozen call: the first lock that reached a gap, with the line it was made against. Never rewritten. */
export interface PostedSide {
  at: string;
  team: string; // abbr
  gap: number;
  line: { team: string; line: number }; // archive convention: favorite abbr, negative line
}
export interface PostedTotal {
  at: string;
  lean: "over" | "under";
  gap: number;
  line: number;
}
export interface Posted {
  side?: PostedSide;
  total?: PostedTotal;
}

export interface EdgeResult extends EdgeCall {
  verdict: Verdict;
  actual: string; // "ND 212 rush yds on 38 carries (5.6 per)"
}

export interface ProspectResult extends ProspectCall {
  verdict: "showed up" | "quiet" | "unmeasured";
  line: string;
}

export interface Postgame {
  capturedAt: string;
  score: { home: number; away: number };
  excitement?: number | null;
  spreadResult?: "favorite covered" | "underdog covered" | "push";
  totalResult?: "over" | "under" | "push";
  edges: EdgeResult[];
  prospects: ProspectResult[];
  pressurePointVerdict: Verdict;
  projectionResult?: { winnerRight: boolean; marginError: number; modelSideCovered?: boolean; totalLeanRight?: boolean };
  /** Closing line from Odds API snapshots and closing-line value for the model side and total lean. */
  clv?: ClvRecord;
  consensusResult?: { winnerRight: boolean; marginError: number; sideCovered?: boolean };
}

export interface ArchiveEntry {
  gameId: string;
  season: number;
  week?: number;
  pregame: Pregame;
  postgame?: Postgame;
}

function file(season: number, id: string) {
  return path.join(DIR, String(season), `${id}.json`);
}

export function readEntry(season: number, id: string): ArchiveEntry | undefined {
  const f = file(season, id);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ArchiveEntry;
  } catch {
    return undefined;
  }
}

function writeEntry(e: ArchiveEntry) {
  const f = file(e.season, e.gameId);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(e, null, 1));
}

function axisOf(m: Matchup): string {
  const t = `${m.a} ${m.b}`.toLowerCase();
  // Current titles (run game, pass game, passing-down offense) and earlier ones, so older locks keep grading.
  if (t.includes("ground game")) return "line";
  if (t.includes("run game")) return "rush";
  if (t.includes("pass game") || t.includes("deep passing")) return "pass";
  if (t.includes("offensive line")) return "line";
  if (t.includes("passing-down") || t.includes("passing downs")) return "passing-downs";
  return "other";
}

const projLock = (p: NonNullable<Game["projection"]>): NonNullable<Pregame["projection"]> => ({ winner: p.winner, winProb: p.winProb, margin: p.margin, home: p.home, away: p.away, modelSide: p.modelSide, confidence: p.confidence, modelTotal: p.modelTotal, totalLean: p.totalLean });

type CallShape = Pick<Pregame, "spread" | "total" | "projection">;

/** The model's gap to the market for one locked call, in points: model margin against the posted margin, model total against the posted total. */
export function callGaps(c: CallShape, abbr: Pregame["abbr"]): { sideGap?: number; totalGap?: number } {
  const p = c.projection;
  if (!p) return {};
  let sideGap: number | undefined;
  if (c.spread && p.modelSide) {
    const modelHome = p.winner === abbr.home ? p.margin : -p.margin;
    const marketHome = c.spread.team === abbr.home ? -c.spread.line : c.spread.line;
    sideGap = Math.round(Math.abs(modelHome - marketHome) * 10) / 10;
  }
  let totalGap: number | undefined;
  if (c.total !== undefined && p.modelTotal !== undefined) totalGap = Math.round(Math.abs(p.modelTotal - c.total) * 10) / 10;
  return { sideGap, totalGap };
}

/** The calls one lock would post: the side at a 2+ point gap, the total at 2.5+ (leans.ts tiers). */
function postFrom(c: CallShape, abbr: Pregame["abbr"], at: string): Posted {
  const p = c.projection;
  if (!p) return {};
  const { sideGap, totalGap } = callGaps(c, abbr);
  const out: Posted = {};
  if (sideGap !== undefined && sideTier(sideGap) && c.spread && p.modelSide) out.side = { at, team: p.modelSide, gap: sideGap, line: { team: c.spread.team, line: c.spread.line } };
  if (totalGap !== undefined && totalTier(totalGap) && c.total !== undefined && p.totalLean && p.totalLean !== "none") out.total = { at, lean: p.totalLean, gap: totalGap, line: c.total };
  return out;
}

/** The model side's grade as the record counts it: only at a 2+ point gap (under that the model and the market agree). */
export function sideGrade(e: ArchiveEntry | undefined): boolean | undefined {
  const covered = e?.postgame?.projectionResult?.modelSideCovered;
  if (!e || covered === undefined) return undefined;
  return (callGaps(e.pregame, e.pregame.abbr).sideGap ?? 0) >= LEAN_THRESHOLDS.side.moderate ? covered : undefined;
}

/** Posted calls in the shape the closing-line code reads (odds.ts clvFrom). */
export function postedCall(posted: Posted, abbr: Pregame["abbr"]): LockedCall {
  return { abbr, spread: posted.side?.line, total: posted.total?.line, projection: { modelSide: posted.side?.team, totalLean: posted.total?.lean } };
}

/**
 * The posted calls for a lock. Stored at lock time since 2026-10-12. Older locks fall back to the first lock's call when it
 * already had a gap; a gap that first showed up in a later refresh can't be dated, so it is not counted.
 */
export function postedOf(pre: Pregame): Posted {
  if (pre.posted) return pre.posted;
  const first = pre.first ?? pre;
  return postFrom(first, pre.abbr, first.capturedAt);
}

/**
 * Lock the pregame call before kickoff. The call follows the news until the game starts: when the
 * projection or the posted number moves (an injury, a new starter, a line move), the lock is refreshed
 * with the line it was made against, and the first lock is kept under `first`. The first call with a gap
 * is frozen under `posted` and never moves. Nothing moves after kickoff.
 */
export function lockPregame(game: Game, season: number): ArchiveEntry | undefined {
  if (game.source !== "live" || game.status !== "upcoming") return undefined;
  // The status was read when the slate build started, so check the clock too: nothing is written once the game has kicked off.
  if (Date.now() >= Date.parse(game.kickoff)) return readEntry(season, game.id);
  const existing = readEntry(season, game.id);
  if (existing) {
    if (!existing.postgame && game.projection) {
      const now = new Date().toISOString();
      const next = projLock(game.projection);
      const cur = existing.pregame.projection;
      const spread = game.market.spread ? { team: game.market.spread.team, line: game.market.spread.line } : undefined;
      const total = game.market.total?.line;
      const moved =
        !cur ||
        cur.winner !== next.winner || cur.margin !== next.margin || cur.modelSide !== next.modelSide || cur.modelTotal !== next.modelTotal || cur.totalLean !== next.totalLean ||
        existing.pregame.spread?.team !== spread?.team || existing.pregame.spread?.line !== spread?.line || existing.pregame.total !== total;
      // Posted calls: what the lock already holds (or its first lock's gap), then this call fills any leg not yet posted.
      const posted = { ...postedOf(existing.pregame) };
      const fresh = postFrom({ spread, total, projection: next }, existing.pregame.abbr, now);
      posted.side ??= fresh.side;
      posted.total ??= fresh.total;
      const postedMoved = (posted.side || posted.total) && (posted.side !== existing.pregame.posted?.side || posted.total !== existing.pregame.posted?.total);
      if (postedMoved) existing.pregame.posted = posted;
      if (moved) {
        if (cur) existing.pregame.first ??= { capturedAt: existing.pregame.capturedAt, spread: existing.pregame.spread, total: existing.pregame.total, projection: cur };
        existing.pregame.projection = next;
        existing.pregame.spread = spread;
        existing.pregame.total = total;
        existing.pregame.consensus = consensusLock(game) ?? existing.pregame.consensus;
        existing.pregame.updatedAt = now;
      }
      if (moved || postedMoved) writeEntry(existing);
    }
    if (!existing.postgame && !existing.pregame.consensus && game.consensus?.median !== undefined) {
      existing.pregame.consensus = consensusLock(game);
      writeEntry(existing);
    }
    return existing;
  }
  if (!game.matchups.length && !game.prospects.length) return undefined;
  const entry: ArchiveEntry = {
    gameId: game.id,
    season,
    week: game.week,
    pregame: {
      capturedAt: new Date().toISOString(),
      kickoff: game.kickoff,
      away: game.away.short,
      home: game.home.short,
      abbr: { home: game.home.abbr, away: game.away.abbr },
      scoutScore: scoutScore(game.scoreComponents),
      whyWatch: game.whyWatch,
      pressurePoint: game.pressurePoint,
      edges: game.matchups.map((m) => ({
        a: m.a,
        b: m.b,
        edge: m.edge ?? "even",
        axis: axisOf(m),
        offTeam: m.a.replace(/ (run game|pass game|passing-down offense|deep passing|offensive line|ground game|on passing downs)$/i, ""),
        why: m.why,
      })),
      prospects: game.prospects
        .filter((p) => p.radar)
        .map((p) => ({ id: p.id, name: p.name, team: p.radar!.team, pos: p.pos, group: p.radar!.group, tier: p.tier, score: p.radar!.score })),
      spread: game.market.spread ? { team: game.market.spread.team, line: game.market.spread.line } : undefined,
      total: game.market.total?.line,
      projection: game.projection
        ? { winner: game.projection.winner, winProb: game.projection.winProb, margin: game.projection.margin, home: game.projection.home, away: game.projection.away, modelSide: game.projection.modelSide, confidence: game.projection.confidence, modelTotal: game.projection.modelTotal, totalLean: game.projection.totalLean }
        : undefined,
      consensus: consensusLock(game),
    },
  };
  const posted = postFrom(entry.pregame, entry.pregame.abbr, entry.pregame.capturedAt);
  if (posted.side || posted.total) entry.pregame.posted = posted;
  writeEntry(entry);
  return entry;
}

function consensusLock(game: Game): Pregame["consensus"] {
  const c = game.consensus;
  if (!c || c.median === undefined || !c.favorite) return undefined;
  return { median: c.median, favorite: c.favorite, side: c.side, sideCount: c.sideCount, of: c.available };
}

/* ------------------------------------------------------------ grading */

export interface TeamBox {
  rushYds: number;
  rushCar: number;
  passYds: number;
  longPlay: number;
}

/**
 * The box-score bar for a unit edge. Run game and ground game edges share the rushing line. One function so the record's
 * base rates (record-base.ts) hold every team-game to the same bar.
 */
export function edgeVerdict(axis: "rush" | "line" | "pass", edge: "offense" | "defense", off: TeamBox): Exclude<Verdict, "unmeasured"> {
  const ypc = off.rushCar ? off.rushYds / off.rushCar : 0;
  if (axis === "pass") {
    if (edge === "offense") return off.passYds >= 250 || off.longPlay >= 40 ? "played out" : off.passYds < 160 && off.longPlay < 30 ? "did not play out" : "mixed";
    return off.passYds <= 180 && off.longPlay < 35 ? "played out" : off.passYds >= 260 || off.longPlay >= 45 ? "did not play out" : "mixed";
  }
  if (edge === "offense") return ypc >= 4.6 || off.rushYds >= 170 ? "played out" : ypc < 3.4 && off.rushYds < 110 ? "did not play out" : "mixed";
  return ypc <= 3.5 ? "played out" : ypc >= 4.8 ? "did not play out" : "mixed";
}

/** One player's game in the units the radar's "showed up" bar is set in. */
export interface ProspectNumbers {
  passYds: number;
  passTd: number;
  rushYds: number;
  rushTd: number;
  recYds: number;
  recTd: number;
  tackles: number;
  sacks: number;
  tfl: number;
  pd: number;
  int: number;
}

/** The radar's "showed up" bar. Shared with record-base.ts so the base rate uses the same bar. */
export function prospectShowed(n: ProspectNumbers): boolean {
  return (
    n.passYds >= 200 || n.passTd >= 2 ||
    n.rushYds >= 60 || n.rushTd >= 1 ||
    n.recYds >= 50 || n.recTd >= 1 ||
    n.tackles >= 6 || n.sacks >= 1 || n.tfl >= 1.5 || n.pd >= 2 ||
    n.int >= 1
  );
}

/**
 * The edges that count in the record: graded ones (not even, not unmeasured), with a run game and a ground game edge on
 * the same offense counted once, since both are graded on the same rushing line.
 */
export function countedEdges<T extends EdgeCall & { verdict: Verdict }>(edges: T[]): T[] {
  const seen = new Set<string>();
  return edges.filter((x) => {
    if (x.edge === "even" || x.verdict === "unmeasured") return false;
    const key = `${x.offTeam}|${x.axis === "line" ? "rush" : x.axis}|${x.edge}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function teamBox(box: BoxScore, school: string): TeamBox | undefined {
  const t = box.teams.find((x) => x.team === school);
  if (!t) return undefined;
  const lines = [...box.byPlayer.values()].flat().filter((l) => l.team === school);
  const sum = (cat: string, key: string) => lines.filter((l) => l.category === cat).reduce((s, l) => s + Number(l.stats[key] ?? 0), 0);
  const max = (cat: string, key: string) => Math.max(0, ...lines.filter((l) => l.category === cat).map((l) => Number(l.stats[key] ?? 0)));
  return { rushYds: sum("rushing", "YDS"), rushCar: sum("rushing", "CAR"), passYds: sum("passing", "YDS"), longPlay: Math.max(t.longPlay ?? 0, max("receiving", "LONG"), max("rushing", "LONG")) };
}

function gradeEdge(e: EdgeCall, off: TeamBox | undefined, gameId?: string): { verdict: Verdict; actual: string } {
  // Passing downs are graded from play-by-play (situational digest), not the box score.
  if (e.axis === "passing-downs" && gameId) {
    const g = gradePassingDowns(gameId, e.offTeam, e.b.replace(/ (pressure|passing-down defense)$/i, ""), e.edge);
    if (g) return g;
  }
  if (!off) return { verdict: "unmeasured", actual: "No box score for the offense." };
  const ypc = off.rushCar ? off.rushYds / off.rushCar : 0;
  const rushLine = `${off.rushYds} rush yds on ${off.rushCar} carries (${ypc.toFixed(1)} per)`;
  const passLine = `${off.passYds} pass yds, longest play ${off.longPlay}`;
  if (e.edge === "even") return { verdict: "unmeasured", actual: e.axis === "pass" ? passLine : rushLine };
  if (e.axis === "rush" || e.axis === "line" || e.axis === "pass") return { verdict: edgeVerdict(e.axis, e.edge, off), actual: e.axis === "pass" ? passLine : rushLine };
  return { verdict: "unmeasured", actual: "Third-down detail is not in the box score. Play-by-play for this game is not ingested yet (npm run ingest:plays)." };
}

function gradeProspect(p: ProspectCall, box: BoxScore): { verdict: ProspectResult["verdict"]; line: string } {
  const lines = box.byPlayer.get(p.id) ?? [];
  if (p.group === "OL") return { verdict: "unmeasured", line: "Linemen have no box-score line." };
  if (p.tier === "Matchup" && !lines.length) return { verdict: "quiet", line: "No box-score line." };
  if (!lines.length) return { verdict: "quiet", line: "No box-score line." };
  const n = (cat: string, k: string) => Number(lines.find((l) => l.category === cat)?.stats[k] ?? 0);
  const showed = prospectShowed({
    passYds: n("passing", "YDS"), passTd: n("passing", "TD"),
    rushYds: n("rushing", "YDS"), rushTd: n("rushing", "TD"),
    recYds: n("receiving", "YDS"), recTd: n("receiving", "TD"),
    tackles: n("defensive", "TOT"), sacks: n("defensive", "SACKS"), tfl: n("defensive", "TFL"), pd: n("defensive", "PD"),
    int: n("interceptions", "INT"),
  });
  return { verdict: showed ? "showed up" : "quiet", line: lines.map((l) => l.headline).join(" · ") };
}

/** Grade the locked call against the final box score. Runs once. */
export function gradePostgame(game: Game, season: number, box: BoxScore, excitement?: number | null): ArchiveEntry | undefined {
  if (game.status !== "final" || !game.score || !Number.isFinite(game.score.home)) return undefined;
  const entry = readEntry(season, game.id);
  if (entry?.postgame) {
    // A passing-downs edge graded before play-by-play was ingested gets filled in once the digest has the game.
    let changed = false;
    for (const x of entry.postgame.edges) {
      if (x.axis !== "passing-downs" || x.verdict !== "unmeasured" || x.edge === "even") continue;
      const g = gradePassingDowns(game.id, x.offTeam, x.b.replace(/ (pressure|passing-down defense)$/i, ""), x.edge);
      if (g && g.verdict !== "unmeasured") {
        x.verdict = g.verdict;
        x.actual = g.actual;
        changed = true;
      }
    }
    if (changed) writeEntry(entry);
  }
  if (!entry || entry.postgame) return entry;
  const pre = entry.pregame;
  const edges: EdgeResult[] = pre.edges.map((e) => ({ ...e, ...gradeEdge(e, teamBox(box, e.offTeam), game.id) }));
  const prospects: ProspectResult[] = pre.prospects.map((p) => ({ ...p, ...gradeProspect(p, box) }));

  let spreadResult: Postgame["spreadResult"];
  if (pre.spread) {
    const favHome = pre.spread.team === pre.abbr.home;
    const margin = favHome ? game.score.home - game.score.away : game.score.away - game.score.home;
    const need = Math.abs(pre.spread.line);
    spreadResult = margin > need ? "favorite covered" : margin < need ? "underdog covered" : "push";
  }
  let totalResult: Postgame["totalResult"];
  if (pre.total !== undefined) {
    const pts = game.score.home + game.score.away;
    totalResult = pts > pre.total ? "over" : pts < pre.total ? "under" : "push";
  }
  let projectionResult: Postgame["projectionResult"];
  if (pre.projection) {
    const actualHomeMargin = game.score.home - game.score.away;
    const actualWinner = actualHomeMargin > 0 ? pre.abbr.home : actualHomeMargin < 0 ? pre.abbr.away : "tie";
    const projHomeMargin = pre.projection.winner === pre.abbr.home ? pre.projection.margin : -pre.projection.margin;
    let modelSideCovered: boolean | undefined;
    if (pre.spread && pre.projection.modelSide && spreadResult && spreadResult !== "push") {
      const favoriteSide = pre.spread.team;
      const modelOnFavorite = pre.projection.modelSide === favoriteSide;
      modelSideCovered = modelOnFavorite ? spreadResult === "favorite covered" : spreadResult === "underdog covered";
    }
    let totalLeanRight: boolean | undefined;
    if (pre.projection.totalLean && pre.projection.totalLean !== "none" && totalResult && totalResult !== "push") totalLeanRight = pre.projection.totalLean === totalResult;
    projectionResult = { winnerRight: actualWinner === pre.projection.winner, marginError: Math.abs(actualHomeMargin - projHomeMargin), modelSideCovered, totalLeanRight };
  }
  let consensusResult: Postgame["consensusResult"];
  if (pre.consensus) {
    const actualHomeMargin = game.score.home - game.score.away;
    const actualWinner = actualHomeMargin > 0 ? pre.abbr.home : actualHomeMargin < 0 ? pre.abbr.away : "tie";
    let sideCovered: boolean | undefined;
    if (pre.spread && pre.consensus.side && spreadResult && spreadResult !== "push") {
      const onFavorite = pre.consensus.side === pre.spread.team;
      sideCovered = onFavorite ? spreadResult === "favorite covered" : spreadResult === "underdog covered";
    }
    consensusResult = { winnerRight: actualWinner === pre.consensus.favorite, marginError: Math.abs(actualHomeMargin - pre.consensus.median), sideCovered };
  }
  const top = edges.find((e) => e.edge !== "even") ?? edges[0];
  // CLV for the posted calls, the same calls the ledger grades. The follow-the-line lock ends at the close, so it has none.
  const clv = closingValue(season, game.id, pre.kickoff, postedCall(postedOf(pre), pre.abbr));
  entry.postgame = {
    projectionResult,
    clv,
    consensusResult,
    capturedAt: new Date().toISOString(),
    score: { home: game.score.home, away: game.score.away },
    excitement: excitement ?? null,
    spreadResult,
    totalResult,
    edges,
    prospects,
    pressurePointVerdict: top?.verdict ?? "unmeasured",
  };
  writeEntry(entry);
  return entry;
}

/* ------------------------------------------------------------ history */

export function listEntries(season?: number): ArchiveEntry[] {
  if (!existsSync(DIR)) return [];
  const seasons = season ? [String(season)] : readdirSync(DIR);
  const out: ArchiveEntry[] = [];
  for (const s of seasons) {
    const d = path.join(DIR, s);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(path.join(d, f), "utf8")) as ArchiveEntry);
      } catch {}
    }
  }
  return out.sort((a, b) => b.pregame.kickoff.localeCompare(a.pregame.kickoff));
}

export interface HistoryStats {
  games: number;
  graded: number;
  edgeCalls: number;
  edgePlayedOut: number;
  edgeMissed: number;
  prospectCalls: number;
  prospectShowedUp: number;
  pressurePlayedOut: number;
  pressureGraded: number;
  favoriteCovered: number;
  spreadGraded: number;
  winnerRight: number;
  winnerGraded: number;
  /** Model sides at a 2+ point gap (leans.ts); under that the model and the market agree, so there is no call to grade. */
  modelSideCovered: number;
  modelSideGraded: number;
  /** Every model side, gap or not: shown as context only. */
  modelSideAllCovered: number;
  modelSideAllGraded: number;
  avgMarginError: number | null;
  totalLeanRight: number;
  totalLeanGraded: number;
  consensusWinnerRight: number;
  consensusWinnerGraded: number;
  /** Consensus sides at a 2+ point gap between the consensus median and the line. */
  consensusSideCovered: number;
  consensusSideGraded: number;
  /**
   * Matchup calls and radar names against chance, when a base was given (record-base.ts): on the calls that have a base,
   * how many hit and how many would have hit at the base rate (the sum of each call's base rate).
   */
  edgeBase?: { calls: number; hits: number; expected: number };
  prospectBase?: { calls: number; hits: number; expected: number };
  byBucket: { label: string; games: number; avgExcitement: number | null }[];
}

const consensusGap = (pre: Pregame): number | undefined => {
  if (!pre.spread || !pre.consensus) return undefined;
  const marketHome = pre.spread.team === pre.abbr.home ? -pre.spread.line : pre.spread.line;
  return Math.abs(pre.consensus.median - marketHome);
};

export function historyStats(entries: ArchiveEntry[], base?: RecordBase): HistoryStats {
  const graded = entries.filter((e) => e.postgame);
  const edges = graded.flatMap((e) => countedEdges(e.postgame!.edges));
  const pros = graded.flatMap((e) => e.postgame!.prospects.filter((p) => p.verdict !== "unmeasured"));
  const pressure = graded.filter((e) => e.postgame!.pressurePointVerdict !== "unmeasured");
  const spread = graded.filter((e) => e.postgame!.spreadResult && e.postgame!.spreadResult !== "push");
  const buckets = [
    { label: "80+", lo: 80, hi: 101 },
    { label: "60-79", lo: 60, hi: 80 },
    { label: "40-59", lo: 40, hi: 60 },
    { label: "under 40", lo: 0, hi: 40 },
  ].map((b) => {
    const gs = graded.filter((e) => e.pregame.scoutScore >= b.lo && e.pregame.scoutScore < b.hi && e.postgame!.excitement != null);
    return { label: b.label, games: gs.length, avgExcitement: gs.length ? gs.reduce((s, e) => s + (e.postgame!.excitement ?? 0), 0) / gs.length : null };
  });
  const proj = graded.filter((e) => e.postgame!.projectionResult);
  const sidedAll = proj.filter((e) => e.postgame!.projectionResult!.modelSideCovered !== undefined);
  const sided = sidedAll.filter((e) => (callGaps(e.pregame, e.pregame.abbr).sideGap ?? 0) >= LEAN_THRESHOLDS.side.moderate);
  const totaled = proj.filter((e) => e.postgame!.projectionResult!.totalLeanRight !== undefined);
  const cons = graded.filter((e) => e.postgame!.consensusResult);
  const consSided = cons.filter((e) => e.postgame!.consensusResult!.sideCovered !== undefined && (consensusGap(e.pregame) ?? 0) >= LEAN_THRESHOLDS.side.moderate);
  // Base rates: how often any team-game (edges) or any every-down player at the spot (radar) clears each graded call's bar.
  // Passing-down edges are already graded against the team's own season rate, so they are left out of this comparison.
  const edgeBase = base
    ? edges.flatMap((x) => {
        const r = (x.axis === "pass" ? base.edge.pass : x.axis === "rush" || x.axis === "line" ? base.edge.rush : undefined)?.[x.edge as "offense" | "defense"];
        return r === undefined ? [] : [{ r, hit: x.verdict === "played out" }];
      })
    : [];
  const prosBase = base ? pros.flatMap((p) => (base.prospect[p.group] ? [{ r: base.prospect[p.group].rate, hit: p.verdict === "showed up" }] : [])) : [];
  return {
    consensusWinnerRight: cons.filter((e) => e.postgame!.consensusResult!.winnerRight).length,
    consensusWinnerGraded: cons.length,
    consensusSideCovered: consSided.filter((e) => e.postgame!.consensusResult!.sideCovered).length,
    consensusSideGraded: consSided.length,
    totalLeanRight: totaled.filter((e) => e.postgame!.projectionResult!.totalLeanRight).length,
    totalLeanGraded: totaled.length,
    winnerRight: proj.filter((e) => e.postgame!.projectionResult!.winnerRight).length,
    winnerGraded: proj.length,
    modelSideCovered: sided.filter((e) => e.postgame!.projectionResult!.modelSideCovered).length,
    modelSideGraded: sided.length,
    modelSideAllCovered: sidedAll.filter((e) => e.postgame!.projectionResult!.modelSideCovered).length,
    modelSideAllGraded: sidedAll.length,
    edgeBase: base ? { calls: edgeBase.length, hits: edgeBase.filter((x) => x.hit).length, expected: edgeBase.reduce((s, x) => s + x.r, 0) } : undefined,
    prospectBase: base ? { calls: prosBase.length, hits: prosBase.filter((x) => x.hit).length, expected: prosBase.reduce((s, x) => s + x.r, 0) } : undefined,
    avgMarginError: proj.length ? proj.reduce((s, e) => s + e.postgame!.projectionResult!.marginError, 0) / proj.length : null,
    games: entries.length,
    graded: graded.length,
    edgeCalls: edges.length,
    edgePlayedOut: edges.filter((x) => x.verdict === "played out").length,
    edgeMissed: edges.filter((x) => x.verdict === "did not play out").length,
    prospectCalls: pros.length,
    prospectShowedUp: pros.filter((p) => p.verdict === "showed up").length,
    pressurePlayedOut: pressure.filter((e) => e.postgame!.pressurePointVerdict === "played out").length,
    pressureGraded: pressure.length,
    favoriteCovered: spread.filter((e) => e.postgame!.spreadResult === "favorite covered").length,
    spreadGraded: spread.length,
    byBucket: buckets,
  };
}

/* ------------------------------------------------------------ against the closing line */

export interface MarketBenchmarks {
  /** Graded games with a locked projection and a closing spread. */
  games: number;
  /** Average points the final lock's margin and the closing spread missed the real margin by. */
  marginModel: number | null;
  marginMarket: number | null;
  totalGames: number;
  totalModel: number | null;
  totalMarket: number | null;
  /** Brier score (lower is better) of the model's win chance and the closing moneyline's no-vig chance. */
  brierGames: number;
  brierModel: number | null;
  brierMarket: number | null;
  /** Straight-up winners: the model's pick against simply taking the closing favorite (pick'em closes left out). */
  winnerGames: number;
  winnerModel: number;
  winnerFavorite: number;
}

const impliedProb = (ml: number) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));

/** The model against the closing line on the same games: margin miss, total miss, win-chance Brier, and straight-up winners. */
export function marketBenchmarks(entries: ArchiveEntry[]): MarketBenchmarks {
  const margin: [number, number][] = [];
  const total: [number, number][] = [];
  const brier: [number, number][] = [];
  let winnerGames = 0, winnerModel = 0, winnerFavorite = 0;
  for (const e of entries) {
    const post = e.postgame;
    const p = e.pregame.projection;
    if (!post || !p) continue;
    const close = closingLine(e.season, e.gameId, e.pregame.kickoff);
    if (!close) continue;
    const { home, away } = e.pregame.abbr;
    const actual = post.score.home - post.score.away;
    const pts = post.score.home + post.score.away;
    const modelHome = p.winner === home ? p.margin : -p.margin;
    if (close.spread !== undefined) {
      margin.push([Math.abs(modelHome - actual), Math.abs(-close.spread - actual)]);
      if (close.spread !== 0) {
        const winner = actual > 0 ? home : actual < 0 ? away : "tie";
        winnerGames++;
        if (p.winner === winner) winnerModel++;
        if ((close.spread < 0 ? home : away) === winner) winnerFavorite++;
      }
    }
    if (close.total !== undefined && p.modelTotal !== undefined) total.push([Math.abs(p.modelTotal - pts), Math.abs(close.total - pts)]);
    if (close.mlHome !== undefined && close.mlAway !== undefined) {
      const ph = impliedProb(close.mlHome), pa = impliedProb(close.mlAway);
      const won = actual > 0 ? 1 : actual < 0 ? 0 : 0.5;
      const modelP = p.winner === home ? p.winProb : 1 - p.winProb;
      brier.push([(modelP - won) ** 2, (ph / (ph + pa) - won) ** 2]);
    }
  }
  const avg = (xs: [number, number][], i: 0 | 1, dp: number) => (xs.length ? Math.round((xs.reduce((s, x) => s + x[i], 0) / xs.length) * 10 ** dp) / 10 ** dp : null);
  return {
    games: margin.length,
    marginModel: avg(margin, 0, 2),
    marginMarket: avg(margin, 1, 2),
    totalGames: total.length,
    totalModel: avg(total, 0, 2),
    totalMarket: avg(total, 1, 2),
    brierGames: brier.length,
    brierModel: avg(brier, 0, 4),
    brierMarket: avg(brier, 1, 4),
    winnerGames,
    winnerModel,
    winnerFavorite,
  };
}
