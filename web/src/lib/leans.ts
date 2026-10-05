/**
 * One lean vocabulary for the game page, the sheet, Telegram, and the ledger. A gap is how far the model
 * sits from the posted number, in points. The backtests have not found a gap size that beats the closing
 * line, so the labels say "gap" and "big gap", never "strong".
 */

/** Internal tier keys; on screen they read "big gap" and "gap". */
export type LeanTier = "strong" | "moderate";

/** Points. Under the lower bound is no lean (projection.ts says "agree" under 2 on the side, "no lean" under 2.5 on the total). */
export const LEAN_THRESHOLDS = { side: { strong: 4, moderate: 2 }, total: { strong: 5, moderate: 2.5 } };

export const sideTier = (gap: number): LeanTier | undefined => (gap >= LEAN_THRESHOLDS.side.strong ? "strong" : gap >= LEAN_THRESHOLDS.side.moderate ? "moderate" : undefined);
export const totalTier = (gap: number): LeanTier | undefined => {
  const a = Math.abs(gap);
  return a >= LEAN_THRESHOLDS.total.strong ? "strong" : a >= LEAN_THRESHOLDS.total.moderate ? "moderate" : undefined;
};
export const tierLabel = (t: LeanTier | undefined): string => (t === "strong" ? "big gap" : t === "moderate" ? "gap" : "no lean");

/**
 * What the leans have earned so far, from scripts/backtest-qb.mjs and backtest-total.mjs (data/backtest/).
 * Said next to every lean so a gap reads as a disagreement with the market, not a pick. Update after re-running.
 */
export const LEAN_BACKTEST_NOTE =
  "Backtest 2022 to 2025: the model side (Elo plus the QB adjustment, 1,139 games) covered about 48% against the closing line, and the model total (959 games) hit 48% on the over/under; no gap size beat the 52.4% break-even. Read these as disagreements with the market, not picks.";

/** What the projection's confidence field measures: whether the inputs exist, not how likely the call is. */
export const inputsLabel = (c: "high" | "medium" | "low" | string): string => (c === "high" ? "inputs complete" : c === "medium" ? "Elo only, no tendency data" : "thin inputs");
