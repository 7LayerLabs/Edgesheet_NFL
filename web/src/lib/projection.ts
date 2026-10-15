/**
 * Game projection. The model's own margin is pregame Elo plus the quarterback adjustment; its own total is efficiency
 * and pace. Both were replayed against the closing line (audit 2026-10-12, scripts/backtest-replay.mjs, 2022-25) and
 * neither beat it, so the projection shown is the market's number plus the share of the model's disagreement that has
 * held up (none so far), and no lean is flagged. The model's own numbers ride along as context (`raw`) and feed the
 * frozen forward test on the Record page. It is a model, not a pick, and the page says so.
 */
import type { Market, Matchup, Team, WeatherInput } from "./types";
import type { GenTeam } from "./generated";
import { evaluateWeather } from "./weather";
import type { TeamAvailability } from "./availability";
import type { Pregame } from "./archive";
import { coverChance } from "./cover";

export interface Projection {
  winner: string; // abbr
  winProb: number; // 0..1 for the winner
  margin: number; // points, positive for winner
  total: number; // the score line's total: the model total, else the posted total
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
  /** Who is playing, per team in points (home minus away in net), with one line per team. Only qbNet moves the margin. */
  availability?: { home: number; away: number; net: number; qbNet: number; total: number; lines: string[] };
  /** The model's own numbers before the market: home margin (positive = home) and total. */
  raw?: { margin: number; total?: number };
  /** Each side's chance to cover the posted spread, and of a push (src/lib/cover.ts). */
  cover?: { home: number; away: number; push: number };
  basis: string[];
  confidence: "high" | "medium" | "low";
}

const HOME_ELO = 48; // NFL home-field edge in Elo points (scripts/lib/elo.mjs)
const ELO_PER_POINT = 25; // Elo difference per point of spread, NFL scale
/** Root mean squared miss of the final margin around the model, 2022-25 out of sample (scripts/backtest-replay.mjs). */
export const SIGMA = 12.8;

/**
 * How much of the model's disagreement with the market the projection keeps (audit item 3.1, scripts/backtest-replay.mjs,
 * 2026-10-14). Fit as final minus line = b x (model minus line) on 2019-25: sides b -0.05 (90% range -0.21 to 0.11),
 * totals b -0.03 (-0.17 to 0.10). A gap counts only when b's 90% range is above 0. Both ranges include 0, so the model has
 * not beaten the closing line: the projection keeps none of the gap and flags no lean. Update after re-running.
 */
