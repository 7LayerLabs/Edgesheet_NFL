/**
 * Game box scores. Two sources, same shape:
 *   nflverse  the weekly player stats file, through the gamelogs digest (settled, usually posted within a day)
 *   ESPN      the summary endpoint's per-player rows, used from the final until nflverse posts the week
 * Team keys are nicknames. Stat keys match what archive.ts grades on (YDS, CAR, LONG, TOT, TFL, SACKS, PD, INT).
 */
import { memo, memoSync } from "./memo";
import { genGamelogs, gamelogsStamp, type GenGameLine } from "./generated";
import { liveSummary } from "./espn";
import { gameById, teamByShort } from "./nfl";

export interface BoxLine {
  id: string;
  name: string;
  team: string; // nickname
  category: string; // passing, rushing, receiving, defensive, interceptions
  stats: Record<string, string>;
  headline: string;
  yards: number;
}

export interface BoxScore {
  gameId: string;
  source: "nflverse" | "espn";
  teams: { team: string; homeAway: "home" | "away"; points: number | null; leaders: BoxLine[]; longPlay?: number | null }[];
  byPlayer: Map<string, BoxLine[]>;
}

export function headline(category: string, s: Record<string, string>): { text: string; yards: number } {
  const n = (k: string) => Number(s[k] ?? 0) || 0;
  switch (category) {
    case "passing": return { text: `${s["C/ATT"] ?? ""}, ${n("YDS")} yds, ${n("TD")} TD, ${n("INT")} INT`, yards: n("YDS") };
    case "rushing": return { text: `${n("CAR")} car, ${n("YDS")} yds, ${n("TD")} TD`, yards: n("YDS") };
    case "receiving": return { text: `${n("REC")} rec, ${n("YDS")} yds, ${n("TD")} TD${s.TGT ? ` (${s.TGT} tgt)` : ""}`, yards: n("YDS") };
    case "defensive": return { text: `${n("TOT")} tkl, ${n("TFL")} TFL, ${n("SACKS")} sacks${n("PD") ? `, ${n("PD")} PD` : ""}${n("QBH") ? `, ${n("QBH")} QB hits` : ""}`, yards: n("TOT") * 8 + n("TFL") * 15 + n("SACKS") * 25 };
    case "interceptions": return { text: `${n("INT")} INT, ${n("YDS")} yds`, yards: n("INT") * 40 };
    default: return { text: Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", "), yards: 0 };
  }
}

const CATS = ["passing", "rushing", "receiving", "defensive", "interceptions"];

function leadersOf(lines: BoxLine[]): BoxLine[] {
  return CATS.flatMap((c) => lines.filter((l) => l.category === c).sort((a, b) => b.yards - a.yards).slice(0, c === "receiving" || c === "defensive" ? 2 : 1)).filter((l) => l.yards > 0);
}

/* ------------------------------------------------------------ nflverse */

/** Compact weekly line to the box categories. Only categories the line has. */
export function categoriesOf(s: Record<string, number>): { category: string; stats: Record<string, string> }[] {
  const out: { category: string; stats: Record<string, string> }[] = [];
  const str = (v: number | undefined) => String(v ?? 0);
  if (s.pa) out.push({ category: "passing", stats: { "C/ATT": `${s.pc ?? 0}/${s.pa}`, YDS: str(s.py), TD: str(s.ptd), INT: str(s.pint) } });
  if (s.ra) out.push({ category: "rushing", stats: { CAR: str(s.ra), YDS: str(s.ry), TD: str(s.rtd) } });
  if (s.rec || s.tgt) out.push({ category: "receiving", stats: { REC: str(s.rec), YDS: str(s.rcy), TD: str(s.rctd), TGT: str(s.tgt) } });
  const tk = s.tk ?? (s.solo ?? 0) + (s.ast ?? 0) + (s.tast ?? 0);
  if (tk || s.sk || s.tfl || s.pd || s.hur) out.push({ category: "defensive", stats: { TOT: str(tk), SOLO: str(s.solo), SACKS: str(s.sk), TFL: str(s.tfl), PD: str(s.pd), QBH: str(s.hur) } });
  if (s.int) out.push({ category: "interceptions", stats: { INT: str(s.int), YDS: str(s.inty) } });
  return out;
}

function linesByGame(): Map<string, { id: string; name: string; line: GenGameLine }[]> {
  return memoSync(`box:bygame:${gamelogsStamp()}`, 3600, () => {
    const m = new Map<string, { id: string; name: string; line: GenGameLine }[]>();
    const logs = genGamelogs();
    if (!logs) return m;
    for (const [id, lines] of Object.entries(logs.players)) {
      for (const l of lines) (m.get(l.g) ?? m.set(l.g, []).get(l.g)!).push({ id, name: "", line: l });
    }
    return m;
  });
}

