/**
 * Work left open when a back, receiver, or tight end is out, and who took it the last times he sat. Server-only.
 *
 *   share:   his snap share, target share, carry share, and air yards share, averaged over his games this season
 *   without: the games his team played without him, this season (after his first game) and last season (between his
 *            first and last game for the team), and each healthy teammate's targets, carries, and DK points a game in
 *            those games against the games they played together. Risers are ranked by the work he leaves: targets
 *            gained when a receiver or tight end sits, carries plus targets when a back sits.
 *
 * Inputs: gamelogs.json (this season, including snap-only lines) and history-games.json (last season: stat rows only, so
 * a teammate's zero-stat game reads as a game he did not play and drops out of both averages). The games count is shown
 * with every number: two games is a hint, not a pattern.
 */
import { dkPoints } from "./dfs";
import { gamelogsStamp, genGamelogs, genHistoryGames, genMeta, genPlayers, genSchedule, historyGamesStamp, type StatLine } from "./generated";
import { memoSync } from "./memo";

export interface Usage {
  tgt: number;
  ra: number;
  dk: number;
}

export interface Riser {
  id: string;
  name: string;
  pos: string;
  withG: number;
  withoutG: number;
  with: Usage;
  without: Usage;
}

export interface Vacated {
  id: string;
  name: string;
  pos: string;
  status: string;
  /** His averages in his games this season (shares 0 to 1). */
  share: { games: number; snaps?: number; tgt: number; car: number; air: number };
  /** The games without him and who gained; undefined when he has not missed a game in the window. */
  without?: { games: { season: number; wk: number }[]; risers: Riser[] };
}

const SKILL = new Set(["RB", "WR", "TE"]);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Work left open by each skill player in `out` (ids with their status) for one team. Memoized per ingest. */
export function vacatedFor(team: string, out: { id: string; status: string }[]): Vacated[] {
  if (!genGamelogs() || !out.length) return [];
  const key = out.map((o) => `${o.id}:${o.status}`).sort().join(",");
  return memoSync(`vacated:${team}:${key}:${gamelogsStamp()}:${historyGamesStamp()}`, 3600, () => build(team, out));
}

