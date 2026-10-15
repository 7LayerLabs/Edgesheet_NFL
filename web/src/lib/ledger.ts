/**
 * Flat-bet ledger over the accountability archive. A simulation, not advice. Each game's posted calls (archive.ts
 * postedOf: the first lock where the gap reached 2+ points on the side or 2.5+ on the total, frozen with that line) are
 * graded at the line they were posted against, one unit on every big gap at standard -110. Closing-line value is
 * measured on the same posted call, from the Odds API snapshots (recomputed here while the files are on disk, else
 * postgame.clv).
 */
import { callGaps, postedCall, postedOf, type ArchiveEntry } from "./archive";
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
  /** When the call was posted (its first lock with a gap). */
  postedAt: string;
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
  postedAt: string;
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

/** The final lock's gap to the market (the closing record), rebuilt from what the lock stored. */
export const gapsFor = (e: ArchiveEntry): { sideGap?: number; totalGap?: number } => callGaps(e.pregame, e.pregame.abbr);

export function clvForEntry(e: ArchiveEntry): ClvRecord | undefined {
  // Measured on the posted calls, the same calls the ledger grades. Recomputed while the snapshots are on disk, which also
  // corrects grades stored under the earlier first-lock rule (that measured a side the ledger did not grade).
  try {
    const fresh = clvFrom(postedCall(postedOf(e.pregame), e.pregame.abbr), closingLine(e.season, e.gameId, e.pregame.kickoff));
    if (fresh) return fresh;
  } catch {
    /* fall back to the stored record */
  }
  return (e.postgame as { clv?: ClvRecord } | undefined)?.clv;
}

/** A posted side graded at its own line: did the posted team cover the number it was posted against? */
function sideResult(line: { team: string; line: number }, team: string, score: { home: number; away: number }, homeAbbr: string): BetResult {
  const favMargin = line.team === homeAbbr ? score.home - score.away : score.away - score.home;
  const need = Math.abs(line.line);
  if (favMargin === need) return "push";
  return favMargin > need === (team === line.team) ? "win" : "loss";
}

function totalResult(lean: "over" | "under", line: number, pts: number): BetResult {
  if (pts === line) return "push";
  return pts > line === (lean === "over") ? "win" : "loss";
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
    const posted = postedOf(pre);
    const clv = clvForEntry(e);
    const score = e.postgame.score;

    let side: SideLeg | undefined;
    const ps = posted.side;
    const ss = ps ? sideStrength(ps.gap) : undefined;
    if (ps && ss) {
      const result = sideResult(ps.line, ps.team, score, pre.abbr.home);
      side = { team: ps.team, strength: ss, gap: ps.gap, postedAt: ps.at, lockLine: ps.line, closing: clv?.closingSpread, clv: clv?.sideClv, result, units: unitsFor(result) };
    }

    let total: TotalLeg | undefined;
    const pt = posted.total;
    const ts = pt ? totalStrength(pt.gap) : undefined;
    if (pt && ts) {
      const result = totalResult(pt.lean, pt.line, score.home + score.away);
      total = { lean: pt.lean, strength: ts, gap: pt.gap, postedAt: pt.at, lockTotal: pt.line, closingTotal: clv?.closingTotal, clv: clv?.totalClv, result, units: unitsFor(result) };
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