export const MARKET_WEIGHT = { side: { b: -0.049, lo90: -0.207, hi90: 0.11 }, total: { b: -0.033, lo90: -0.17, hi90: 0.104 } };
const keptShare = (w: { b: number; lo90: number }) => (w.lo90 > 0 ? Math.min(1, w.b) : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

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

// Fit by scripts/backtest-total.mjs (2026-10-14) out of sample: each season 2022-25 graded with constants fit only on the
// seasons before it missed the final total by 10.67 a game, against 10.16 for the closing total; over/unders hit about
// 49%. These are the fit on 2019-25. The total is a read, not an edge.
const AVG_PPG = 22.6;
const TOTAL_SHRINK = 0.35;
/** Games each team needs before the model makes a total: weeks 2 and 3 missed by 0.57 more than later weeks in testing. */
const TOTAL_MIN_GAMES = 3;

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

  // Unit edges: shown on the page, not in the margin. Replayed walk-forward on 2022-25 (scripts/backtest-replay.mjs), adding
  // them to Elo made the margin miss worse (by 0.03 at the live weight), so they came out on 2026-10-14.
  if (i.matchups.length) {
    const gapOf = (m: Matchup) => {
      const g = Number((m.evidence.match(/gap (\d+) percentile/) ?? [])[1] ?? 0);
      return m.edge === "offense" ? g : m.edge === "defense" ? -g : 0;
    };
    let net = 0;
    for (const m of i.matchups) net += m.a.startsWith(i.homeSchool) ? gapOf(m) : -gapOf(m);
    basis.push(`Unit edges: net ${net >= 0 ? "+" : ""}${net} percentile points to ${net >= 0 ? i.home.abbr : i.away.abbr} across ${i.matchups.length} matchups. Not in the margin: in testing (2022-25) they made it worse.`);
  }

  const marketMargin = i.market.spread ? (i.market.spread.team === i.home.abbr ? -i.market.spread.line : i.market.spread.line) : undefined; // positive = home favored
  if (marketMargin !== undefined) basis.push(`Market: ${i.market.spread!.team} ${i.market.spread!.line}${i.market.total ? `, total ${i.market.total.line}` : ""}`);

  // The model's own margin, home positive: Elo, then the quarterbacks.
  let raw: number;
  let confidence: Projection["confidence"];
  if (eloMargin !== undefined) {
    raw = eloMargin;
    confidence = "high";
  } else if (marketMargin !== undefined) {
    raw = marketMargin;
    confidence = "low";
    basis.push("No rating for one side; the model follows the market.");
  } else {
    return undefined;
  }

  // Who is playing. The ratings were built by the players who took this season's snaps; this prices today's lineup. Only the
  // quarterback moves the margin: the replay found the rest (other starters out, trades, arrivals) lowered the miss by 0.02
  // points against a 0.05 bar, so it is shown and left out.
  let availability: Projection["availability"];
  if (i.homeAvail && i.awayAvail) {
    const h = i.homeAvail;
    const a = i.awayAvail;
    const net = round1(h.total - a.total);
    const qbNet = round1((h.qb?.pts ?? 0) - (a.qb?.pts ?? 0));
    // Home scores its offense change minus the away defense change, and the reverse, so the total moves by both.
    // offenseTotal measures the QB against this season's QBs: the EPA total already carries them, the Elo does not.
    const totalAdj = round1((h.offenseTotal ?? h.offense) + (a.offenseTotal ?? a.offense) - h.defense - a.defense);
    const lineFor = (t: TeamAvailability, abbr: string) => {
      const bits = [
        t.qb && Math.abs(t.qb.pts) >= 0.5 ? `QB ${t.qb.expected} ${t.qb.pts > 0 ? "+" : ""}${t.qb.pts}` : "",
        ...t.items.filter((x) => x.kind !== "qb" && x.pts !== 0).slice(0, 3).map((x) => `${x.name} ${x.pts > 0 ? "+" : ""}${x.pts}`),
      ].filter(Boolean);
      return `${abbr} ${t.total > 0 ? "+" : ""}${t.total}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    };
    availability = { home: h.total, away: a.total, net, qbNet, total: totalAdj, lines: [lineFor(a, i.away.abbr), lineFor(h, i.home.abbr)] };
    if (qbNet !== 0) {
      raw += qbNet;
      const qbBit = (t: TeamAvailability, abbr: string) => (t.qb ? `${abbr} ${t.qb.expected} ${t.qb.pts > 0 ? "+" : ""}${t.qb.pts}` : "");
      basis.push(`Quarterbacks: ${[qbBit(a, i.away.abbr), qbBit(h, i.home.abbr)].filter(Boolean).join("; ")} → ${qbNet >= 0 ? i.home.abbr : i.away.abbr} +${Math.abs(qbNet).toFixed(1)} on the margin`);
    }
    basis.push(`Who is playing: ${availability.lines.join("; ")}. Only the quarterbacks move the margin; in testing the rest did not improve it enough to keep.`);
    if ((h.qb?.uncertain || a.qb?.uncertain) && confidence === "high") confidence = "medium";
  }

  // The model's own total from efficiency and pace, once both teams have enough games.
  let modelTotal: number | undefined;
  if (i.homeAdv && i.awayAdv && i.means && (i.homeAdv.games ?? 0) >= TOTAL_MIN_GAMES && (i.awayAdv.games ?? 0) >= TOTAL_MIN_GAMES) {
    const pace = ((i.homeAdv.off.plays / Math.max(1, i.homeAdv.games ?? 1)) + (i.awayAdv.off.plays / Math.max(1, i.awayAdv.games ?? 1))) / 2;
    const modelHomePts = expectedPoints(i.homeAdv, i.awayAdv, i.means, pace);
    const modelAwayPts = expectedPoints(i.awayAdv, i.homeAdv, i.means, pace);
    modelTotal = Math.round((modelHomePts + modelAwayPts) * 2) / 2;
    basis.push(`Efficiency and pace: ${i.home.abbr} ${modelHomePts.toFixed(1)} + ${i.away.abbr} ${modelAwayPts.toFixed(1)} at ${pace.toFixed(0)} plays each → model total ${modelTotal}`);
    if (availability && availability.total !== 0) {
      modelTotal = Math.round((modelTotal + availability.total) * 2) / 2;
      basis.push(`Who is playing moves the model total ${availability.total > 0 ? "up" : "down"} ${Math.abs(availability.total).toFixed(1)} → ${modelTotal}`);
    }
  } else if (i.homeAdv && i.awayAdv) {
    basis.push(`No model total until both teams have played ${TOTAL_MIN_GAMES} games: in testing, totals in weeks 2 and 3 missed by more.`);
  }

  // Weather is noted, not counted. Forecast wind of 10+ mph went under the closing total 53.6% of the time in 2024-25 (97
  // games) and rain 41% (29 games), short of the bar set before the test (scripts/backtest-wind.mjs), so neither moves the total.
  let weatherTilt: string | undefined;
  if (i.weather) {
    const flags = evaluateWeather(i.weather).filter((f) => f.key === "wind" || f.key === "rain");
    if (flags.length) weatherTilt = `${flags.map((f) => f.title).join(". ")}. Not in the total: forecast wind and rain did not beat the closing total in testing (2024-25).`;
  }

  // The projection: the market's number plus the share of the model's disagreement that has held up against the closing line.
  const sideKeep = keptShare(MARKET_WEIGHT.side);
  const totalKeep = keptShare(MARKET_WEIGHT.total);
  const margin = marketMargin !== undefined ? marketMargin + sideKeep * (raw - marketMargin) : raw;
  const posted = i.market.total?.line;
  const total = posted !== undefined ? (modelTotal !== undefined ? posted + totalKeep * (modelTotal - posted) : posted) : modelTotal ?? 44;
  if (posted === undefined && modelTotal === undefined) basis.push("No market total and no model total; 44 assumed for the score line.");

  // Each side rounded from the same total and margin, so the score line shows the margin it came from.
  const homePts = Math.max(0, Math.round((total + margin) / 2));
  const awayPts = Math.max(0, Math.round((total - margin) / 2));
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

  // Where the model's own number sits against the market. No lean is flagged while the model has not beaten the close.
  let vsMarket: string | undefined;
  let modelSide: string | undefined;
  let sideGap: number | undefined;
  if (marketMargin !== undefined) {
    if (sideKeep > 0) ({ vsMarket, modelSide, sideGap } = sideVsMarket(margin, marketMargin, i.home.abbr, i.away.abbr));
    else {
      vsMarket = rawVsMarket(raw, marketMargin, i.home.abbr, i.away.abbr);
      sideGap = 0;
    }
  }
  let totalLean: Projection["totalLean"];
  let totalGap: number | undefined;
  let totalNote: string | undefined;
  if (modelTotal !== undefined && posted !== undefined) {
    if (totalKeep > 0) ({ totalLean, totalGap, totalNote } = totalVsMarket(Math.round(total * 2) / 2, posted));
    else {
      totalLean = "none";
      totalGap = 0;
      totalNote = rawTotalNote(modelTotal, posted);
    }
  }
  const cover = marketMargin !== undefined ? coverChance(margin, marketMargin) : undefined;

  return { winner, winProb, margin: Math.abs(margin), total, home: homePts, away: awayPts, shape, vsMarket, modelSide, sideGap, modelTotal, totalLean, totalGap, totalNote, weatherTilt, availability, basis, confidence, raw: { margin: round1(raw), total: modelTotal }, cover };
}

/** The model's own margin against the market, while the model has not beaten the closing line. */
export function rawVsMarket(raw: number, marketMargin: number, homeAbbr: string, awayAbbr: string): string {
  const fav = marketMargin >= 0 ? homeAbbr : awayAbbr;
  const rawFav = raw >= 0 ? homeAbbr : awayAbbr;
  const own = Math.abs(raw - marketMargin) < 0.5 ? "The model's own number matches it." : `The model's own number has ${rawFav} by ${Math.abs(raw).toFixed(1)}.`;
  return `Market: ${fav} by ${Math.abs(marketMargin).toFixed(1)}. ${own} The model has not beaten the closing line in testing (2022-25), so the projection is the market's number and no side is flagged.`;
}

/** The model's own total against the posted total, while the model has not beaten the closing total. */
export function rawTotalNote(modelTotal: number, posted: number): string {
  return `The model's own total is ${modelTotal} against a posted ${posted}. It has not beaten the closing total in testing (2022-25), so the projection uses the market's total and no lean is flagged.`;
}

/** A projected home margin against the posted home margin (both positive = home by that many), in words. */
export function sideVsMarket(margin: number, marketMargin: number, homeAbbr: string, awayAbbr: string): { vsMarket: string; modelSide: string; sideGap: number } {
  const diff = margin - marketMargin; // positive = model likes home more than the market does
  const modelSide = diff >= 0 ? homeAbbr : awayAbbr;
  const gap = Math.abs(diff);
  const favAbbr = marketMargin >= 0 ? homeAbbr : awayAbbr;
  const modelFavMargin = marketMargin >= 0 ? margin : -margin;
  const mktFavMargin = Math.abs(marketMargin);
  const vsMarket =
    gap < 2
      ? `Model and market agree: ${favAbbr} by about ${mktFavMargin.toFixed(1)}.`
      : modelFavMargin > mktFavMargin
        ? `Model has ${favAbbr} by ${modelFavMargin.toFixed(1)}; the market has ${mktFavMargin.toFixed(1)}. The model leans ${favAbbr} against the number by ${gap.toFixed(1)}.`
        : modelFavMargin >= 0
          ? `Model has ${favAbbr} by only ${modelFavMargin.toFixed(1)}; the market has ${mktFavMargin.toFixed(1)}. The model leans ${modelSide} against the number by ${gap.toFixed(1)}.`
          : `Model has ${modelSide} winning outright; the market has ${favAbbr} by ${mktFavMargin.toFixed(1)}. The model leans ${modelSide} against the number by ${gap.toFixed(1)}.`;
  return { vsMarket, modelSide, sideGap: Math.round(gap * 10) / 10 };
}

/** The model total against the posted total, in words. */
export function totalVsMarket(modelTotal: number, posted: number): { totalLean: "over" | "under" | "none"; totalGap: number; totalNote: string } {
  const totalGap = Math.round((modelTotal - posted) * 10) / 10;
  const totalLean = totalGap >= 2.5 ? "over" : totalGap <= -2.5 ? "under" : "none";
  const totalNote =
    totalLean === "none"
      ? `Model total ${modelTotal} against a posted ${posted}. No lean.`
      : `Model total ${modelTotal} against a posted ${posted}. The model leans ${totalLean} by ${Math.abs(totalGap)}.`;
  return { totalLean, totalGap, totalNote };
}

/**
 * The pregame call as locked in the archive, in the shape the pages read. Live and final games show this,
 * not a projection rebuilt from today's data, so the call on screen is the call the record grades.
 */
export function lockedProjection(pre: Pregame): Projection | undefined {
  const p = pre.projection;
  if (!p) return undefined;
  const homeMargin = p.winner === pre.abbr.home ? p.margin : -p.margin;
  const marketHome = pre.spread ? (pre.spread.team === pre.abbr.home ? -pre.spread.line : pre.spread.line) : undefined;
  // Locks since 2026-10-14 carry the model's own numbers in `raw` and a projection that is the market's; older locks are
  // the model's own numbers, read the old way.
  const side = marketHome === undefined ? undefined : p.raw ? { vsMarket: rawVsMarket(p.raw.margin, marketHome, pre.abbr.home, pre.abbr.away), sideGap: 0 } : sideVsMarket(homeMargin, marketHome, pre.abbr.home, pre.abbr.away);
  const tot =
    p.modelTotal === undefined || pre.total === undefined ? undefined : p.raw ? { totalGap: 0, totalNote: rawTotalNote(p.modelTotal, pre.total) } : totalVsMarket(p.modelTotal, pre.total);
  const at = new Date(pre.updatedAt ?? pre.capturedAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  const line = pre.spread ? `${pre.spread.team} ${pre.spread.line}` : "no posted spread";
  return {
    winner: p.winner,
    winProb: p.winProb,
    margin: p.margin,
    total: p.raw ? p.home + p.away : p.modelTotal ?? pre.total ?? p.home + p.away,
    home: p.home,
    away: p.away,
    shape: `The pregame call, locked before kickoff. This is the call the record grades.`,
    ...side,
    ...tot,
    modelSide: p.modelSide,
    totalLean: p.totalLean,
    raw: p.raw,
    basis: [`Locked ${at} ET against ${line}${pre.total !== undefined ? `, total ${pre.total}` : ""}.`],
    confidence: (p.confidence as Projection["confidence"]) ?? "medium",
  };
}