function build(team: string, out: { id: string; status: string }[]): Vacated[] {
  const logs = genGamelogs()!;
  const hist = genHistoryGames();
  const season = genMeta()?.season ?? new Date().getFullYear();
  const prev = season - 1;
  const players = new Map(genPlayers().map((p) => [p.id, p]));
  const sched = new Map(genSchedule().map((g) => [g.id, g]));
  const outIds = new Set(out.map((o) => o.id));

  // The team's games: this season's posted games, last season's played regular-season games. Key = ESPN game id.
  const games = new Map<string, { season: number; wk: number }>();
  for (const [g, x] of Object.entries(logs.games)) if (x.home === team || x.away === team) games.set(g, { season, wk: x.wk });
  for (const g of sched.values()) if (g.season === prev && g.type === "REG" && g.played && (g.home === team || g.away === team)) games.set(g.id, { season: prev, wk: g.week });

  // Each player's games for this team: game id -> usage. This season from the game logs, last season from history rows.
  const usageOf = (pid: string): Map<string, Usage> => {
    const m = new Map<string, Usage>();
    for (const l of logs.players[pid] ?? []) if (l.t === team && games.has(l.g)) m.set(l.g, { tgt: l.s.tgt ?? 0, ra: l.s.ra ?? 0, dk: dkPoints(l.s) });
    if (hist) {
      for (const row of hist.players[pid] ?? []) {
        const v = Object.fromEntries(hist.cols.map((c, i) => [c, row[i]])) as Record<string, string | number>;
        const g = String(v.g);
        if (v.t !== team || games.get(g)?.season !== prev) continue;
        const s = Object.fromEntries(Object.entries(v).filter(([k]) => k !== "g" && k !== "t")) as StatLine;
        m.set(g, { tgt: s.tgt ?? 0, ra: s.ra ?? 0, dk: dkPoints(s) });
      }
    }
    return m;
  };

  const result: Vacated[] = [];
  for (const o of out) {
    const p = players.get(o.id);
    if (!p || !SKILL.has(p.pg ?? "")) continue;
    const lines = (logs.players[o.id] ?? []).filter((l) => l.t === team);
    if (!lines.length) continue; // nothing of his to leave open this season
    const snaps = lines.map((l) => l.sn?.o).filter((x): x is number => x !== undefined);
    const share = {
      games: lines.length,
      snaps: snaps.length ? mean(snaps) : undefined,
      tgt: mean(lines.map((l) => l.s.tshare ?? 0)),
      car: mean(lines.map((l) => l.s.rshare ?? 0)),
      air: mean(lines.map((l) => l.s.ayshare ?? 0)),
    };

    // The games he missed: this season after his first game; last season between his first and last game for the team.
    const mine = usageOf(o.id);
    const missed = new Set<string>();
    for (const s of [season, prev]) {
      const weeks = [...mine.keys()].map((g) => games.get(g)!).filter((x) => x.season === s).map((x) => x.wk);
      if (!weeks.length) continue;
      const first = Math.min(...weeks);
      const last = s === season ? Infinity : Math.max(...weeks);
      for (const [g, x] of games) if (x.season === s && x.wk > first && x.wk < last && !mine.has(g)) missed.add(g);
    }

    let without: Vacated["without"];
    // The work he leaves: targets for a receiver or tight end, carries plus targets for a back.
    const work = (x: Usage) => (p.pg === "RB" ? x.ra + x.tgt : x.tgt);
    if (missed.size) {
      const risers: Riser[] = [];
      for (const q of players.values()) {
        if (q.t !== team || q.id === o.id || outIds.has(q.id) || !SKILL.has(q.pg ?? "")) continue;
        const u = usageOf(q.id);
        const withG = [...u.entries()].filter(([g]) => mine.has(g)).map(([, x]) => x);
        const withoutG = [...u.entries()].filter(([g]) => missed.has(g)).map(([, x]) => x);
        if (withG.length < 2 || !withoutG.length) continue;
        const avg = (xs: Usage[]): Usage => ({ tgt: r1(mean(xs.map((x) => x.tgt))), ra: r1(mean(xs.map((x) => x.ra))), dk: r1(mean(xs.map((x) => x.dk))) });
        const w = avg(withG);
        const wo = avg(withoutG);
        if (work(wo) - work(w) < 1) continue;
        risers.push({ id: q.id, name: q.n, pos: q.p ?? q.pg ?? "", withG: withG.length, withoutG: withoutG.length, with: w, without: wo });
      }
      risers.sort((a, b) => work(b.without) - work(b.with) - (work(a.without) - work(a.with)) || b.without.dk - b.with.dk - (a.without.dk - a.with.dk));
      without = { games: [...missed].map((g) => games.get(g)!).sort((a, b) => a.season - b.season || a.wk - b.wk), risers: risers.slice(0, 3) };
    }
    result.push({ id: o.id, name: p.n, pos: p.p ?? p.pg ?? "", status: o.status, share, without });
  }
  return result;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "38% of the carries, 9% of the targets, 46% of the snaps" (pieces under 3% left out); `touches` keeps carries and targets only. */
export function shareText(v: Vacated, touches = false): string {
  const parts: string[] = [];
  if (v.share.car >= 0.03) parts.push(`${pct(v.share.car)} of the carries`);
  if (v.share.tgt >= 0.03) parts.push(`${pct(v.share.tgt)} of the targets`);
  if (touches) return parts.join(" and ");
  if (v.share.air >= 0.03) parts.push(`${pct(v.share.air)} of the air yards`);
  if (v.share.snaps !== undefined) parts.push(`${pct(v.share.snaps)} of the snaps`);
  return parts.join(", ");
}

/** "2025 W12-W13, 2026 W2" for the games without him. */
export function gamesText(gs: { season: number; wk: number }[]): string {
  const by = new Map<number, number[]>();
  for (const g of gs) (by.get(g.season) ?? by.set(g.season, []).get(g.season)!).push(g.wk);
  return [...by.entries()].map(([s, wks]) => `${s} W${wks.join(", W")}`).join("; ");
}

/** "10.3 targets a game, up from 8.1" (a receiver's targets) or "16 carries and 2 targets a game, up from 9.5 and 1" (a back's). */
export function riserShort(r: Riser, outPos: string): string {
  if (outPos !== "RB") return `${r.without.tgt} targets a game, up from ${r.with.tgt}`;
  return `${r.without.ra} carries and ${r.without.tgt} targets a game, up from ${r.with.ra} and ${r.with.tgt}`;
}

/** "16 carries and 2 targets a game, 18.2 DK (with him: 9.5 and 3, 8.1 DK)". */
export function riserText(r: Riser): string {
  const u = (x: Usage) => {
    const bits = [x.ra >= 1 ? `${x.ra} carries` : "", x.tgt >= 1 ? `${x.tgt} targets` : ""].filter(Boolean);
    return `${bits.join(" and ") || "no touches"}`;
  };
  return `${u(r.without)} a game, ${r.without.dk} DK (with him: ${u(r.with)}, ${r.with.dk} DK)`;
}
