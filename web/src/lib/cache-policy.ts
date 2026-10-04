/**
 * Cache lifetimes that depend on what is on the field.
 *
 * In-process memo (src/lib/memo.ts): the built slate is memoized per date. On
 * a game day the scores and the ESPN overlay move every play, so 60 seconds is
 * the ceiling. When nothing is live and nothing kicks off inside two hours, the
 * slate only changes when lines move, so it can sit for 120 seconds.
 *
 * Future CDN (Cache-Control: s-maxage). The site runs behind PM2 with no CDN
 * today. If it ever sits behind one (Cloudflare, nginx proxy_cache, Vercel
 * Edge), the same rule maps onto headers set in middleware or next.config
 * headers():
 *
 *   quiet day     Cache-Control: public, s-maxage=120, stale-while-revalidate=600
 *   game window   Cache-Control: public, s-maxage=20,  stale-while-revalidate=60
 *   /game/[id]    same two tiers, decided by that one game's status
 *   /history      s-maxage=300 (changes only when a game is graded)
 *   /api/*        no-store (written for scripts and buttons)
 *
 * Do not add those headers until a CDN exists. `next start` passes them
 * through to the browser, which would then cache HTML that includes
 * per-visitor state (follows, watchlist). Keep the rule here so both layers
 * agree when the day comes.
 */

/** How long before kickoff a game counts as "about to start" for cache purposes. */
export const KICKOFF_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SLATE_TTL_GAME_WINDOW = 60;
export const SLATE_TTL_QUIET = 120;

export interface CacheGame {
  status: "upcoming" | "live" | "final";
  kickoff: string;
}

/** True when any game is live or kicks off within two hours (or started in the last 15 minutes without a status update). */
export function inGameWindow(games: CacheGame[], now = Date.now()): boolean {
  for (const g of games) {
    if (g.status === "live") return true;
    const t = Date.parse(g.kickoff);
    if (Number.isFinite(t) && t >= now - 15 * 60 * 1000 && t - now <= KICKOFF_WINDOW_MS) return true;
  }
  return false;
}

/** Memo TTL for a built slate: 60s while games are on or near, 120s otherwise. */
export function slateTtlSeconds(games: CacheGame[], now = Date.now()): number {
  return inGameWindow(games, now) ? SLATE_TTL_GAME_WINDOW : SLATE_TTL_QUIET;
}
