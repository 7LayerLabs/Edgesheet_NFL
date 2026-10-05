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
import { closingValue, type ClvRecord } from "./odds";
import { gradePassingDowns } from "./situational";

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
  if (t.includes("ground game")) return "line";
  if (t.includes("run game")) return "rush";
  if (t.includes("deep passing")) return "pass";
  if (t.includes("offensive line")) return "line";
  if (t.includes("passing downs")) return "passing-downs";
  return "other";
}

const projLock = (p: NonNullable<Game["projection"]>): NonNullable<Pregame["projection"]> => ({ winner: p.winner, winProb: p.winProb, margin: p.margin, home: p.home, away: p.away, modelSide: p.modelSide, confidence: p.confidence, modelTotal: p.modelTotal, totalLean: p.totalLean });

/**
 * Lock the pregame call before kickoff. The call follows the news until the game starts: when the
 * projection or the posted number moves (an injury, a new starter, a line move), the lock is refreshed
 * with the line it was made against, and the first lock is kept under `first`. Nothing moves after kickoff.
 */
export function lockPregame(game: Game, season: number): ArchiveEntry | undefined {
  if (game.source !== "live" || game.status !== "upcoming") return undefined;
  const existing = readEntry(season, game.id);
  if (existing) {
    if (!existing.postgame && game.projection) {
      const next = projLock(game.projection);
      const cur = existing.pregame.projection;
      const spread = game.market.spread ? { team: game.market.spread.team, line: game.market.spread.line } : undefined;
      const total = game.market.total?.line;
      const moved =
        !cur ||
        cur.winner !== next.winner || cur.margin !== next.margin || cur.modelSide !== next.modelSide || cur.modelTotal !== next.modelTotal || cur.totalLean !== next.totalLean ||
        existing.pregame.spread?.team !== spread?.team || existing.pregame.spread?.line !== spread?.line || existing.pregame.total !== total;
      if (moved) {
        if (cur) existing.pregame.first ??= { capturedAt: existing.pregame.capturedAt, spread: existing.pregame.spread, total: existing.pregame.total, projection: cur };
        existing.pregame.projection = next;
        existing.pregame.spread = spread;
        existing.pregame.total = total;
        existing.pregame.consensus = consensusLock(game) ?? existing.pregame.consensus;
        existing.pregame.updatedAt = new Date().toISOString();
        writeEntry(existing);
      }
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
        offTeam: m.a.replace(/ (run game|deep passing|offensive line|ground game|on passing downs)$/i, ""),
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
  writeEntry(entry);
  return entry;
}

function consensusLock(game: Game): Pregame["consensus"] {
  const c = game.consensus;
  if (!c || c.median === undefined || !c.favorite) return undefined;
  return { median: c.median, favorite: c.favorite, side: c.side, sideCount: c.sideCount, of: c.available };
}

/* ------------------------------------------------------------ grading */

interface TeamBox {
  rushYds: number;
  rushCar: number;
  passYds: number;
  longPlay: number;
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
    const g = gradePassingDowns(gameId, e.offTeam, e.b.replace(/ pressure$/i, ""), e.edge);
    if (g) return g;
  }
  if (!off) return { verdict: "unmeasured", actual: "No box score for the offense." };
  const ypc = off.rushCar ? off.rushYds / off.rushCar : 0;
  const rushLine = `${off.rushYds} rush yds on ${off.rushCar} carries (${ypc.toFixed(1)} per)`;
  const passLine = `${off.passYds} pass yds, longest play ${off.longPlay}`;
  if (e.edge === "even") return { verdict: "unmeasured", actual: e.axis === "pass" ? passLine : rushLine };
  switch (e.axis) {
    case "rush":
    case "line": {
      if (e.edge === "offense") return { verdict: ypc >= 4.6 || off.rushYds >= 170 ? "played out" : ypc < 3.4 && off.rushYds < 110 ? "did not play out" : "mixed", actual: rushLine };
      return { verdict: ypc <= 3.5 ? "played out" : ypc >= 4.8 ? "did not play out" : "mixed", actual: rushLine };
    }
    case "pass": {
      if (e.edge === "offense") return { verdict: off.passYds >= 250 || off.longPlay >= 40 ? "played out" : off.passYds < 160 && off.longPlay < 30 ? "did not play out" : "mixed", actual: passLine };
      return { verdict: off.passYds <= 180 && off.longPlay < 35 ? "played out" : off.passYds >= 260 || off.longPlay >= 45 ? "did not play out" : "mixed", actual: passLine };
    }
    default:
      return { verdict: "unmeasured", actual: "Third-down detail is not in the box score. Play-by-play for this game is not ingested yet (npm run ingest:plays)." };
  }
}

function gradeProspect(p: ProspectCall, box: BoxScore): { verdict: ProspectResult["verdict"]; line: string } {
  const lines = box.byPlayer.get(p.id) ?? [];
  if (p.group === "OL") return { verdict: "unmeasured", line: "Linemen have no box-score line." };
  if (p.tier === "Matchup" && !lines.length) return { verdict: "quiet", line: "No box-score line." };
  if (!lines.length) return { verdict: "quiet", line: "No box-score line." };
  const n = (cat: string, k: string) => Number(lines.find((l) => l.category === cat)?.stats[k] ?? 0);
  const showed =
    n("passing", "YDS") >= 200 || n("passing", "TD") >= 2 ||
    n("rushing", "YDS") >= 60 || n("rushing", "TD") >= 1 ||
    n("receiving", "YDS") >= 50 || n("receiving", "TD") >= 1 ||
    n("defensive", "TOT") >= 6 || n("defensive", "SACKS") >= 1 || n("defensive", "TFL") >= 1.5 || n("defensive", "PD") >= 2 ||
    n("interceptions", "INT") >= 1;
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
      const g = gradePassingDowns(game.id, x.offTeam, x.b.replace(/ pressure$/i, ""), x.edge);
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
  // CLV against the first lock: the lock follows the line to kickoff, so against the final lock it is zero by construction.
  const clv = closingValue(season, game.id, pre.kickoff, pre.first ? { ...pre.first, abbr: pre.abbr } : pre);
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
  modelSideCovered: number;
  modelSideGraded: number;
  avgMarginError: number | null;
  totalLeanRight: number;
  totalLeanGraded: number;
  consensusWinnerRight: number;
  consensusWinnerGraded: number;
  consensusSideCovered: number;
  consensusSideGraded: number;
  byBucket: { label: string; games: number; avgExcitement: number | null }[];
}

export function historyStats(entries: ArchiveEntry[]): HistoryStats {
  const graded = entries.filter((e) => e.postgame);
  const edges = graded.flatMap((e) => e.postgame!.edges.filter((x) => x.edge !== "even" && x.verdict !== "unmeasured"));
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
  const sided = proj.filter((e) => e.postgame!.projectionResult!.modelSideCovered !== undefined);
  const totaled = proj.filter((e) => e.postgame!.projectionResult!.totalLeanRight !== undefined);
  const cons = graded.filter((e) => e.postgame!.consensusResult);
  const consSided = cons.filter((e) => e.postgame!.consensusResult!.sideCovered !== undefined);
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
