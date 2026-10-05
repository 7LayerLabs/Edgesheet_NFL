import type { Game } from "./types";

/**
 * A game trimmed to what a slate or watchlist card reads, for passing to client components. The full record
 * carries the radar, situational splits, availability, and team profiles (about 80 KB a game); a card needs
 * about 2 KB, and the slate re-sends it on every live refresh.
 */
export function cardGame(g: Game): Game {
  return {
    ...g,
    prospects: g.prospects.map((p) => ({ ...p, radar: undefined, traits: [], watchFor: "", weakness: undefined, lines: undefined, lensNote: undefined })),
    whyWatchReasons: [],
    matchups: [],
    keepAnEyeOn: [],
    storylines: [],
    offense: {},
    defense: {},
    pressurePoint: "",
    gaps: undefined,
    box: undefined,
    liveDetail: undefined,
    projection: g.projection ? { ...g.projection, basis: [], availability: undefined } : undefined,
    consensus: undefined,
    archive: undefined,
    situations: undefined,
    climate: undefined,
    odds: undefined,
    injuryReport: undefined,
    availability: undefined,
  };
}
