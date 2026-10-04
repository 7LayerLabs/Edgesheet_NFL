/**
 * Game projection: a predicted outcome from pregame Elo, the four unit edges,
 * and the market. It is a model, not a pick, and the page says so. Every
 * projection is locked pregame and graded after the final on the Record page.
 */
import type { Market, Matchup, Team, WeatherInput } from "./types";
import type { GenTeam } from "./generated";
import { evaluateWeather } from "./weather";
import type { TeamAvailability } from "./availability";

export interface Projection {
  winner: string; // abbr
  winProb: number; // 0..1 for the winner
  margin: number; // points, positive for winner
  total: number;
  home: number;
  away: number;
  shape: string; // one sentence on how the game plays
  vsMarket?: string; // where the model disagrees with the number
  modelSide?: string; // abbr the model leans toward against the spread
  sideGap?: number; // points between model margin and market margin
  modelTotal?: number; // from efficiency and pace; undefined when not charted
  totalLean?: "over" | "under" | "none";
  totalGap?: number;
  totalNote?: string;
  weatherTilt?: string;
  /** Points the availability model moved the margin (home minus away) and the total, with one line per team. */
  availability?: { home: number; away: number; net: number; total: number; lines: string[] };
  basis: string[];
  confidence: "high" | "medium" | "low";
}

const HOME_ELO = 48; // NFL home-field edge in Elo points (scripts/lib/elo.mjs)
const ELO_PER_POINT = 25; // Elo difference per point of spread, NFL scale
const SIGMA = 13.5; // standard deviation of NFL margins

/**
 * Blend weights. The constants below are the live model. scripts/backtest.mjs writes fitted
 * values to data/weights.json; they are only applied when USE_FITTED_WEIGHTS=1 is set, so
 * running the backtest never changes the live projection on its own. See /backtest.
 */
const DEFAULT_BLEND = { eloWeight: 0.6, edgeDivisor: 40 };
let blendCache: { at: number; value: { eloWeight: number; edgeDivisor: number } } | undefined;
function blendWeights(): { eloWeight: number; edgeDivisor: number } {
  if (process.env.USE_FITTED_WEIGHTS !== "1") return DEFAULT_BLEND;
  const now = Date.now();
  if (blendCache && now - blendCache.at < 300_000) return blendCache.value;
  let value = DEFAULT_BLEND;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "weights.json"), "utf8")) as { projection?: { eloWeight?: number; edgeDivisor?: number } };
    const w = raw.projection ?? {};
    if (typeof w.eloWeight === "number" && w.eloWeight >= 0 && w.eloWeight <= 1 && typeof w.edgeDivisor === "number" && w.edgeDivisor > 0) {
      value = { eloWeight: w.eloWeight, edgeDivisor: w.edgeDivisor };
    }
  } catch {
    value = DEFAULT_BLEND;
  }
  blendCache = { at: now, value };
  return value;
}

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const probFromMargin = (m: number) => 0.5 * (1 + erf(m / (SIGMA * Math.SQRT2)));

interface Input {
  home: Team;
  away: Team;
  homeElo: number | null;
  awayElo: number | null;
  neutral: boolean;
  market: Market;
  matchups: Matchup[]; // from unitEdges, a = "<school> run game" etc.
  homeSchool: string;
  awaySchool: string;
  homePassRate?: number | null;
  awayPassRate?: number | null;
  homeAdv?: GenTeam;
  awayAdv?: GenTeam;
  means?: { offPpa: number; defPpa: number; plays: number };
  weather?: WeatherInput;
  /** Who is playing (src/lib/availability.ts). Each total is points: negative means that team is weaker than its numbers. */
  homeAvail?: TeamAvailability;
  awayAvail?: TeamAvailability;
}

