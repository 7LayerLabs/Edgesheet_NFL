/**
 * The Sunday sheet: one page of NFL facts for a date, built from the
 * same functions the site uses (getSlate, projections, unit edges, radar,
 * forecast bands, weather rules, model leans). Server-only (reads the AI watch
 * guide cache from disk). Output is plain JSON so the page and the PNG render
 * can share it. Nothing here is invented; every number is read off a Game.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { kickoffTime } from "./format";
import { modelLeans, NOT_A_PICK, longDate, type Lean } from "./digests";
import { scoutScore } from "./score";
import { getSlate } from "./slate";
import { unitEdges } from "./tendencies";
import type { Game } from "./types";
import { evaluateWeather } from "./weather";

const isD1 = (g: Game) => g.division === "NFL";
const label = (t: Game["home"]) => `${t.rank ? `No. ${t.rank} ` : ""}${t.short}`;

export interface SheetGame {
  id: string;
  away: string;
  home: string;
  awayAbbr: string;
  homeAbbr: string;
  awayLogo?: string;
  homeLogo?: string;
  kickoff: string; // "3:30 PM"
  kickoffIso: string;
  network: string;
  score: number;
  line?: string; // "UGA -6.5"
  total?: number;
  lean?: string; // "UGA by 3.1" or "over by 4.0"
  why: string;
  status: Game["status"];
}

export interface SheetEdge {
  gameId: string;
  title: string; // "Georgia run game vs Alabama run defense"
  edge: "offense" | "defense";
  strength: string;
  gap: number;
  winner: string; // the side with the edge, school
  evidence: string;
}

export interface SheetLean {
  gameId: string;
  matchup: string;
  kind: "side" | "total";
  strength: "strong" | "moderate";
  text: string; // "UGA by 3.1 vs ALA -6.5" or "over by 4.0 (model 58 vs 54)"
  confidence?: string;
}

export interface SheetRadarName {
  id: string;
  name: string;
  team: string;
  pos: string;
  cls: string;
  score: number;
  tier: string;
  band?: string;
  stat: string;
  gameId: string;
  matchup: string;
  kickoff: string;
}

export interface SheetWindow {
  hour: string; // "12 PM"
  games: { id: string; label: string; network: string; score: number }[];
}

export interface SheetWeather {
  gameId: string;
  matchup: string;
  kickoff: string;
  level: "flag" | "elevated";
  title: string;
  effect: string;
}

export interface Sheet {
  date: string;
  dateLong: string;
  season: number;
  week?: number;
  source: "live" | "sample";
  counts: { all: number; d1: number; fbs: number; fcs: number; ranked: number; divGames: number };
  games: SheetGame[];
  edges: SheetEdge[];
  leans: SheetLean[];
  radar: SheetRadarName[];
  windows: SheetWindow[];
  weather: SheetWeather[];
  notes: string[];
  statsAsOf?: string;
  builtAt: string;
  notAPick: string;
}

/** The AI watch guide's one-line card text, when the whywatch agent has cached one. Never throws. */
export function cardLineFor(season: number, gameId: string): string | undefined {
  try {
    const file = path.join(process.cwd(), "data", "ai", "watchguide", String(season), `${gameId}.json`);
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { cardLine?: unknown; card?: unknown };
    const line = typeof raw.cardLine === "string" ? raw.cardLine : typeof raw.card === "string" ? raw.card : undefined;
    return line?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function lineText(g: Game): string | undefined {
  const s = g.market.spread;
  if (!s) return undefined;
  return `${s.team} ${s.line > 0 ? "+" : ""}${s.line}`;
}

function leanText(g: Game): string | undefined {
  const p = g.projection;
  if (!p) return undefined;
  const parts: string[] = [];
  if (p.modelSide && p.sideGap !== undefined && p.sideGap >= 2) parts.push(`${p.modelSide} by ${p.sideGap.toFixed(1)}`);
  if (p.totalLean && p.totalLean !== "none" && p.totalGap !== undefined && Math.abs(p.totalGap) >= 2.5) parts.push(`${p.totalLean} by ${Math.abs(p.totalGap).toFixed(1)}`);
  if (parts.length) return parts.join(", ");
  return `${p.winner} ${Math.round(p.winProb * 100)}%`;
}

function leanRow(l: Lean): SheetLean {
  const g = l.game;
  const matchup = `${label(g.away)} at ${label(g.home)}`;
  if (l.kind === "side") {
    const s = g.market.spread!;
    return { gameId: g.id, matchup, kind: "side", strength: l.strength, text: `${l.team} by ${l.gap.toFixed(1)} vs ${s.team} ${s.line > 0 ? "+" : ""}${s.line}`, confidence: g.projection?.confidence };
  }
  return { gameId: g.id, matchup, kind: "total", strength: l.strength, text: `${l.direction} by ${l.gap.toFixed(1)}, model ${l.modelTotal} vs posted ${l.marketTotal}` };
}

function hourKey(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "America/New_York" });
}

