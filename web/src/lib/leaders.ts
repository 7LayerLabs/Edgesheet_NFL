/**
 * A player's efficiency from the leaders boards (scripts/ingest-leaders.mjs), with his rank among qualified players at
 * the same job. Server-only. Used by the DraftKings why lines and the player page.
 */
import { genLeaders, type LeaderBoard, type PassLeader, type RecLeader, type RushLeader } from "./generated";

const sg = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const rk = (r: { rank?: Record<string, number>; of?: Record<string, number> }, k: string) => (r.rank?.[k] && r.of?.[k] ? ` (No. ${r.rank[k]} of ${r.of[k]})` : "");

export function leaderRows(id: string, season?: number): { rush?: RushLeader; rec?: RecLeader; pass?: PassLeader; board?: LeaderBoard } {
  const L = genLeaders();
  const y = season ?? L?.seasons[0];
  const b = y !== undefined ? L?.boards[String(y)] : undefined;
  if (!b) return {};
  return { rush: b.rushing.find((r) => r.id === id), rec: b.receiving.find((r) => r.id === id), pass: b.passing.find((r) => r.id === id), board: b };
}

/** One line for a why list: the efficiency number that matters most at his position, with its rank when he qualifies. */
export function efficiencyLine(id: string, pos: string): string | undefined {
  const { rush, rec, pass } = leaderRows(id);
  if (pos === "QB" && pass && pass.epaPer !== undefined) {
    return `${sg(pass.epaPer)} EPA a dropback${rk(pass, "epaPer")}${pass.cpoe !== undefined ? `, CPOE ${sg(pass.cpoe, 1)}` : ""}`;
  }
  if (pos === "RB" && rush && rush.succ !== undefined) {
    return `${rush.succ}% rush success${rk(rush, "succ")}, ${rush.expl ?? 0}% of carries 10+ yards`;
  }
  if ((pos === "WR" || pos === "TE") && rec && rec.epaPer !== undefined) {
    return `${sg(rec.epaPer)} EPA a target${rk(rec, "epaPer")}${rec.airShare !== undefined ? `, ${rec.airShare}% of the team's air yards` : ""}`;
  }
  return undefined;
}
