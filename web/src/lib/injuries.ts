/**
 * The game page's injury list: every player on either team's injury list, detailed enough to bet on. Server-only.
 *
 * Sources, merged by player: ESPN's league injury feed (live, multi-week injuries and game-day inactives, with its
 * latest news line) and the nflverse official report (practice participation and the injury). The official report for
 * the game's own week is used when the league has posted it (first report Wednesday); until then the latest posted
 * week stands in and the page says which week it is. Each row also carries whether he is a starter (depth chart No. 1
 * or 60%+ of his side's snaps) and what the availability model charges for his absence, so a starting quarterback out
 * reads as the points it moves, not one name in a list.
 */
import { espnInjuries } from "./availability";
import { genInjuries, genPlayers } from "./generated";
import type { Game } from "./types";

export interface InjuryRow {
  id: string;
  name: string;
  pos: string;
  status: string; // Out, Injured Reserve, Doubtful, Questionable, Suspension ...
  injury?: string; // body part, from the official report
  practice?: string; // final practice line, from the official report
  note?: string; // ESPN's latest news line
  noteDate?: string; // ISO
  starter: boolean;
  snap?: number; // percent of his side's snaps this season
  impact?: number; // points the availability model charges (negative hurts his team)
  impactWhy?: string;
}

export interface TeamInjuries {
  team: string;
  rows: InjuryRow[]; // out, doubtful, questionable, and starters on reserve
  reserve: { id: string; name: string; pos: string; status: string }[]; // backups on reserve lists, one line
}

export interface GameInjuries {
  away: TeamInjuries;
  home: TeamInjuries;
  reportWeek?: number;
  reportIsThisWeek: boolean;
  espnAt?: string;
  notes: string[];
}

const SEVERITY = (s: string) => (/^out|inactive|suspen/i.test(s) ? 0 : /reserve|^ir$|pup|nfi/i.test(s) ? 1 : /doubt/i.test(s) ? 2 : /question/i.test(s) ? 3 : 4);
const short = (s?: string) => (s ? s.replace(/\s+/g, " ").trim() : undefined);

export async function injuriesFor(game: Game): Promise<GameInjuries> {
  const espn = await espnInjuries();
  const players = new Map(genPlayers().map((p) => [p.id, p]));
  const all = genInjuries();
  const teams = [game.away.short, game.home.short];
  const gameWeek = game.week ?? 99;
  const weeks = all.filter((r) => teams.includes(r.team) && r.week <= gameWeek).map((r) => r.week);
  const reportWeek = weeks.length ? Math.max(...weeks) : undefined;
  const official = new Map(all.filter((r) => teams.includes(r.team) && r.week === reportWeek).map((r) => [r.id, r]));
  const av = game.availability;

  const build = (team: string): TeamInjuries => {
    const side = av ? (team === av.home.team ? av.home : av.away) : undefined;
    const byId = new Map<string, InjuryRow>();
    const put = (id: string, name: string, pos: string, status: string) => {
      const p = players.get(id);
      const snapShare = p ? Math.max(p.u?.o ?? 0, p.u?.d ?? 0) : 0;
      const row: InjuryRow = byId.get(id) ?? { id, name, pos: p?.p ?? pos, status, starter: Boolean(p && (p.dc?.rank === 1 || snapShare >= 0.6)), snap: snapShare ? Math.round(snapShare * 100) : undefined };
      byId.set(id, row);
      return row;
    };
    for (const e of espn.rows.filter((r) => r.team === team && r.status !== "Active")) {
      const row = put(e.id, e.name, e.pos ?? "", /inactive/i.test(e.comment ?? "") ? "Inactive" : e.status);
      // The short line is often only "out" or "inactive" on game day; the long one carries the injury and the timeline.
      const brief = short(e.comment);
      row.note = brief && brief.split(" ").length > 3 ? brief : short(e.detail) ?? brief;
      row.noteDate = e.date;
    }
    for (const o of official.values()) {
      if (o.team !== team || !o.status) continue;
      const row = put(o.id, o.name, o.pos, byId.get(o.id)?.status ?? o.status);
      row.injury = o.injury ?? undefined;
      row.practice = o.practice ?? undefined;
    }
    // What the model charges: the player's own item, or for a starting quarterback who sits, the QB swap.
    for (const row of byId.values()) {
      const item = side?.items.find((i) => i.id === row.id && i.kind !== "qb");
      if (item && item.pts !== 0) {
        row.impact = item.pts;
        row.impactWhy = "his absence in the projection";
      }
      if (row.pos === "QB" && side?.qb && side.qb.expected !== row.name && Math.abs(side.qb.pts) >= 0.5) {
        row.impact = side.qb.pts;
        row.impactWhy = `${side.qb.expected} expected to start`;
      }
    }
    const list = [...byId.values()].sort((a, b) => SEVERITY(a.status) - SEVERITY(b.status) || Number(b.starter) - Number(a.starter) || (a.impact ?? 0) - (b.impact ?? 0) || (b.snap ?? 0) - (a.snap ?? 0));
    const onReserve = (r: InjuryRow) => SEVERITY(r.status) === 1;
    return {
      team,
      rows: list.filter((r) => !onReserve(r) || r.starter || (r.impact ?? 0) !== 0),
      reserve: list.filter((r) => onReserve(r) && !r.starter && (r.impact ?? 0) === 0).map((r) => ({ id: r.id, name: r.name, pos: r.pos, status: r.status })),
    };
  };

  const notes: string[] = [];
  if (espn.error) notes.push(`${espn.error}. Official report only.`);
  if (reportWeek !== undefined && reportWeek !== game.week) notes.push(`Practice lines are from the week ${reportWeek} official report; the week ${game.week} report posts with the first practice of the week.`);
  return { away: build(game.away.short), home: build(game.home.short), reportWeek, reportIsThisWeek: reportWeek === game.week, espnAt: espn.rows.length ? espn.at : undefined, notes };
}

/** One line for the closed section: each team's most important absence and how many more. */
export function injurySummaryLine(g: GameInjuries): string {
  const part = (t: TeamInjuries) => {
    const key = t.rows.find((r) => r.starter && SEVERITY(r.status) <= 2) ?? t.rows[0];
    if (!key) return `${t.team}: nobody listed`;
    const more = t.rows.length - 1;
    return `${t.team}: ${key.name} (${key.pos}) ${key.status.toLowerCase()}${more > 0 ? `, ${more} more` : ""}`;
  };
  return `${part(g.away)} · ${part(g.home)}`;
}

/** True when a starter is out or doubtful on either side: the section opens by itself. */
export const starterOut = (g: GameInjuries) => [...g.away.rows, ...g.home.rows].some((r) => r.starter && SEVERITY(r.status) <= 2);
