/**
 * Who is actually playing, priced in points. Server-only.
 *
 * Status, newest source first: ESPN's league injury feed (live through game-day inactives),
 * then the nflverse official report (the Friday designations). Roster moves: nflverse rosters
 * and game lines (a player whose last 2026 line was for another team arrived; one whose last
 * line was for this team and is now elsewhere left), plus ESPN's transaction feed for context.
 *
 * The adjustment is measured against the players whose snaps built the team's numbers, so an
 * absence that already showed up in earlier games is not charged twice:
 *
 *   QB          (expected starter EPA per play - the play-weighted EPA per play of the QBs who took
 *               this season's snaps) x the team's QB plays per game. EPA per play blends this season
 *               with half of last season and is shrunk toward replacement level with a 200-play prior.
 *               Replacement level is the 25th percentile of QBs with 150+ plays. Capped at 12.
 *   RB WR TE    (his EPA per touch or target - the 25th percentile at the position) x his plays per
 *               game x 0.5 (credit shared with the quarterback and the line), capped at 3.
 *   OL DL LB DB fixed value for a full-time starter: OL 0.4, DL 0.4, LB 0.25, CB 0.4, S 0.25 points,
 *               times snap share; pass rushers with 1.5+ QB hits a game count 1.5x. These are
 *               assumptions, not measurements, and the page labels them that way.
 *
 * Every non-QB charge is weighted by the share of the team's games he played (out since week 1
 * means the team's numbers already lack him) and by the chance he sits: Out, IR, suspended,
 * inactive 1; Doubtful 0.85; Questionable 0.25, or 0.5 when he did not practice on the final day.
 * Offense and defense are each capped at 4 points before the QB term.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { genGamelogs, genPlayers, gamelogsStamp, type GenPlayer, type StatLine } from "./generated";
import { memo, memoSync } from "./memo";
import { nflTeams } from "./nfl";

const CACHE_DIR = path.join(process.cwd(), "data", "espn");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/* ------------------------------------------------------------ feeds */

export interface EspnInjury {
  id: string; // ESPN athlete id, the same id the app uses for players
  name: string;
  team: string; // nickname
  pos?: string;
  status: string; // Out, Doubtful, Questionable, Injured Reserve, Active, Suspension ...
  comment?: string;
  date?: string;
}

