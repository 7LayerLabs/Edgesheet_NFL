/**
 * Consensus of projection systems, shown next to the EdgeSheet model.
 *   FPI        ESPN's Football Power Index (points better than an average team), fetched from ESPN
 *   Elo        our own Elo from results (scripts/lib/elo.mjs: K 20, home 48, one-third regression each season)
 *   EPA model  each offense's EPA per play against the other defense over the game's pace (same math as the model total)
 *   model      the EdgeSheet projection (Elo plus unit edges), passed in and listed as one more system
 * The posted market line is the reference row in the table, not a system.
 * Server-only: FPI is one cached fetch per six hours; everything else reads the digests.
 */
import { fpiRatings } from "./nfl";
import type { GenTeam } from "./generated";
import type { Market, Team } from "./types";
import type { Projection } from "./projection";

const HOME_PTS = 2; // home field in points for rating-difference systems (NFL)
const HOME_ELO = 48; // same as scripts/lib/elo.mjs and projection.ts
const ELO_PER_POINT = 25;
const SIGMA = 13.5; // standard deviation of NFL margins
const ON_NUMBER = 0.5; // a projection inside half a point of the line sits on the number
const AVG_PPG = 22.8;

export type SystemKey = "fpi" | "elo" | "epa" | "model";

export interface SystemLine {
  key: SystemKey;
  system: string; // display name
  source: string; // where the number comes from
  ours: boolean; // the EdgeSheet model row
  available: boolean;
  margin?: number; // projected home margin, positive = home favored
  winProb?: number; // 0..1 for the favorite
  favorite?: string; // abbr
  note?: string; // why unavailable, or the inputs used
}

export interface Consensus {
  systems: SystemLine[];
  available: number; // systems with a margin
  median?: number; // median home margin across available systems
  favorite?: string; // abbr the median favors
  winProb?: number; // for the median favorite
  marketMargin?: number; // home margin implied by the posted spread
  /** Against the number: which side most systems lean to, and how many. */
  side?: string; // abbr
  sideCount?: number;
  onNumber?: number;
  modelAgrees?: boolean;
  summary: string;
  asOf: string;
}

/* ------------------------------------------------------------ math */

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const winProbFromMargin = (m: number) => 0.5 * (1 + erf(Math.abs(m) / (SIGMA * Math.SQRT2)));

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------ build */

export interface ConsensusInput {
  gameId: string;
  season: number;
  week: number;
  seasonType?: string;
  home: Team;
  away: Team;
  homeSchool: string; // nickname
  awaySchool: string;
  neutral: boolean;
  homeElo?: number | null;
  awayElo?: number | null;
  market: Market;
  projection?: Projection;
  /** Team tendencies for the EPA model row. */
  homeAdv?: GenTeam;
  awayAdv?: GenTeam;
  means?: { offPpa: number; defPpa: number; plays: number };
}

/** Market margin, home positive, from the posted spread. */
export function marketHomeMargin(market: Market, homeAbbr: string): number | undefined {
  if (!market.spread) return undefined;
  return market.spread.team === homeAbbr ? -market.spread.line : market.spread.line;
}

function expectedPoints(off: GenTeam, def: GenTeam, means: { offPpa: number; defPpa: number }, plays: number): number {
  const dev = (off.off.ppa - means.offPpa + (def.def.ppa - means.defPpa)) / 2;
  return Math.max(3, AVG_PPG + plays * dev);
}