function fromNflverse(gameId: string, names: Map<string, string>): BoxScore | undefined {
  const logs = genGamelogs();
  const g = logs?.games[gameId];
  const rows = linesByGame().get(gameId);
  if (!logs || !g || !rows?.length) return undefined;
  const byPlayer = new Map<string, BoxLine[]>();
  const perTeam = new Map<string, BoxLine[]>();
  for (const r of rows) {
    for (const c of categoriesOf(r.line.s)) {
      const h = headline(c.category, c.stats);
      const line: BoxLine = { id: r.id, name: names.get(r.id) ?? r.id, team: r.line.t, category: c.category, stats: c.stats, headline: h.text, yards: h.yards };
      (byPlayer.get(r.id) ?? byPlayer.set(r.id, []).get(r.id)!).push(line);
      (perTeam.get(r.line.t) ?? perTeam.set(r.line.t, []).get(r.line.t)!).push(line);
    }
  }
  const teams: BoxScore["teams"] = [
    { team: g.home, homeAway: "home", points: g.hp, leaders: leadersOf(perTeam.get(g.home) ?? []), longPlay: g.long?.home ?? null },
    { team: g.away, homeAway: "away", points: g.ap, leaders: leadersOf(perTeam.get(g.away) ?? []), longPlay: g.long?.away ?? null },
  ];
  return { gameId, source: "nflverse", teams, byPlayer };
}

/* ---------------------------------------------------------------- ESPN */

const ESPN_KEYS: Record<string, Record<string, string>> = {
  passing: { "completions/passingAttempts": "C/ATT", passingYards: "YDS", passingTouchdowns: "TD", interceptions: "INT" },
  rushing: { rushingAttempts: "CAR", rushingYards: "YDS", rushingTouchdowns: "TD", longRushing: "LONG" },
  receiving: { receptions: "REC", receivingYards: "YDS", receivingTouchdowns: "TD", longReception: "LONG", receivingTargets: "TGT" },
  defensive: { totalTackles: "TOT", soloTackles: "SOLO", sacks: "SACKS", tacklesForLoss: "TFL", passesDefended: "PD", QBHits: "QBH" },
  interceptions: { interceptions: "INT", interceptionYards: "YDS" },
};

async function fromEspn(gameId: string, home: string, away: string): Promise<BoxScore | undefined> {
  const s = await liveSummary(gameId).catch(() => undefined);
  if (!s || s.state !== "post" || !s.lines.length) return undefined;
  const byPlayer = new Map<string, BoxLine[]>();
  const perTeam = new Map<string, BoxLine[]>();
  for (const r of s.lines) {
    const map = ESPN_KEYS[r.category];
    if (!map) continue;
    const stats: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.stats)) if (map[k]) stats[map[k]] = v;
    const h = headline(r.category, stats);
    const team = r.homeAway === "home" ? home : away;
    const line: BoxLine = { id: r.id, name: r.name, team, category: r.category, stats, headline: h.text, yards: h.yards };
    (byPlayer.get(r.id) ?? byPlayer.set(r.id, []).get(r.id)!).push(line);
    (perTeam.get(team) ?? perTeam.set(team, []).get(team)!).push(line);
  }
  const teams: BoxScore["teams"] = [
    { team: home, homeAway: "home", points: s.home.score, leaders: leadersOf(perTeam.get(home) ?? []) },
    { team: away, homeAway: "away", points: s.away.score, leaders: leadersOf(perTeam.get(away) ?? []) },
  ];
  return { gameId, source: "espn", teams, byPlayer };
}

/* -------------------------------------------------------------- public */

/** Settled box for a game: nflverse when the week is posted, else ESPN's final box. Undefined before the final. */
export function boxScore(gameId: string, names: Map<string, string> = new Map()): Promise<BoxScore | undefined> {
  return memo(`box:${gameId}:${gamelogsStamp()}`, 300, async () => {
    const nv = fromNflverse(gameId, names);
    if (nv && nv.teams.some((t) => t.leaders.length)) return nv;
    const g = gameById(gameId);
    if (!g) return undefined;
    const box = await fromEspn(gameId, g.home, g.away);
    return box && box.teams.some((t) => t.leaders.length) ? box : undefined;
  });
}

export const teamAbbrOf = (nickname: string) => teamByShort(nickname)?.abbr ?? nickname;