export interface Transaction {
  date: string;
  team: string; // nickname
  text: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ESPN answered ${res.status}`);
  return (await res.json()) as T;
}

function cached<T>(file: string, fresh: () => Promise<T>): Promise<T> {
  const f = path.join(CACHE_DIR, file);
  return fresh()
    .then((v) => {
      try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(f, JSON.stringify(v));
      } catch {
        /* the disk copy is a fallback only */
      }
      return v;
    })
    .catch((err) => {
      if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as T;
      throw err;
    });
}

const teamByName = () => new Map(nflTeams().flatMap((t) => [[t.name, t.short] as const, [t.abbr, t.short] as const, [t.code, t.short] as const]));

/** League-wide injury list from ESPN, 10 minutes. Empty on failure with no disk copy. */
export function espnInjuries(): Promise<{ at: string; rows: EspnInjury[]; error?: string }> {
  return memo("espn:injuries", 600, () =>
    cached("injuries.json", async () => {
      type Raw = { injuries: { displayName: string; injuries: { status: string; shortComment?: string; longComment?: string; date?: string; athlete?: { displayName?: string; position?: { abbreviation?: string }; links?: { href: string }[] } }[] }[] };
      const j = await getJson<Raw>("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries");
      const names = teamByName();
      const rows: EspnInjury[] = [];
      for (const t of j.injuries ?? []) {
        const team = names.get(t.displayName);
        if (!team) continue;
        for (const i of t.injuries ?? []) {
          const id = i.athlete?.links?.map((l) => /\/id\/(\d+)/.exec(l.href)?.[1]).find(Boolean);
          if (!id) continue;
          rows.push({ id, name: i.athlete?.displayName ?? "", team, pos: i.athlete?.position?.abbreviation, status: i.status, comment: i.shortComment ?? i.longComment, date: i.date });
        }
      }
      return { at: new Date().toISOString(), rows };
    }),
  ).catch((err: Error) => ({ at: new Date().toISOString(), rows: [], error: `ESPN injuries unavailable: ${err.message}` }));
}

/** The last 200 league transactions from ESPN (about two weeks in season), 30 minutes. */
export function espnTransactions(): Promise<{ at: string; rows: Transaction[]; error?: string }> {
  return memo("espn:transactions", 1800, () =>
    cached("transactions.json", async () => {
      type Raw = { transactions: { date: string; description: string; team: { abbreviation: string } }[] };
      const j = await getJson<Raw>("https://site.api.espn.com/apis/site/v2/sports/football/nfl/transactions?limit=200");
      const names = teamByName();
      return {
        at: new Date().toISOString(),
        rows: (j.transactions ?? []).flatMap((t) => {
          const team = names.get(t.team?.abbreviation);
          return team ? [{ date: t.date, team, text: t.description }] : [];
        }),
      };
    }),
  ).catch((err: Error) => ({ at: new Date().toISOString(), rows: [], error: `ESPN transactions unavailable: ${err.message}` }));
}

/* ------------------------------------------------------------ status */

/** Chance he does not play, from a status string and the final practice line. */
export function absenceOf(status: string | null | undefined, comment?: string | null, practice?: string | null): number {
  if (!status) return 0;
  const s = status.toLowerCase();
  if (s === "active") return 0;
  if (/^(out|inactive|injured reserve|ir|suspension|suspended|pup|nfi|physically unable|non-football)/.test(s) || /inactive/i.test(comment ?? "")) return 1;
  if (s.startsWith("doubtful")) return 0.85;
  if (s.startsWith("questionable")) return /did not participate/i.test(practice ?? "") ? 0.5 : 0.25;
  return 0;
}

/* ------------------------------------------------------------ values */

const num = (s: StatLine | null | undefined, k: string) => s?.[k] ?? 0;
const qbPlays = (s: StatLine | null | undefined) => num(s, "pa") + num(s, "sks") + num(s, "ra");
const qbEpa = (s: StatLine | null | undefined) => num(s, "pepa") + num(s, "repa");
const skillPlays = (s: StatLine | null | undefined) => num(s, "tgt") + num(s, "ra");
const skillEpa = (s: StatLine | null | undefined) => num(s, "rcepa") + num(s, "repa");

function pctile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

/** Replacement levels: QB EPA per play, and skill EPA per touch or target by position. */
const levels = () =>
  memoSync(`avail:levels:${gamelogsStamp()}`, 3600, () => {
    const players = genPlayers();
    const qb = players
      .filter((p) => p.pg === "QB")
      .map((p) => ({ n: qbPlays(p.s) + qbPlays(p.ps), e: qbEpa(p.s) + qbEpa(p.ps) }))
      .filter((r) => r.n >= 150)
      .map((r) => r.e / r.n);
    const skill: Record<string, number> = {};
    for (const pos of ["RB", "WR", "TE"]) {
      skill[pos] = pctile(
        players
          .filter((p) => p.pg === pos)
          .map((p) => ({ n: skillPlays(p.s) + skillPlays(p.ps), e: skillEpa(p.s) + skillEpa(p.ps) }))
          .filter((r) => r.n >= 30)
          .map((r) => r.e / r.n),
        0.25,
      );
    }
    return { qbRepl: pctile(qb, 0.25), qbMean: qb.reduce((a, b) => a + b, 0) / Math.max(1, qb.length), skill };
  });

const QB_PRIOR = 200;

/** Shrunk EPA per play for a quarterback: this season plus half of last season, pulled toward replacement. */
export function qbEpaPerPlay(p: GenPlayer): { value: number; plays: number } {
  const { qbRepl } = levels();
  const n = qbPlays(p.s) + 0.5 * qbPlays(p.ps);
  const e = qbEpa(p.s) + 0.5 * qbEpa(p.ps);
  return { value: (e + qbRepl * QB_PRIOR) / (n + QB_PRIOR), plays: Math.round(n) };
}

const FIXED: Record<string, number> = { OL: 0.4, DL: 0.4, LB: 0.25, CB: 0.4, S: 0.25 };
function fixedGroup(p: GenPlayer): string | undefined {
  if (p.pg === "OL") return "OL";
  if (p.pg === "DL") return "DL";
  if (p.pg === "LB") return "LB";
  if (p.pg === "DB") return /^(CB|DB)$/.test(p.p ?? "") ? "CB" : "S";
  return undefined;
}

/** Points a game this player is worth over a replacement, with the basis in words. QBs are handled separately. */
function playerValue(p: GenPlayer): { pts: number; basis: string; measured: boolean } | undefined {
  const { skill } = levels();
  if (p.pg === "RB" || p.pg === "WR" || p.pg === "TE") {
    const useThis = (p.s?.gp ?? 0) >= 2;
    const s = useThis ? p.s : p.ps;
    const gp = s?.gp ?? 0;
    const plays = skillPlays(s);
    if (!gp || plays < 8) return undefined;
    const per = skillEpa(s) / plays;
    const over = (per - skill[p.pg]) * (plays / gp) * 0.5;
    if (over <= 0) return { pts: 0, basis: `${round3(per)} EPA a touch or target, at or below replacement`, measured: true };
    return { pts: Math.min(3, round1(over)), basis: `${round3(per)} EPA a touch or target on ${round1(plays / gp)} a game${useThis ? "" : " last season"}`, measured: true };
  }
  const g = fixedGroup(p);
  if (!g) return undefined;
  const snap = (g === "OL" ? p.u?.o : p.u?.d) ?? 0;
  if (snap < 0.5) return undefined;
  const hits = (p.s?.hur ?? 0) / Math.max(1, p.s?.gp ?? 1);
  const rusher = (g === "DL" || g === "LB") && hits >= 1.5;
  const pts = round1(FIXED[g] * snap * (rusher ? 1.5 : 1));
  return { pts, basis: `starter value ${FIXED[g]} for ${g}${rusher ? ", 1.5x as a pass rusher" : ""} at ${Math.round(snap * 100)}% of snaps (assumed, not measured)`, measured: false };
}

/* ------------------------------------------------------------- teams */

export interface AvailItem {
  id: string;
  name: string;
  pos: string;
  side: "offense" | "defense";
  kind: "qb" | "out" | "left" | "arrived";
  status: string;
  source: string; // "ESPN" | "official report" | "roster"
  absence: number; // 0..1
  weight: number; // share of the team's games he played
  pts: number; // signed: negative hurts this team
  note: string;
  measured: boolean;
}

export interface TeamAvailability {
  team: string;
  qb?: { expected: string; expectedEpa: number; baseline: number; baselineQbs: string; playsPerGame: number; pts: number; note: string; uncertain: boolean };
  items: AvailItem[];
  offense: number; // points this offense loses (negative) or gains
  defense: number; // points this defense loses (negative): the opponent scores that many more
  total: number; // offense + defense
  moves: Transaction[];
}

export interface GameAvailability {
  home: TeamAvailability;
  away: TeamAvailability;
  asOf: string;
  sources: string[];
  notes: string[];
}

/** Lines per team this season: which players took snaps for whom, and how many games each team has played. */
const teamLines = () =>
  memoSync(`avail:lines:${gamelogsStamp()}`, 3600, () => {
    const logs = genGamelogs();
    const games = new Map<string, Set<string>>();
    const lastTeam = new Map<string, { team: string; wk: number }>();
    const byTeam = new Map<string, { id: string; s: StatLine; wk: number }[]>();
    if (logs) {
      for (const [gid, g] of Object.entries(logs.games)) {
        if (g.st !== "regular" || g.hp == null) continue;
        for (const t of [g.home, g.away]) games.set(t, (games.get(t) ?? new Set()).add(gid));
      }
      for (const [id, lines] of Object.entries(logs.players)) {
        for (const l of lines) {
          if (l.st !== "regular") continue;
          const arr = byTeam.get(l.t) ?? [];
          arr.push({ id, s: l.s, wk: l.wk });
          byTeam.set(l.t, arr);
          const prev = lastTeam.get(id);
          if (!prev || l.wk >= prev.wk) lastTeam.set(id, { team: l.t, wk: l.wk });
        }
      }
    }
    return { games, lastTeam, byTeam };
  });

function teamAvailability(team: string, espn: EspnInjury[], moves: Transaction[]): TeamAvailability {
  const players = genPlayers();
  const byId = new Map(players.map((p) => [p.id, p]));
  const { games, lastTeam, byTeam } = teamLines();
  const teamGames = games.get(team)?.size ?? 0;
  const lines = byTeam.get(team) ?? [];
  const gamesFor = (id: string) => new Set(lines.filter((l) => l.id === id).map((l) => l.wk)).size;
  const espnById = new Map(espn.filter((e) => e.team === team).map((e) => [e.id, e]));
  const roster = players.filter((p) => p.t === team);

  const statusFor = (p: GenPlayer) => {
    const e = espnById.get(p.id);
    if (e) return { status: /inactive/i.test(e.comment ?? "") ? "Inactive" : e.status, source: "ESPN", absence: absenceOf(e.status, e.comment, p.inj?.pr) };
    if (p.inj?.st) return { status: p.inj.st, source: "official report", absence: absenceOf(p.inj.st, null, p.inj.pr) };
    return { status: "Active", source: "", absence: 0 };
  };

  const items: AvailItem[] = [];

  // Quarterback: the expected starter against the QBs whose snaps built this season's numbers.
  let qb: TeamAvailability["qb"];
  const qbLines = lines.filter((l) => byId.get(l.id)?.pg === "QB");
  const used = new Map<string, number>();
  for (const l of qbLines) used.set(l.id, (used.get(l.id) ?? 0) + qbPlays(l.s));
  const usedTotal = [...used.values()].reduce((a, b) => a + b, 0);
  if (usedTotal > 0) {
    const baseline = [...used.entries()].reduce((a, [id, n]) => a + (byId.get(id) ? qbEpaPerPlay(byId.get(id)!).value * n : 0), 0) / usedTotal;
    const baselineQbs = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${byId.get(id)?.n ?? id} ${Math.round((n / usedTotal) * 100)}%`).join(", ");
    const playsPerGame = usedTotal / Math.max(1, teamGames);
    const candidates = roster
      .filter((p) => p.pg === "QB")
      .map((p) => ({ p, st: statusFor(p) }))
      .sort((a, b) => (a.p.dc?.rank ?? 99) - (b.p.dc?.rank ?? 99) || (used.get(b.p.id) ?? 0) - (used.get(a.p.id) ?? 0));
    const healthy = candidates.filter((c) => c.st.absence < 0.5);
    const first = healthy[0];
    if (first) {
      const firstEpa = qbEpaPerPlay(first.p).value;
      const next = healthy[1];
      const q = first.st.absence; // 0, or 0.25 when questionable
      const expectedEpa = next && q > 0 ? (1 - q) * firstEpa + q * qbEpaPerPlay(next.p).value : firstEpa;
      const pts = Math.max(-12, Math.min(12, round1((expectedEpa - baseline) * playsPerGame)));
      const sat = candidates.filter((c) => c.st.absence >= 0.5 && (used.get(c.p.id) ?? 0) > 0);
      const arrived = lastTeam.get(first.p.id) && lastTeam.get(first.p.id)!.team !== team;
      const why = [
        `${first.p.n} expected to start${q > 0 ? ` (${first.st.status}; ${Math.round(q * 100)}% chance ${next?.p.n ?? "the backup"} plays)` : ""}`,
        ...sat.map((c) => `${c.p.n} ${c.st.status.toLowerCase()} (${c.st.source})`),
        arrived ? `new from the ${lastTeam.get(first.p.id)!.team}` : "",
        `${round3(expectedEpa)} EPA a play against ${round3(baseline)} for this season's QB snaps (${baselineQbs})`,
        `at ${round1(playsPerGame)} QB plays a game`,
      ].filter(Boolean);
      qb = { expected: first.p.n, expectedEpa: round3(expectedEpa), baseline: round3(baseline), baselineQbs, playsPerGame: round1(playsPerGame), pts, note: why.join("; "), uncertain: q > 0 };
      if (Math.abs(pts) >= 0.5) items.push({ id: first.p.id, name: first.p.n, pos: "QB", side: "offense", kind: "qb", status: q > 0 ? first.st.status : "Starts", source: first.st.source || "depth chart", absence: 0, weight: 1, pts, note: why.join("; "), measured: true });
    }
  }

  // Everyone else who is out, doubtful, or questionable, weighted by games played and the chance he sits.
  for (const p of roster) {
    if (p.pg === "QB" || p.pg === "K" || p.pg === "P" || p.pg === "LS") continue;
    const st = statusFor(p);
    if (st.absence <= 0) continue;
    const played = gamesFor(p.id);
    if (!played || !teamGames) continue;
    const v = playerValue(p);
    if (!v) continue;
    const weight = Math.min(1, played / teamGames);
    const pts = -round1(v.pts * weight * st.absence) || 0;
    // A regular who is out but measures at replacement level stays on the list with no charge, so the page shows the model saw him.
    if (pts === 0 && st.absence < 0.85) continue;
    items.push({
      id: p.id,
      name: p.n,
      pos: p.p ?? p.pg ?? "",
      side: ["OL", "RB", "WR", "TE"].includes(p.pg ?? "") ? "offense" : "defense",
      kind: "out",
      status: st.status,
      source: st.source,
      absence: st.absence,
      weight: round1(weight),
      pts,
      note: pts === 0 ? `${v.basis}; no adjustment` : `${v.basis}; played ${played} of ${teamGames}; ${Math.round(st.absence * 100)}% chance he sits`,
      measured: v.measured,
    });
  }

  // Left the team in season: his last 2026 line was here, he is on another roster now.
  for (const [id, last] of lastTeam) {
    if (last.team !== team) continue;
    const p = byId.get(id);
    if (!p || p.t === team || p.pg === "QB" || !p.t) continue;
    const v = playerValue(p);
    if (!v || v.pts <= 0) continue;
    const weight = Math.min(1, gamesFor(id) / Math.max(1, teamGames));
    const pts = -round1(v.pts * weight);
    if (pts === 0) continue;
    items.push({ id, name: p.n, pos: p.p ?? p.pg ?? "", side: ["OL", "RB", "WR", "TE"].includes(p.pg ?? "") ? "offense" : "defense", kind: "left", status: `now with the ${p.t}`, source: "roster", absence: 1, weight: round1(weight), pts, note: `${v.basis}; played ${gamesFor(id)} of ${teamGames} here before the move`, measured: v.measured });
  }

  // Arrived in season and listed as a starter: half his value (new playbook, new teammates).
  for (const p of roster) {
    if (p.pg === "QB") continue;
    const last = lastTeam.get(p.id);
    if (!last || last.team === team || (p.dc?.rank ?? 99) !== 1) continue;
    if (statusFor(p).absence >= 0.5) continue;
    const v = playerValue(p);
    if (!v || v.pts <= 0) continue;
    const pts = round1(v.pts * 0.5);
    if (pts === 0) continue;
    items.push({ id: p.id, name: p.n, pos: p.p ?? p.pg ?? "", side: ["OL", "RB", "WR", "TE"].includes(p.pg ?? "") ? "offense" : "defense", kind: "arrived", status: `new from the ${last.team}`, source: "roster", absence: 0, weight: 0.5, pts, note: `${v.basis}; first on the depth chart, counted at half while he learns the system`, measured: v.measured });
  }

  const cap = (x: number) => Math.max(-4, Math.min(4, x));
  const offense = round1((qb?.pts ?? 0) + cap(items.filter((i) => i.side === "offense" && i.kind !== "qb").reduce((a, b) => a + b.pts, 0)));
  const defense = round1(cap(items.filter((i) => i.side === "defense").reduce((a, b) => a + b.pts, 0)));
  items.sort((a, b) => a.pts - b.pts);
  return { team, qb, items, offense, defense, total: round1(offense + defense), moves: moves.filter((m) => m.team === team).slice(0, 8) };
}

/** Both teams for one game. Never throws: missing feeds fall back to the official report and say so. */
export async function gameAvailability(home: string, away: string): Promise<GameAvailability> {
  const [inj, tx] = await Promise.all([espnInjuries(), espnTransactions()]);
  const notes: string[] = [];
  if (inj.error) notes.push(`${inj.error}. Using the official report only.`);
  if (tx.error) notes.push(tx.error);
  const sources = [inj.rows.length ? `ESPN injuries ${new Date(inj.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET` : "", "nflverse official report", "nflverse rosters and depth charts", tx.rows.length ? "ESPN transactions" : ""].filter(Boolean);
  return { home: teamAvailability(home, inj.rows, tx.rows), away: teamAvailability(away, inj.rows, tx.rows), asOf: inj.at, sources, notes };
}
