/**
 * Usage trends by week: each team's rooms (QB, RB, WR/TE) with snap share, targets and target share, carries and carry
 * share, air yards share, and DK points per game, and the reason each big change happened. Server-only.
 *
 * A week is a change when his snap share moves 15 points, or his target or carry share moves 8 points, against his
 * average in his earlier games this season with this team. The reason comes from data only, first match wins:
 *   1. a regular in his room did not play (up), or came back (down)
 *   2. he left early: snaps under half his norm, then missed the next game or was on the next week's injury report (down)
 *   3. a blowout: final margin 17 or more (snap changes only)
 *   4. his first game back after missing games
 *   5. rookie workload growing: a rookie whose snap share rose three games running (up)
 *   6. a teammate in his room took on more work (down) or less (up) that week
 * else "no clear cause in the data". "Did not play" means no offensive snap and no stat line: out, inactive, or special
 * teams only; the injury report says which when it lists him.
 *
 * Inputs: data/generated/gamelogs.json (per-game lines with sn and s.rshare), players.json, injuries.json, teams.json
 * (play calling by week). Snap counts post a day or more after the stats: such a week shows "not posted", never 0%.
 */
import { dkPoints } from "./dfs";
import { gamelogsStamp, genGamelogs, genInjuries, genMeta, genPlayers, genTeams, teamsStamp, type GenGameLine, type GenPlayer, type GenTeam } from "./generated";
import { memoSync } from "./memo";

export type ChangeMetric = "snaps" | "targets" | "carries";
/** What explains a change: a teammate out or back or traded, he left early, a blowout, his first game back, a rookie
 *  growing, a teammate's role moving the other way, or nothing in the data. */
export type ChangeCause = "teammate-out" | "teammate-back" | "moved" | "left-early" | "blowout" | "first-back" | "rookie" | "role-shift" | "none";

export interface TrendWeek {
  wk: number;
  g: string;
  opp: string;
  ha: "home" | "away";
  /** His team's final margin (+ won by). */
  margin: number | null;
  /** Snap counts posted for this game. */
  snapsPosted: boolean;
}

export interface TrendCell {
  /** played = a stat line or a snap; out = no snap and no stat line while on the team; none = not with the team yet. */
  status: "played" | "out" | "none";
  snaps?: number; // offensive snap share, 0 to 1 (undefined: not posted, or no snap row)
  tgt?: number;
  tshare?: number; // 0 to 1
  ra?: number;
  rshare?: number; // 0 to 1
  air?: number; // air yards share, 0 to 1
  rec?: number;
  pa?: number; // pass attempts (quarterbacks)
  dk?: number;
  /** The injury report's status that week when he did not play ("Out", "Doubtful"). */
  listed?: string;
  /** He played for another team that week (traded or signed away): that team's nickname. */
  moved?: string;
  change?: { metric: ChangeMetric; from: number; to: number; reason: string; cause: ChangeCause };
}

export interface TrendRow {
  id: string;
  name: string;
  pos: string;
  rookie: boolean;
  /** His average snap share in his games (or target plus carry share when snaps are missing): the room's sort order. */
  role: number;
  cells: TrendCell[]; // one per TeamTrends.weeks
}

export interface TrendRoom {
  key: "QB" | "RB" | "WR/TE";
  rows: TrendRow[];
}

export interface TrendNote {
  wk: number;
  id: string;
  name: string;
  room: TrendRoom["key"];
  metric: ChangeMetric;
  from: number;
  to: number;
  reason: string;
  cause: ChangeCause;
  role: number;
}

export interface TeamTrends {
  team: string; // nickname
  weeks: TrendWeek[];
  rooms: TrendRoom[];
  /** Every change with its reason, newest week first. */
  notes: TrendNote[];
  calls: NonNullable<GenTeam["calls"]>;
}

const SNAP_MOVE = 0.15;
const SHARE_MOVE = 0.08;
const ROOM_CAP: Record<TrendRoom["key"], number> = { QB: 2, RB: 4, "WR/TE": 7 };
const roomOf = (pg: string | null | undefined): TrendRoom["key"] | undefined => (pg === "QB" ? "QB" : pg === "RB" ? "RB" : pg === "WR" || pg === "TE" ? "WR/TE" : undefined);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

