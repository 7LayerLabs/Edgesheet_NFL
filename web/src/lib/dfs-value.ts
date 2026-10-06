/**
 * "Our price" for every DraftKings player on a simulated slate, and the two value lists. Server-only.
 *
 * Our price is DraftKings' own price scale applied to our number: rank every player at the position on the slate by our
 * simulated median, and he gets the DK salary at the same rank (the k-th best median gets the k-th highest salary). So
 * it never invents a dollars-per-point rate, and a gap means DK ranks him differently than we do. Gap = ours - DK's:
 * plus is cheap by our numbers. Rounded to $100.
 *
 * Lists (backs, receivers, tight ends, quarterbacks; defenses are left out because the record cannot grade them yet),
 * each capped like a lineup (1 QB, 2 RB, 2 WR, 1 TE), since quarterbacks bust least by nature and would fill a list:
 *   Safest values: $300 or more cheap, 75%+ to play, lowest bust rate (under 2x salary per $1,000) first. Cash games.
 *   Upside values: $300 or more cheap, 75%+ to play, highest boom rate (5x salary per $1,000) first. Tournaments.
 * Each pick carries its reasons from our data: a teammate's work it inherits (the projection's next-man-up), Jev's read
 * of the news, the matchup, and the newest usage change with its cause (src/lib/trends.ts).
 */
import type { SlatePlayer, SlateSim } from "./dfs-slate";
import { genPlayers } from "./generated";
import { playerTrend, changeText } from "./trends";

export interface Priced {
  ours: number;
  gap: number; // ours - DK salary
}

export interface ValuePick {
  key: string;
  id?: string;
  name: string;
  pos: string;
  teamAbbr: string;
  oppAbbr: string;
  gameId: string;
  kickoff: string;
  salary: number;
  ours: number;
  gap: number;
  median: number;
  floor: number;
  ceiling: number;
  boom: number;
  bust: number;
  pPlay: number;
  reasons: string[];
}

const round100 = (x: number) => Math.round(x / 100) * 100;
const MIN_GAP = 300;
const MIN_PLAY = 0.75;
const CAP: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1 };

/** Our price for every player on the slate, by sim key. */
export function pricePlayers(sim: SlateSim): Map<string, Priced> {
  const out = new Map<string, Priced>();
  const byPos = new Map<string, SlatePlayer[]>();
  for (const p of sim.players) (byPos.get(p.play.pos) ?? byPos.set(p.play.pos, []).get(p.play.pos)!).push(p);
  for (const list of byPos.values()) {
    const salaries = list.map((p) => p.play.salary).sort((a, b) => b - a);
    const ranked = [...list].sort((a, b) => b.median - a.median || b.play.salary - a.play.salary);
    ranked.forEach((p, i) => {
      const ours = round100(salaries[i]);
      out.set(p.key, { ours, gap: ours - p.play.salary });
    });
  }
  return out;
}

/** The reasons behind a player's number, from our data (up to three). */
export function reasonsFor(p: SlatePlayer): string[] {
  const r: string[] = [];
  const play = p.play;
  if (play.bump) r.push(`Picks up work with ${play.bump.from} ${play.bump.status.toLowerCase()}`);
  if (p.jev && p.jev.role !== "usual") r.push(`Jev read ${p.jev.posts} news item${p.jev.posts === 1 ? "" : "s"}: ${p.jev.role === "bigger" ? "a bigger role" : "a limited role"}`);
  if (play.oppRank !== undefined && play.oppAllowed !== undefined && (play.oppRank <= 8 || play.oppRank >= 25)) {
    r.push(`${play.oppRank <= 8 ? "Soft" : "Tough"} matchup: the ${play.opp} allow ${play.oppAllowed} DK points a game to ${play.pos}s (No. ${play.oppRank} most)`);
  }
  if (play.id) {
    const gp = genPlayers().find((x) => x.id === play.id);
    const t = gp ? playerTrend(gp) : undefined;
    // The newest explained usage change: a reason when his role grew, a caution when it shrank.
    const n = t?.notes.find((x) => x.cause !== "none");
    if (n && r.length < 3) r.push(`${n.to > n.from ? "" : "Caution, "}${n.to > n.from ? "Week" : "week"} ${n.wk}: ${changeText(n)} (${n.reason})`);
  }
  return r.slice(0, 3);
}

/** Safest and Upside values for a slate (see the file comment). */
export function valueLists(sim: SlateSim, priced = pricePlayers(sim)): { safest: ValuePick[]; upside: ValuePick[] } {
  const pick = (p: SlatePlayer): ValuePick => {
    const pr = priced.get(p.key)!;
    return {
      key: p.key, id: p.play.id, name: p.play.name, pos: p.play.pos, teamAbbr: p.play.teamAbbr, oppAbbr: p.play.oppAbbr, gameId: p.play.gameId, kickoff: p.play.kickoff,
      salary: p.play.salary, ours: pr.ours, gap: pr.gap, median: p.median, floor: p.floor, ceiling: p.ceiling, boom: p.boom, bust: p.bust, pPlay: p.pPlay, reasons: reasonsFor(p),
    };
  };
  const cheap = sim.players.filter((p) => p.play.pos !== "DST" && p.pPlay >= MIN_PLAY && (priced.get(p.key)?.gap ?? 0) >= MIN_GAP);
  // Take the best in order until each position's cap is full.
  const capped = (list: SlatePlayer[]) => {
    const used: Record<string, number> = {};
    return list.filter((p) => (used[p.play.pos] = (used[p.play.pos] ?? 0) + 1) <= (CAP[p.play.pos] ?? 0));
  };
  const safest = capped([...cheap].sort((a, b) => a.bust - b.bust || priced.get(b.key)!.gap - priced.get(a.key)!.gap));
  const taken = new Set(safest.map((p) => p.key));
  const upside = capped(cheap.filter((p) => !taken.has(p.key)).sort((a, b) => b.boom - a.boom || priced.get(b.key)!.gap - priced.get(a.key)!.gap));
  return { safest: safest.map(pick), upside: upside.map(pick) };
}
