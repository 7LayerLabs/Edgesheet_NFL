/**
 * Flat-bet ledger over the accountability archive. A simulation, not advice:
 * one unit on every strong model lean at standard -110, graded by the archive's
 * own modelSideCovered / totalLeanRight. Closing-line value comes from the
 * Odds API snapshots (postgame.clv when the grade recorded it, else computed
 * here from the odds file so older grades still show it).
 */
import type { ArchiveEntry } from "./archive";
import { clvFrom, closingLine, type ClvRecord } from "./odds";
import { sideTier, totalTier, type LeanTier } from "./leans";

/** The shared lean tiers (leans.ts): "strong" is a big gap and is staked; "moderate" is a gap, tracked but not staked. */
export type Strength = LeanTier;
export type BetResult = "win" | "loss" | "push" | "ungraded";

const WIN = 100 / 110; // units returned on a -110 winner

export interface SideLeg {
  team: string;
  strength: Strength;
  gap: number;
  lockLine: { team: string; line: number };
  closing?: { team: string; line: number };
  clv?: number;
  result: BetResult;
  units: number;
}

export interface TotalLeg {
  lean: "over" | "under";
  strength: Strength;
  gap: number;
  lockTotal: number;
  closingTotal?: number;
  clv?: number;
  result: BetResult;
  units: number;
}

export interface LedgerRow {
  gameId: string;
  season: number;
  kickoff: string;
  label: string;
  score?: string;
  side?: SideLeg;
  total?: TotalLeg;
  closingAt?: string;
  /** Running units after this row, strong leans only (sides and totals). */
  runStrong: number;
  /** Running units after this row, strong and moderate leans. */
  runAll: number;
}

export interface LedgerStats {
  rows: number;
  bets: number;
  units: number;
  roi: number | null;
  wins: number;
  losses: number;
  pushes: number;
  betsAll: number;
  unitsAll: number;
  roiAll: number | null;
  clvCount: number;
  clvAvg: number | null;
  sideClvAvg: number | null;
  totalClvAvg: number | null;
  clvPositive: number;
}

const sideStrength = sideTier;
const totalStrength = totalTier;

function unitsFor(result: BetResult): number {
  return result === "win" ? WIN : result === "loss" ? -1 : 0;
}

/** The model's gap to the market, rebuilt from what the lock stored. */
export function gapsFor(e: ArchiveEntry): { sideGap?: number; totalGap?: number } {
  const pre = e.pregame;
  const p = pre.projection;
  if (!p) return {};
  let sideGap: number | undefined;
  if (pre.spread && p.modelSide) {
    const modelHome = p.winner === pre.abbr.home ? p.margin : -p.margin;
    const marketHome = pre.spread.team === pre.abbr.home ? -pre.spread.line : pre.spread.line;
    sideGap = Math.round(Math.abs(modelHome - marketHome) * 10) / 10;
  }
  let totalGap: number | undefined;
  if (pre.total !== undefined && p.modelTotal !== undefined) totalGap = Math.round(Math.abs(p.modelTotal - pre.total) * 10) / 10;
  return { sideGap, totalGap };
}

export function clvForEntry(e: ArchiveEntry): ClvRecord | undefined {
  // Measured from the first lock (the lock follows the line to kickoff, so the final lock always equals the close).
  // Recomputed while the snapshots are on disk, which also corrects grades stored before that rule.
  const call = e.pregame.first ? { ...e.pregame.first, abbr: e.pregame.abbr } : e.pregame;
  try {
    const fresh = clvFrom(call, closingLine(e.season, e.gameId, e.pregame.kickoff));
    if (fresh) return fresh;
  } catch {
    /* fall back to the stored record */
  }
  return (e.postgame as { clv?: ClvRecord } | undefined)?.clv;
}

export function buildLedger(entries: ArchiveEntry[]): { rows: LedgerRow[]; stats: LedgerStats } {
  const rows: LedgerRow[] = [];
  const chrono = [...entries].sort((a, b) => a.pregame.kickoff.localeCompare(b.pregame.kickoff));
  let runStrong = 0;
  let runAll = 0;
  const clvs: number[] = [];
  const sideClvs: number[] = [];
  const totalClvs: number[] = [];
  let bets = 0, wins = 0, losses = 0, pushes = 0, betsAll = 0, unitsAll = 0, units = 0;

  for (const e of chrono) {
    if (!e.postgame) continue;
    const pre = e.pregame;
    const p = pre.projection;
    if (!p) continue;
    const { sideGap, totalGap } = gapsFor(e);
    const clv = clvForEntry(e);
    const pr = e.postgame.projectionResult;

    let side: SideLeg | undefined;
    const ss = sideGap !== undefined ? sideStrength(sideGap) : undefined;
    if (ss && pre.spread && p.modelSide) {
      const result: BetResult = pr?.modelSideCovered === undefined ? (e.postgame.spreadResult === "push" ? "push" : "ungraded") : pr.modelSideCovered ? "win" : "loss";
      side = { team: p.modelSide, strength: ss, gap: sideGap!, lockLine: pre.spread, closing: clv?.closingSpread, clv: clv?.sideClv, result, units: unitsFor(result) };
    }

    let total: TotalLeg | undefined;
    const ts = totalGap !== undefined ? totalStrength(totalGap) : undefined;
    if (ts && pre.total !== undefined && p.totalLean && p.totalLean !== "none") {
      const result: BetResult = pr?.totalLeanRight === undefined ? (e.postgame.totalResult === "push" ? "push" : "ungraded") : pr.totalLeanRight ? "win" : "loss";
      total = { lean: p.totalLean, strength: ts, gap: totalGap!, lockTotal: pre.total, closingTotal: clv?.closingTotal, clv: clv?.totalClv, result, units: unitsFor(result) };
    }

    if (!side && !total) continue;
    for (const leg of [side, total]) {
      if (!leg || leg.result === "ungraded") continue;
      betsAll++;
      unitsAll += leg.units;
      if (leg.strength === "strong") {
        bets++;
        units += leg.units;
        if (leg.result === "win") wins++;
        else if (leg.result === "loss") losses++;
        else pushes++;
      }
      if (leg.clv !== undefined) {
        clvs.push(leg.clv);
        (leg === side ? sideClvs : totalClvs).push(leg.clv);
      }
    }
    runStrong = units;
    runAll = unitsAll;
    rows.push({
      gameId: e.gameId,
      season: e.season,
      kickoff: pre.kickoff,
      label: `${pre.away} @ ${pre.home}`,
      score: `${e.postgame.score.away}-${e.postgame.score.home}`,
      side,
      total,
      closingAt: clv?.closingAt,
      runStrong: Math.round(runStrong * 100) / 100,
      runAll: Math.round(runAll * 100) / 100,
    });
  }

  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
  const stats: LedgerStats = {
    rows: rows.length,
    bets,
    units: Math.round(units * 100) / 100,
    roi: bets ? Math.round((units / bets) * 1000) / 10 : null,
    wins,
    losses,
    pushes,
    betsAll,
    unitsAll: Math.round(unitsAll * 100) / 100,
    roiAll: betsAll ? Math.round((unitsAll / betsAll) * 1000) / 10 : null,
    clvCount: clvs.length,
    clvAvg: avg(clvs),
    sideClvAvg: avg(sideClvs),
    totalClvAvg: avg(totalClvs),
    clvPositive: clvs.filter((c) => c > 0).length,
  };
  // Newest first for display.
  rows.reverse();
  return { rows, stats };
}
