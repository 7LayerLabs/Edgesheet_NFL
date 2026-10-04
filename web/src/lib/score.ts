import type { Game, ScoreComponents } from "./types";

/**
 * Watch Score weights. Each component is 0 to 100.
 *   competitive     closeness from the posted spread (a pick-em is 100, a 14-point spread about 40), Elo gap when no line
 *   directMatchups  how many of the four unit axes carry a real edge (a mismatch is worth watching, so is strength on strength)
 *   watchDensity    rookies, breakouts, and matchup players on the two rosters, weighted by their radar score
 *   stakes          division game, standings position, and how late in the season it is (from the nflverse schedule and results)
 *   availability    national window (NBC, ESPN, Prime, Netflix, NFL Network) versus a regional CBS/FOX window; finals score low
 * Draft talent and future talent from the college product are gone: everyone here is already in the league.
 */
export const WEIGHTS: Record<keyof ScoreComponents, number> = {
  competitive: 0.3,
  directMatchups: 0.25,
  watchDensity: 0.15,
  stakes: 0.2,
  availability: 0.1,
};

export const COMPONENT_LABELS: Record<keyof ScoreComponents, string> = {
  competitive: "Competitive expectation",
  directMatchups: "Unit mismatches",
  watchDensity: "Rookie and breakout density",
  stakes: "Stakes",
  availability: "Availability",
};

export const COMPONENT_KEYS = Object.keys(WEIGHTS) as (keyof ScoreComponents)[];

/**
 * Each component is scored 0 to 100, then weighted. A null component means the
 * input does not exist yet (no play-by-play, no roster digest). Those are excluded
 * and the remaining weights are renormalized so a game is not punished for data
 * the product has not ingested. The breakdown shows which were excluded.
 */
export function scoutScore(c: ScoreComponents): number {
  let sum = 0;
  let weight = 0;
  for (const k of COMPONENT_KEYS) {
    const v = c[k];
    if (v === null || v === undefined) continue;
    sum += v * WEIGHTS[k];
    weight += WEIGHTS[k];
  }
  if (weight === 0) return 0;
  return Math.round(sum / weight);
}

export function availableWeight(c: ScoreComponents): number {
  return COMPONENT_KEYS.reduce((w, k) => (c[k] === null || c[k] === undefined ? w : w + WEIGHTS[k]), 0);
}

export type ScoreTag = "Marquee" | "Hidden Gem" | "Rookie Heavy" | "Solid" | "Thin";

const NATIONAL = /^(NBC|ESPN|ABC|ESPN\/ABC|Prime Video|Amazon|Netflix|NFL Network|Peacock|YouTube|YouTube TV|ESPN2)$/i;

export function scoreTag(g: Game): ScoreTag {
  const s = scoutScore(g.scoreComponents);
  const marquee = NATIONAL.test(g.network.trim());
  if (s >= 75 && !marquee) return "Hidden Gem";
  if (s >= 80) return "Marquee";
  if ((g.scoreComponents.watchDensity ?? 0) >= 70) return "Rookie Heavy";
  if (s >= 55) return "Solid";
  return "Thin";
}

/** likely = rookies, breakouts, and matchup players; future = watch names. Field names kept for the shared cards. */
export function prospectCounts(g: Game) {
  const likely = g.prospects.filter((p) => p.tier === "Rookie" || p.tier === "Breakout" || p.tier === "Matchup").length;
  const future = g.prospects.filter((p) => p.tier === "Watch").length;
  return { likely, future };
}