// Fit by scripts/backtest-total.mjs on 2022 to 2025 (959 games from week 3 on, walk-forward): the old
// 22.8 with the full EPA deviation ran 0.7 points hot and missed the final total by 10.83 a game; 22.4
// (actual points per team in those games) with half the deviation missed by 10.51. The closing total
// missed by 10.12, and no gap to it beat a coin flip on the over/under, so the total is a read, not an edge.
const AVG_PPG = 22.4;
const TOTAL_SHRINK = 0.5;

/** Expected points for one offense against one defense: league average plus EPA deviations over the game's pace. */
function expectedPoints(off: GenTeam, def: GenTeam, means: { offPpa: number; defPpa: number }, plays: number): number {
  const dev = (TOTAL_SHRINK * (off.off.ppa - means.offPpa + (def.def.ppa - means.defPpa))) / 2;
  return Math.max(3, AVG_PPG + plays * dev);
}

export function projectGame(i: Input): Projection | undefined {
  const basis: string[] = [];
  let eloMargin: number | undefined;
  if (i.homeElo != null && i.awayElo != null) {
    const diff = i.homeElo + (i.neutral ? 0 : HOME_ELO) - i.awayElo;
    eloMargin = diff / ELO_PER_POINT;
    basis.push(`Pregame Elo: ${i.home.abbr} ${i.homeElo}, ${i.away.abbr} ${i.awayElo}${i.neutral ? ", neutral site" : `, +${HOME_ELO} home field`} → ${eloMargin >= 0 ? i.home.abbr : i.away.abbr} by ${Math.abs(eloMargin).toFixed(1)}`);
  }

  // Tendencies: net percentile gap across the unit edges, scaled to points. Four axes, each up to 100, so +-400 → +-10.
  let tendMargin: number | undefined;
  if (i.matchups.length) {
    const gapOf = (m: Matchup) => {
      const g = Number((m.evidence.match(/gap (\d+) percentile/) ?? [])[1] ?? 0);
      return m.edge === "offense" ? g : m.edge === "defense" ? -g : 0;
    };
    let net = 0;
    for (const m of i.matchups) {
      const homeOffense = m.a.startsWith(i.homeSchool);
      const g = gapOf(m); // positive favors the offense in that matchup
      net += homeOffense ? g : -g;
    }
    tendMargin = net / blendWeights().edgeDivisor;
    basis.push(`Unit edges: net ${net >= 0 ? "+" : ""}${net} percentile points to ${net >= 0 ? i.home.abbr : i.away.abbr} across ${i.matchups.length} matchups → ${net >= 0 ? i.home.abbr : i.away.abbr} by ${Math.abs(tendMargin).toFixed(1)}`);
  }

  const marketMargin = i.market.spread ? (i.market.spread.team === i.home.abbr ? -i.market.spread.line : i.market.spread.line) : undefined; // positive = home favored
  if (marketMargin !== undefined) basis.push(`Market: ${i.market.spread!.team} ${i.market.spread!.line}${i.market.total ? `, total ${i.market.total.line}` : ""}`);

  let margin: number;
  let confidence: Projection["confidence"];
  if (eloMargin !== undefined && tendMargin !== undefined) {
    // Elo carries the full margin and the unit edges adjust it. A weighted average compressed big favorites
    // and piled the leans onto underdogs (seen on the 2026-10-03 slate), so the edge term is additive.
    margin = eloMargin + (1 - blendWeights().eloWeight) * tendMargin;
    confidence = "high";
  } else if (eloMargin !== undefined) {
    margin = eloMargin;
    confidence = "medium";
  } else if (tendMargin !== undefined) {
    margin = tendMargin;
    confidence = "low";
  } else if (marketMargin !== undefined) {
    margin = marketMargin;
    confidence = "low";
    basis.push("No rating or tendency data; projection follows the market.");
  } else {
    return undefined;
  }

  // Who is playing. The ratings above were built by the players who took this season's snaps; this
  // prices the difference today: a new QB, starters out or doubtful, players traded or signed.
  let availability: Projection["availability"];
  if (i.homeAvail && i.awayAvail) {
    const h = i.homeAvail;
    const a = i.awayAvail;
    const net = Math.round((h.total - a.total) * 10) / 10;
    // Home scores its offense change minus the away defense change, and the reverse, so the total moves by both.
    const totalAdj = Math.round((h.offense + a.offense - h.defense - a.defense) * 10) / 10;
    const lineFor = (t: TeamAvailability, abbr: string) => {
      const bits = [
        t.qb && Math.abs(t.qb.pts) >= 0.5 ? `QB ${t.qb.expected} ${t.qb.pts > 0 ? "+" : ""}${t.qb.pts}` : "",
        ...t.items.filter((x) => x.kind !== "qb" && x.pts !== 0).slice(0, 3).map((x) => `${x.name} ${x.pts > 0 ? "+" : ""}${x.pts}`),
      ].filter(Boolean);
      return `${abbr} ${t.total > 0 ? "+" : ""}${t.total}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    };
    availability = { home: h.total, away: a.total, net, total: totalAdj, lines: [lineFor(a, i.away.abbr), lineFor(h, i.home.abbr)] };
    if (net !== 0) {
      margin += net;
      basis.push(`Who is playing: ${availability.lines.join("; ")} → ${net >= 0 ? i.home.abbr : i.away.abbr} +${Math.abs(net).toFixed(1)} on the margin`);
    } else basis.push(`Who is playing: no change that moves the margin (${availability.lines.join("; ")})`);
    if ((h.qb?.uncertain || a.qb?.uncertain) && confidence === "high") confidence = "medium";
  }

  // Model total from efficiency and pace, when both teams are charted.
  let modelTotal: number | undefined;
  let modelHomePts: number | undefined;
  let modelAwayPts: number | undefined;
  if (i.homeAdv && i.awayAdv && i.means) {
    const pace = ((i.homeAdv.off.plays / Math.max(1, i.homeAdv.games ?? 1)) + (i.awayAdv.off.plays / Math.max(1, i.awayAdv.games ?? 1))) / 2;
    modelHomePts = expectedPoints(i.homeAdv, i.awayAdv, i.means, pace);
    modelAwayPts = expectedPoints(i.awayAdv, i.homeAdv, i.means, pace);
    modelTotal = Math.round((modelHomePts + modelAwayPts) * 2) / 2;
    basis.push(`Efficiency and pace: ${i.home.abbr} ${modelHomePts.toFixed(1)} + ${i.away.abbr} ${modelAwayPts.toFixed(1)} at ${pace.toFixed(0)} plays each → model total ${modelTotal}`);
    if (availability && availability.total !== 0) {
      modelTotal = Math.round((modelTotal + availability.total) * 2) / 2;
      basis.push(`Who is playing moves the total ${availability.total > 0 ? "up" : "down"} ${Math.abs(availability.total).toFixed(1)} → ${modelTotal}`);
    }
  }

  // Weather tilt: only a flagged forecast moves the total, and only toward the under.
  let weatherTilt: string | undefined;
  let weatherAdj = 0;
  if (i.weather) {
    const flags = evaluateWeather(i.weather);
    const wind = flags.find((f) => f.key === "wind");
    const rain = flags.find((f) => f.key === "rain");
    if (wind?.level === "elevated") { weatherAdj -= 3; weatherTilt = `${wind.title}: deep passing and field goals get harder. Tilts under by about 3.`; }
    else if (wind) { weatherAdj -= 1.5; weatherTilt = `${wind.title}: long kicks and deep shots lose some value. Tilts under by about 1.5.`; }
    if (rain?.level === "elevated") { weatherAdj -= 2; weatherTilt = `${weatherTilt ? weatherTilt + " " : ""}${rain.title}: ball security and footing. Tilts under by about 2.`; }
    else if (rain) { weatherAdj -= 1; weatherTilt = `${weatherTilt ? weatherTilt + " " : ""}${rain.title}: tilts under by about 1.`; }
  }
  if (modelTotal !== undefined && weatherAdj) modelTotal = Math.round((modelTotal + weatherAdj) * 2) / 2;

  const total = i.market.total?.line ?? modelTotal ?? 44;
  if (!i.market.total && modelTotal === undefined) basis.push("No market total and no tendency data; 44 assumed for the score line.");

  let totalLean: Projection["totalLean"];
  let totalGap: number | undefined;
  let totalNote: string | undefined;
  if (modelTotal !== undefined && i.market.total) {
    totalGap = Math.round((modelTotal - i.market.total.line) * 10) / 10;
    totalLean = totalGap >= 2.5 ? "over" : totalGap <= -2.5 ? "under" : "none";
    totalNote =
      totalLean === "none"
        ? `Model total ${modelTotal} against a posted ${i.market.total.line}. No lean.`
        : `Model total ${modelTotal} against a posted ${i.market.total.line}. The model leans ${totalLean} by ${Math.abs(totalGap)}.`;
  }
  const homePts = Math.max(0, Math.round((total + margin) / 2));
  const awayPts = Math.max(0, Math.round(total - homePts));
  const homeWins = margin >= 0;
  const winner = homeWins ? i.home.abbr : i.away.abbr;
  const winProb = probFromMargin(Math.abs(margin));

  // Shape of the game from pass rates and the line-of-scrimmage edges.
  const hp = i.homePassRate ?? 0.5;
  const ap = i.awayPassRate ?? 0.5;
  const lineEdges = i.matchups.filter((m) => /offensive line|run game|ground game/i.test(m.a) && m.edge !== "even");
  let shape: string;
  if (hp <= 0.45 && ap <= 0.45) shape = "Two run-first offenses: fewer possessions, a lower-variance game where the first turnover matters more than usual.";
  else if (hp >= 0.56 && ap >= 0.56) shape = "Two pass-first offenses: more possessions, more variance, and the total has room on the high side if either secondary breaks.";
  else if (lineEdges.length >= 2 && lineEdges.every((m) => m.a.startsWith(winner === i.home.abbr ? i.homeSchool : i.awaySchool) ? m.edge === "offense" : m.edge === "defense"))
    shape = `${winner} control the ground game on both sides. Expect them to shorten the game once ahead.`;
  else shape = "Balanced styles. The unit edges above decide it more than tempo does.";

  // Where the model disagrees with the number.
  let vsMarket: string | undefined;
  let modelSide: string | undefined;
  let sideGap: number | undefined;
  if (marketMargin !== undefined) {
    const diff = margin - marketMargin; // positive = model likes home more than the market does
    modelSide = diff >= 0 ? i.home.abbr : i.away.abbr;
    sideGap = Math.round(Math.abs(diff) * 10) / 10;
    const favAbbr = marketMargin >= 0 ? i.home.abbr : i.away.abbr;
    const modelFavMargin = marketMargin >= 0 ? margin : -margin;
    const mktFavMargin = Math.abs(marketMargin);
    const gap = Math.abs(diff);
    vsMarket =
      gap < 2
        ? `Model and market agree: ${favAbbr} by about ${mktFavMargin.toFixed(1)}.`
        : modelFavMargin > mktFavMargin
          ? `Model has ${favAbbr} by ${modelFavMargin.toFixed(1)}; the market has ${mktFavMargin.toFixed(1)}. The model leans ${favAbbr} against the number by ${gap.toFixed(1)}.`
          : modelFavMargin >= 0
            ? `Model has ${favAbbr} by only ${modelFavMargin.toFixed(1)}; the market has ${mktFavMargin.toFixed(1)}. The model leans ${modelSide} against the number by ${gap.toFixed(1)}.`
            : `Model has ${modelSide} winning outright; the market has ${favAbbr} by ${mktFavMargin.toFixed(1)}. The model leans ${modelSide} against the number by ${gap.toFixed(1)}.`;
  }

  return { winner, winProb, margin: Math.abs(margin), total, home: homePts, away: awayPts, shape, vsMarket, modelSide, sideGap, modelTotal, totalLean, totalGap, totalNote, weatherTilt, availability, basis, confidence };
}
