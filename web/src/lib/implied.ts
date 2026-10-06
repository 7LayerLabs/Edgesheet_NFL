/**
 * Implied team totals from a posted line. Client-safe (no server imports), for the slate cards and the DraftKings
 * defense projections alike. `home` is the home team's ABBREVIATION: the market's spread is filed under the favorite's
 * abbreviation (src/lib/slate.ts mkMarket), favorite negative.
 */
export function impliedTotals(home: string, spread: { team: string; line: number } | undefined, total: number | undefined): { home: number; away: number } | undefined {
  if (!spread || total === undefined) return undefined;
  const homeMargin = spread.team === home ? -spread.line : spread.line; // home points minus away points
  return { home: (total + homeMargin) / 2, away: (total - homeMargin) / 2 };
}