/** One team's rooms by week, with changes and reasons. Memoized per ingest. */
export function teamTrends(team: string): TeamTrends | undefined {
  const logs = genGamelogs();
  if (!logs) return undefined;
  return memoSync(`trends:${team}:${gamelogsStamp()}:${teamsStamp()}`, 3600, () => build(team));
}

/** One player's row in his team's trends, with the weeks it lines up with. */
export function playerTrend(p: GenPlayer): { weeks: TrendWeek[]; row: TrendRow; notes: TrendNote[] } | undefined {
  const t = teamTrends(p.t);
  const row = t?.rooms.flatMap((r) => r.rows).find((r) => r.id === p.id);
  return t && row ? { weeks: t.weeks, row, notes: t.notes.filter((n) => n.id === p.id) } : undefined;
}

function build(team: string): TeamTrends {
  const logs = genGamelogs()!;
  const season = genMeta()?.season ?? new Date().getFullYear();
  const players = new Map(genPlayers().map((p) => [p.id, p]));

  // The team's games this season, in order, with the final margin.
  const weeks: TrendWeek[] = Object.entries(logs.games)
    .filter(([, g]) => g.home === team || g.away === team)
    .map(([g, x]) => {
      const ha = x.home === team ? ("home" as const) : ("away" as const);
      const margin = x.hp != null && x.ap != null ? (ha === "home" ? x.hp - x.ap : x.ap - x.hp) : null;
      return { wk: x.wk, g, opp: ha === "home" ? x.away : x.home, ha, margin, snapsPosted: false };
    })
    .sort((a, b) => a.wk - b.wk);
  const col = new Map(weeks.map((w, i) => [w.g, i]));

  // His lines for this team, by game; whether each game's snaps are posted (any line in it has a snap row).
  const linesBy = new Map<string, Map<string, GenGameLine>>();
  for (const [pid, lines] of Object.entries(logs.players)) {
    for (const l of lines) {
      if (!col.has(l.g)) continue;
      if (l.sn) weeks[col.get(l.g)!].snapsPosted = true;
      if (l.t !== team) continue;
      (linesBy.get(pid) ?? linesBy.set(pid, new Map()).get(pid)!).set(l.g, l);
    }
  }

  // The injury report by week for this team: id -> week -> status.
  const listed = new Map<string, Map<number, string>>();
  for (const i of genInjuries()) if (i.team === team && i.status) (listed.get(i.id) ?? listed.set(i.id, new Map()).get(i.id)!).set(i.week, i.status);

  // Rows: players in a room with a real role (10% of snaps in a game, or a target or carry).
  const rows: (TrendRow & { room: TrendRoom["key"] })[] = [];
  for (const [pid, byGame] of linesBy) {
    const p = players.get(pid);
    const room = roomOf(p?.pg);
    if (!p || !room) continue;
    const ls = [...byGame.values()];
    const hasRole = ls.some((l) => (l.sn?.o ?? 0) >= 0.1 || (l.s.tgt ?? 0) > 0 || (l.s.ra ?? 0) > 0 || (room === "QB" && (l.s.pa ?? 0) > 0));
    if (!hasRole) continue;
    const firstCol = Math.min(...ls.map((l) => col.get(l.g)!));
    const cells: TrendCell[] = weeks.map((w, i) => {
      const l = byGame.get(w.g);
      if (!l) {
        // Before his first game with the team: not with it yet, unless the injury report listed him for the team that week.
        if (i < firstCol) return listed.get(pid)?.get(w.wk) ? { status: "out", listed: listed.get(pid)!.get(w.wk) } : { status: "none" };
        const elsewhere = logs.players[pid]?.find((x) => x.wk === w.wk && x.t !== team);
        return { status: "out", listed: listed.get(pid)?.get(w.wk), moved: elsewhere?.t };
      }
      const s = l.s;
      return {
        status: "played",
        snaps: l.sn?.o,
        tgt: s.tgt ?? 0,
        tshare: s.tshare,
        ra: s.ra ?? 0,
        rshare: s.rshare ?? (s.ra ? undefined : 0),
        air: s.ayshare,
        rec: s.rec ?? 0,
        pa: s.pa ?? 0,
        dk: dkPoints(s),
      };
    });
    const played = cells.filter((c) => c.status === "played");
    const role = mean(played.map((c) => c.snaps).filter((x): x is number => x !== undefined)) ?? mean(played.map((c) => (c.tshare ?? 0) + (c.rshare ?? 0))) ?? 0;
    rows.push({ id: pid, name: p.n, pos: p.p ?? p.pg ?? "", rookie: (p.r.exp ?? 99) === 0 || p.r.yr === season, role, cells, room });
  }

  const rooms: TrendRoom[] = (["QB", "RB", "WR/TE"] as const).map((key) => ({
    key,
    rows: rows.filter((r) => r.room === key).sort((a, b) => b.role - a.role).slice(0, ROOM_CAP[key]),
  }));

  // Changes and reasons.
  const notes: TrendNote[] = [];
  for (const room of rooms) {
    for (const row of room.rows) {
      for (let i = 1; i < weeks.length; i++) {
        const c = row.cells[i];
        if (c.status !== "played") continue;
        const ch = changeAt(row, i, room.key);
        if (!ch) continue;
        const { cause, text: reason } = reasonFor(row, i, ch, room, weeks, team, listed);
        c.change = { ...ch, reason, cause };
        notes.push({ wk: weeks[i].wk, id: row.id, name: row.name, room: room.key, ...ch, reason, cause, role: row.role });
      }
    }
  }
  notes.sort((a, b) => b.wk - a.wk || Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

  const calls = genTeams().find((t) => t.team === team)?.calls ?? [];
  return { team, weeks, rooms, notes, calls };
}

/** The biggest move in week i against his earlier games this season (snap share 15 points, target or carry share 8). */
function changeAt(row: TrendRow, i: number, room: TrendRoom["key"]): { metric: ChangeMetric; from: number; to: number } | undefined {
  const before = row.cells.slice(0, i).filter((c) => c.status === "played");
  if (!before.length) return undefined;
  const c = row.cells[i];
  const cands: { metric: ChangeMetric; from: number; to: number; size: number }[] = [];
  const consider = (metric: ChangeMetric, now: number | undefined, prior: (number | undefined)[], move: number) => {
    const p = mean(prior.filter((x): x is number => x !== undefined));
    if (now === undefined || p === undefined) return;
    const size = Math.abs(now - p) / move;
    if (size >= 1) cands.push({ metric, from: p, to: now, size });
  };
  consider("snaps", c.snaps, before.map((b) => b.snaps), SNAP_MOVE);
  if (room !== "QB") consider("targets", c.tshare, before.map((b) => b.tshare), SHARE_MOVE);
  if (room === "RB") consider("carries", c.rshare, before.map((b) => b.rshare), SHARE_MOVE);
  const top = cands.sort((a, b) => b.size - a.size)[0];
  return top ? { metric: top.metric, from: top.from, to: top.to } : undefined;
}

const usage = (c: TrendCell | undefined, m: ChangeMetric) => (c?.status !== "played" ? undefined : m === "snaps" ? c.snaps : m === "targets" ? c.tshare : c.rshare);

function reasonFor(row: TrendRow, i: number, ch: { metric: ChangeMetric; from: number; to: number }, room: TrendRoom, weeks: TrendWeek[], team: string, listed: Map<string, Map<number, string>>): { cause: ChangeCause; text: string } {
  const up = ch.to > ch.from;
  const w = weeks[i];
  const mates = room.rows.filter((r) => r.id !== row.id);
  // A regular: 40% of snaps, or 15% of targets, or 25% of carries, in his games before this week.
  const regular = (r: TrendRow) => {
    const before = r.cells.slice(0, i).filter((c) => c.status === "played");
    const s = mean(before.map((c) => c.snaps).filter((x): x is number => x !== undefined));
    const t = mean(before.map((c) => c.tshare).filter((x): x is number => x !== undefined));
    const ca = mean(before.map((c) => c.rshare).filter((x): x is number => x !== undefined));
    return (s ?? 0) >= 0.4 || (t ?? 0) >= 0.15 || (ca ?? 0) >= 0.25;
  };
  const who = (rs: TrendRow[]) => (rs.length === 1 ? rs[0].name : `${rs[0].name} and ${rs[1].name}`);
  const listedAs = (r: TrendRow) => {
    const st = r.cells[i].listed;
    return st ? ` (listed ${st.toLowerCase()})` : "";
  };

  // 1. A regular in his room did not play, or came back.
  if (up) {
    const gone = mates.filter((r) => r.cells[i].status === "out" && regular(r));
    const moved = gone.find((r) => r.cells[i].moved);
    if (moved) return { cause: "moved", text: `${moved.name} left for the ${moved.cells[i].moved}` };
    if (gone.length) return { cause: "teammate-out", text: `${who(gone.slice(0, 2))} did not play${gone.length === 1 ? listedAs(gone[0]) : ""}` };
  } else {
    const back = mates.filter((r) => r.cells[i].status === "played" && r.cells[i - 1]?.status === "out" && regular(r));
    if (back.length) return { cause: "teammate-back", text: `${who(back.slice(0, 2))} came back` };
  }
  // 2. He left early: snaps under half his norm, then missed the next game or was on the next week's injury report.
  if (!up && ch.metric === "snaps" && ch.to < ch.from / 2) {
    const next = row.cells[i + 1];
    if (next?.status === "out") return { cause: "left-early", text: `left early, then missed week ${weeks[i + 1].wk}` };
    const rep = listed.get(row.id)?.get(w.wk + 1);
    if (rep) return { cause: "left-early", text: `left early; listed ${rep.toLowerCase()} the next week` };
  }
  // 3. A blowout: it explains snaps (starters sit, backups play), not who got the targets or carries.
  if (ch.metric === "snaps" && w.margin !== null && Math.abs(w.margin) >= 17) return { cause: "blowout", text: `blowout: the ${team} ${w.margin > 0 ? "won" : "lost"} by ${Math.abs(w.margin)}` };
  // 4. His first game back.
  if (row.cells[i - 1]?.status === "out") return { cause: "first-back", text: `first game back after missing week ${weeks[i - 1].wk}` };
  // 5. Rookie workload growing.
  if (up && row.rookie && i >= 2) {
    const s = [row.cells[i - 2], row.cells[i - 1], row.cells[i]].map((c) => c.snaps);
    if (s.every((x) => x !== undefined) && s[0]! < s[1]! && s[1]! < s[2]!) return { cause: "rookie", text: "rookie workload growing" };
  }
  // 6. A teammate took on more work (down) or less (up) that week.
  const shift = mates
    .map((r) => {
      const before = mean(r.cells.slice(0, i).map((c) => usage(c, ch.metric)).filter((x): x is number => x !== undefined));
      const now = usage(r.cells[i], ch.metric);
      return { r, before, now, d: now !== undefined && before !== undefined ? now - before : 0 };
    })
    .filter((x) => (up ? x.d <= -(ch.metric === "snaps" ? SNAP_MOVE : SHARE_MOVE) : x.d >= (ch.metric === "snaps" ? SNAP_MOVE : SHARE_MOVE)))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  if (shift) {
    const what = ch.metric === "snaps" ? "snaps" : ch.metric === "targets" ? "target share" : "carry share";
    return { cause: "role-shift", text: `${shift.r.name}'s role ${up ? "shrank" : "grew"} (${what} ${pct(shift.before!)} to ${pct(shift.now!)})` };
  }
  return { cause: "none", text: "no clear cause in the data" };
}

/**
 * The change worth a headline: the newest week, then the strongest cause (a teammate out, back, or traded, or he left
 * early, ahead of a role shift, a rookie, a first game back, then a blowout), then the bigger role. Unexplained changes
 * never lead.
 */
export function topChange(list: TeamTrends[]): TrendNote | undefined {
  const rank: Record<ChangeCause, number> = { "teammate-out": 5, moved: 5, "teammate-back": 4, "left-early": 4, "role-shift": 3, rookie: 3, "first-back": 2, blowout: 1, none: 0 };
  return list
    .flatMap((t) => t.notes)
    .filter((n) => n.cause !== "none")
    .sort((a, b) => b.wk - a.wk || rank[b.cause] - rank[a.cause] || b.role - a.role)[0];
}

/** "snaps 77% to 51%" for a change. */
export function changeText(ch: { metric: ChangeMetric; from: number; to: number }): string {
  const what = ch.metric === "snaps" ? "snaps" : ch.metric === "targets" ? "target share" : "carry share";
  return `${what} ${pct(ch.from)} to ${pct(ch.to)}`;
}

/** Pass-heavy / balanced / run-heavy from pass rate over expected (points): +5 or more, within 5, -5 or less. */
export function callLabel(proe: number | null): string {
  if (proe === null) return "";
  return proe >= 5 ? "pass-heavy" : proe <= -5 ? "run-heavy" : "balanced";
}