export async function buildConsensus(i: ConsensusInput): Promise<Consensus> {
  const fpi = await fpiRatings(i.season);
  const hf = i.neutral ? 0 : HOME_PTS;
  const favOf = (m: number) => (m >= 0 ? i.home.abbr : i.away.abbr);
  const line = (key: SystemKey, system: string, source: string, ours: boolean, margin: number | undefined, winProb: number | undefined, note: string | undefined, unavailable?: string): SystemLine =>
    margin === undefined || !Number.isFinite(margin)
      ? { key, system, source, ours, available: false, note: unavailable ?? note }
      : { key, system, source, ours, available: true, margin: r1(margin), winProb: winProb ?? winProbFromMargin(margin), favorite: favOf(margin), note };

  const systems: SystemLine[] = [];

  // FPI: points better than an average team, so the difference is the margin on a neutral field.
  {
    const h = fpi?.get(i.homeSchool);
    const a = fpi?.get(i.awaySchool);
    if (!fpi) systems.push(line("fpi", "FPI", "ESPN Football Power Index", false, undefined, undefined, undefined, "ESPN FPI did not answer right now."));
    else if (!h || !a) systems.push(line("fpi", "FPI", "ESPN Football Power Index", false, undefined, undefined, undefined, `No FPI rating for ${!h ? i.home.abbr : i.away.abbr}.`));
    else systems.push(line("fpi", "FPI", "ESPN Football Power Index", false, h.fpi - a.fpi + hf, undefined, `${i.home.abbr} ${r1(h.fpi)} (No. ${h.rank}), ${i.away.abbr} ${r1(a.fpi)} (No. ${a.rank})${hf ? `, +${hf} home` : ", neutral"}`));
  }

  // Elo: our ratings before this game.
  {
    const h = i.homeElo;
    const a = i.awayElo;
    if (h != null && a != null) {
      const m = (h + (i.neutral ? 0 : HOME_ELO) - a) / ELO_PER_POINT;
      systems.push(line("elo", "Elo", "EdgeSheet Elo from results", false, m, undefined, `${i.home.abbr} ${h}, ${i.away.abbr} ${a}${i.neutral ? ", neutral" : `, +${HOME_ELO} home`}`));
    } else systems.push(line("elo", "Elo", "EdgeSheet Elo from results", false, undefined, undefined, undefined, "No Elo rating for one side (run npm run ingest)."));
  }

  // EPA model: efficiency and pace, no Elo.
  {
    if (i.homeAdv && i.awayAdv && i.means && i.homeAdv.games && i.awayAdv.games) {
      const pace = (i.homeAdv.off.plays / Math.max(1, i.homeAdv.games) + i.awayAdv.off.plays / Math.max(1, i.awayAdv.games)) / 2;
      const hp = expectedPoints(i.homeAdv, i.awayAdv, i.means, pace);
      const ap = expectedPoints(i.awayAdv, i.homeAdv, i.means, pace);
      systems.push(line("epa", "EPA model", "EPA per play from play-by-play, this site", false, hp - ap + hf, undefined, `${i.home.abbr} ${hp.toFixed(1)}, ${i.away.abbr} ${ap.toFixed(1)} at ${pace.toFixed(0)} plays${hf ? `, +${hf} home` : ""}`));
    } else systems.push(line("epa", "EPA model", "EPA per play from play-by-play, this site", false, undefined, undefined, undefined, "Needs play-by-play for both teams."));
  }

  // Our model, home positive.
  if (i.projection) {
    const m = i.projection.winner === i.home.abbr ? i.projection.margin : -i.projection.margin;
    systems.push(line("model", "EdgeSheet model", "Elo and unit edges, this site", true, m, i.projection.winProb, `confidence ${i.projection.confidence}`));
  } else systems.push(line("model", "EdgeSheet model", "Elo and unit edges, this site", true, undefined, undefined, undefined, "No projection for this game."));

  const avail = systems.filter((s) => s.available);
  const med = median(avail.map((s) => s.margin!));
  const marketMargin = marketHomeMargin(i.market, i.home.abbr);

  let side: string | undefined;
  let sideCount: number | undefined;
  let onNumber: number | undefined;
  let modelAgrees: boolean | undefined;
  if (marketMargin !== undefined && avail.length) {
    const homeLean = avail.filter((s) => s.margin! - marketMargin >= ON_NUMBER);
    const awayLean = avail.filter((s) => s.margin! - marketMargin <= -ON_NUMBER);
    onNumber = avail.length - homeLean.length - awayLean.length;
    if (homeLean.length || awayLean.length) {
      const majority = homeLean.length >= awayLean.length ? homeLean : awayLean;
      side = majority === homeLean ? i.home.abbr : i.away.abbr;
      sideCount = majority.length;
      const ours = avail.find((s) => s.ours);
      if (ours) modelAgrees = majority.includes(ours) ? true : homeLean.includes(ours) || awayLean.includes(ours) ? false : undefined;
    }
  }

  const teamOf = (abbr: string) => (abbr === i.home.abbr ? i.home.short : i.away.short);
  let summary: string;
  if (!avail.length) summary = "No projection system has a number for this game.";
  else if (marketMargin !== undefined && side && sideCount !== undefined) {
    const tail = modelAgrees === true ? " The EdgeSheet model is one of them." : modelAgrees === false ? " The EdgeSheet model is on the other side." : avail.some((s) => s.ours) ? " The EdgeSheet model sits on the number." : "";
    const even = onNumber ? `, ${onNumber} sit${onNumber === 1 ? "s" : ""} on the number` : "";
    summary = sideCount === avail.length
      ? `All ${avail.length} systems lean ${teamOf(side)} against the number.${tail}`
      : `${sideCount} of ${avail.length} systems lean ${teamOf(side)} against the number${even}.${tail}`;
  } else if (marketMargin !== undefined && onNumber === avail.length) {
    summary = `Every available system sits on the posted number.`;
  } else {
    const fav = med !== undefined ? favOf(med) : undefined;
    const n = fav ? avail.filter((s) => s.favorite === fav).length : 0;
    summary = fav ? `No posted spread. ${n} of ${avail.length} systems have ${teamOf(fav)} winning; median margin ${Math.abs(med!).toFixed(1)}.` : "No posted spread.";
  }

  return {
    systems,
    available: avail.length,
    median: med !== undefined ? r1(med) : undefined,
    favorite: med !== undefined ? favOf(med) : undefined,
    winProb: med !== undefined ? winProbFromMargin(med) : undefined,
    marketMargin,
    side,
    sideCount,
    onNumber,
    modelAgrees,
    summary,
    asOf: new Date().toISOString(),
  };
}
