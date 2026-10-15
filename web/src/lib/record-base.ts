/**
 * Base rates for the record's matchup calls and radar names. A "played out" rate means nothing alone: some offenses clear
 * 4.6 yards a carry with no edge at all. So every team-game this season is held to the same box-score bar (edgeVerdict),
 * and every every-down player (half his unit's snaps or more) to the same "showed up" bar (prospectShowed). The record
 * then shows hits against what the base rate would have hit on the same calls. Season to date, regular season, from
 * nflverse game logs (data/generated/gamelogs.json). Server-only.
 */
import { edgeVerdict, prospectShowed, type TeamBox } from "./archive";
import { gamelogsStamp, genGamelogs, genPlayers, type StatLine } from "./generated";
import { memoSync } from "./memo";
import { groupOf } from "./radar";

export interface RecordBase {
  teamGames: number;
  /** Share of team-games that clear each edge bar with no call made. Run game and ground game edges share the rush bar. */
  edge: Record<"rush" | "pass", Record<"offense" | "defense", number>>;
  /** By radar position group: every-down player-games and the share that clear the "showed up" bar. */
  prospect: Record<string, { n: number; rate: number }>;
}

const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);
const DEFENSE = new Set(["DL", "EDGE", "LB", "CB", "S"]);
/** Every-down player: at least this share of his unit's snaps in the game. */
const EVERY_DOWN = 0.5;

export function recordBase(): RecordBase | undefined {
  return memoSync(`record-base:${gamelogsStamp()}`, 3600, () => {
    const logs = genGamelogs();
    if (!logs) return undefined;
    const final = (g: string) => logs.games[g]?.st === "regular" && logs.games[g].hp != null;

    // Team boxes summed from the player lines: rushing and passing yards, carries, and the game file's longest play.
    const boxes = new Map<string, TeamBox>();
    for (const lines of Object.values(logs.players)) {
      for (const l of lines) {
        if (l.st !== "regular" || !final(l.g)) continue;
        const key = `${l.g}|${l.t}`;
        const b = boxes.get(key) ?? { rushYds: 0, rushCar: 0, passYds: 0, longPlay: logs.games[l.g].long?.[l.ha] ?? 0 };
        b.rushYds += l.s.ry ?? 0;
        b.rushCar += l.s.ra ?? 0;
        b.passYds += l.s.py ?? 0;
        boxes.set(key, b);
      }
    }
    if (!boxes.size) return undefined;
    const share = (axis: "rush" | "pass", edge: "offense" | "defense") => [...boxes.values()].filter((b) => edgeVerdict(axis, edge, b) === "played out").length / boxes.size;

    // Every-down player-games by position group.
    const groups = new Map<string, string>();
    for (const p of genPlayers()) {
      const g = groupOf(p);
      if (g) groups.set(p.id, g);
    }
    const tally: Record<string, { n: number; hit: number }> = {};
    for (const [id, lines] of Object.entries(logs.players)) {
      const g = groups.get(id);
      if (!g || (!OFFENSE.has(g) && !DEFENSE.has(g))) continue;
      for (const l of lines) {
        if (l.st !== "regular" || !final(l.g)) continue;
        const snap = OFFENSE.has(g) ? l.sn?.o : l.sn?.d;
        if ((snap ?? 0) < EVERY_DOWN) continue;
        const t = (tally[g] ??= { n: 0, hit: 0 });
        t.n++;
        if (prospectShowed(numbers(l.s))) t.hit++;
      }
    }
    const prospect: RecordBase["prospect"] = {};
    for (const [g, t] of Object.entries(tally)) if (t.n) prospect[g] = { n: t.n, rate: t.hit / t.n };

    return {
      teamGames: boxes.size,
      edge: { rush: { offense: share("rush", "offense"), defense: share("rush", "defense") }, pass: { offense: share("pass", "offense"), defense: share("pass", "defense") } },
      prospect,
    };
  });
}

/** nflverse stat keys into the units of the "showed up" bar (the box score's TOT, SACKS, TFL, PD, INT). */
function numbers(s: StatLine) {
  const n = (k: string) => s[k] ?? 0;
  return { passYds: n("py"), passTd: n("ptd"), rushYds: n("ry"), rushTd: n("rtd"), recYds: n("rcy"), recTd: n("rctd"), tackles: n("tk"), sacks: n("sk"), tfl: n("tfl"), pd: n("pd"), int: n("int") };
}
