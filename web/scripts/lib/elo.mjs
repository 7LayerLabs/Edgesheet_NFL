/**
 * Elo ratings from results, computed by us (nflverse has no power ratings).
 *
 *   Start: every team at 1500 the first season we see. Each later season starts at
 *          1500 + (2/3) * (last rating - 1500): one third regression to the mean.
 *   K = 20. Home field = 48 Elo points added to the home side before the expectation.
 *   Margin multiplier (the FiveThirtyEight form): ln(|margin| + 1) * 2.2 / (0.001 * eloDiffOfWinner + 2.2),
 *          so blowouts move ratings more and a favorite winning big moves them less.
 *   Expected home win probability: 1 / (1 + 10^((away - home - 48) / 400)). Ties count as half a win.
 *   Postseason games count the same as regular season games.
 *
 * Points: 25 Elo points per point of spread (the NFL scale), used by projection.ts and consensus.ts.
 * Everything is walk-forward: a game's pregame ratings never see that game's result.
 */
export const ELO_START = 1500;
export const ELO_K = 20;
export const ELO_HOME = 48;
export const ELO_REGRESS = 1 / 3;
export const ELO_PER_POINT = 25;

export const eloWinProb = (home, away, neutral = false) => 1 / (1 + Math.pow(10, (away - home - (neutral ? 0 : ELO_HOME)) / 400));

/**
 * @param games rows sorted by kickoff with { id, season, home, away, hs, as, neutral, played }
 * @returns { pregame: Map<id, {home, away}>, teams: Map<team, rating>, seasonEnd: Map<season, Map<team, rating>> }
 */
export function computeElo(games) {
  const ratings = new Map();
  const pregame = new Map();
  const seasonEnd = new Map();
  let season = null;
  const sorted = [...games].sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  for (const g of sorted) {
    if (g.season !== season) {
      if (season !== null) {
        seasonEnd.set(season, new Map(ratings));
        for (const [t, r] of ratings) ratings.set(t, ELO_START + (1 - ELO_REGRESS) * (r - ELO_START));
      }
      season = g.season;
    }
    const h = ratings.get(g.home) ?? ELO_START;
    const a = ratings.get(g.away) ?? ELO_START;
    pregame.set(g.id, { home: Math.round(h), away: Math.round(a) });
    if (!g.played || g.hs == null || g.as == null) continue;
    const exp = eloWinProb(h, a, g.neutral);
    const actual = g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
    const margin = Math.abs(g.hs - g.as);
    const winnerDiff = g.hs > g.as ? h + (g.neutral ? 0 : ELO_HOME) - a : g.hs < g.as ? a - h - (g.neutral ? 0 : ELO_HOME) : 0;
    const mult = Math.log(margin + 1) * (2.2 / (0.001 * winnerDiff + 2.2));
    const delta = ELO_K * mult * (actual - exp);
    ratings.set(g.home, h + delta);
    ratings.set(g.away, a - delta);
  }
  if (season !== null) seasonEnd.set(season, new Map(ratings));
  return { pregame, teams: ratings, seasonEnd };
}
