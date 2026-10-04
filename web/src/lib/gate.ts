/**
 * Honest gating for small samples. A rate built on four games is noise, and
 * showing "75%" next to it invites the reader to believe it. `gated` returns
 * either the formatted value or a marker that the UI renders as "too early".
 *
 *   gated(stats.winnerGraded, RATE_MIN, pct(stats.winnerRight, stats.winnerGraded))
 *
 * Minimums used across the app (kept in one place so they stay honest):
 *   RATE_MIN        20 graded games before a hit rate is shown as a percentage
 *   BUCKET_MIN      10 graded games before the Watch Score bucket chart shows
 *   LEDGER_MIN      10 staked leans before simulated units or ROI are shown
 *   GAME_RATIO_MIN   3 graded calls before a per-game ratio means anything
 */
export const RATE_MIN = 20;
export const BUCKET_MIN = 10;
export const LEDGER_MIN = 10;
export const GAME_RATIO_MIN = 3;

export interface TooEarly {
  tooEarly: true;
  /** Sample size seen so far. */
  n: number;
  /** Sample size needed before the value is shown. */
  min: number;
}

export type GatedValue = string | TooEarly;

/** True when `v` is the too-early marker rather than a formatted value. */
export function isTooEarly(v: GatedValue): v is TooEarly {
  return typeof v === "object" && v !== null && v.tooEarly === true;
}

/** Return `value` when the sample is at least `min`, else the too-early marker. */
export function gated(n: number, min: number, value: string): GatedValue {
  return n >= min ? value : { tooEarly: true, n, min };
}

/** Plain-text form for places that cannot render React (Telegram, logs). */
export function gatedText(v: GatedValue): string {
  return isTooEarly(v) ? `too early (${v.n} of ${v.min})` : v;
}