export async function buildSheet(dateParam?: string): Promise<Sheet> {
  const slate = await getSlate(dateParam);
  const d1 = slate.games.filter(isD1);
  const score = (g: Game) => scoutScore(g.scoreComponents);
  const byScore = [...d1].sort((a, b) => score(b) - score(a));
  const matchupOf = (g: Game) => `${label(g.away)} at ${label(g.home)}`;

  // Games that matter: top 8 by Watch Score.
  const games: SheetGame[] = byScore.slice(0, 8).map((g) => ({
    id: g.id,
    away: label(g.away),
    home: label(g.home),
    awayAbbr: g.away.abbr,
    homeAbbr: g.home.abbr,
    awayLogo: g.away.logo,
    homeLogo: g.home.logo,
    kickoff: kickoffTime(g.kickoff),
    kickoffIso: g.kickoff,
    network: g.network,
    score: score(g),
    line: lineText(g),
    total: g.market.total?.line,
    lean: leanText(g),
    why: cardLineFor(slate.season, g.id) ?? g.whyWatch,
    status: g.status,
  }));

  // Edges: the biggest unit mismatches across the whole slate, one per game at most.
  const edges: SheetEdge[] = [];
  for (const g of d1) {
    const rows = [...unitEdges(g.away.short, g.home.short), ...unitEdges(g.home.short, g.away.short)].filter((e) => e.edge !== "even");
    const top = rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
    if (!top) continue;
    const [offSide, defSide] = top.title.split(" vs ");
    edges.push({
      gameId: g.id,
      title: top.title,
      edge: top.edge as "offense" | "defense",
      strength: top.strength,
      gap: Math.abs(top.gap),
      winner: top.edge === "offense" ? offSide.replace(/ (run game|deep passing|offensive line|on passing downs)$/, "") : defSide.replace(/ (run defense|secondary|front|pressure)$/, ""),
      evidence: top.evidence,
    });
  }
  edges.sort((a, b) => b.gap - a.gap).splice(10);

  // Leans: model side and total leans, strong first.
  const leans = modelLeans(d1).map(leanRow).slice(0, 12);

  // Radar names: top 10 radar players on today's games.
  const seen = new Set<string>();
  const radar: SheetRadarName[] = [];
  for (const g of d1) {
    for (const p of g.prospects) {
      if (!p.radar || seen.has(p.id)) continue;
      seen.add(p.id);
      radar.push({
        id: p.id,
        name: p.name,
        team: p.team,
        pos: p.pos,
        cls: p.cls,
        score: p.radar.score,
        tier: p.radar.tier,
        band: undefined,
        stat: p.radar.stat,
        gameId: g.id,
        matchup: `${g.away.abbr} at ${g.home.abbr}`,
        kickoff: kickoffTime(g.kickoff),
      });
    }
  }
  radar.sort((a, b) => b.score - a.score).splice(10);

  // Kickoff windows: ranked games by hour. Falls back to the top 12 by score when no ranked team plays.
  const rankedGames = d1.filter((g) => g.home.rank || g.away.rank);
  const pool = rankedGames.length ? rankedGames : byScore.slice(0, 12);
  const byHour = new Map<string, { iso: string; games: SheetWindow["games"] }>();
  for (const g of [...pool].sort((a, b) => a.kickoff.localeCompare(b.kickoff))) {
    const k = hourKey(g.kickoff);
    const slot = byHour.get(k) ?? { iso: g.kickoff, games: [] };
    slot.games.push({ id: g.id, label: `${g.away.abbr}${g.away.rank ? ` (${g.away.rank})` : ""} at ${g.home.abbr}${g.home.rank ? ` (${g.home.rank})` : ""}`, network: g.network, score: score(g) });
    byHour.set(k, slot);
  }
  const windows: SheetWindow[] = [...byHour.entries()].sort((a, b) => a[1].iso.localeCompare(b[1].iso)).map(([hour, v]) => ({ hour, games: v.games.sort((a, b) => b.score - a.score) }));

  // Weather flags: anything the rules engine rates flag or elevated.
  const weather: SheetWeather[] = [];
  for (const g of d1) {
    if (!g.weather) continue;
    for (const f of evaluateWeather(g.weather)) {
      if (f.level === "note") continue;
      weather.push({ gameId: g.id, matchup: matchupOf(g), kickoff: kickoffTime(g.kickoff), level: f.level, title: f.title, effect: f.effect });
    }
  }
  weather.sort((a, b) => (a.level === "elevated" ? 0 : 1) - (b.level === "elevated" ? 0 : 1));

  const notes: string[] = [];
  if (!d1.length) notes.push("No games on this date.");
  if (d1.length && !d1.some((g) => g.market.spread)) notes.push("No posted lines yet for this date.");
  if (d1.length && !d1.some((g) => g.projection)) notes.push("No projections: advanced stats are not ingested for these teams.");
  if (d1.length && !weather.length) notes.push("No weather flags. Every forecast is inside normal ranges or the game is indoors.");

  return {
    date: slate.date,
    dateLong: longDate(slate.date),
    season: slate.season,
    week: slate.week?.week,
    source: slate.source,
    counts: { all: slate.games.length, d1: d1.length, fbs: 0, fcs: 0, divGames: d1.filter((g) => g.divGame).length, ranked: rankedGames.length },
    games,
    edges,
    leans,
    radar,
    windows,
    weather,
    notes,
    statsAsOf: d1.find((g) => g.statsAsOf)?.statsAsOf,
    builtAt: new Date().toISOString(),
    notAPick: NOT_A_PICK,
  };
}
