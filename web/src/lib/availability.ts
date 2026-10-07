/**
 * Who is actually playing, priced in points. Server-only.
 *
 * Status, newest source first: ESPN's league injury feed (live through game-day inactives),
 * then the nflverse official report (the Friday designations). Roster moves: nflverse rosters
 * and game lines (a player whose last 2026 line was for another team arrived; one whose last
 * line was for this team and is now elsewhere left), retirements and cuts (departed.json: nflverse
 * status RET or CUT after playing for the team this season), and ESPN's transaction feed, which
 * marks a rostered player out the day he retires, is released or waived, is traded, is suspended,
 * or goes on a reserve list, before nflverse's roster catches up (departures()).
 *
 * The adjustment is measured against the players whose snaps built the team's numbers, so an
 * absence that already showed up in earlier games is not charged twice:
 *
^ *   QB          (expected starter EPA per play - the play-weighted EPA per play of the QBs who built the
 *               this season's snaps) x the team's QB plays per game. EPA per play blends this season
 *               with half of last season and is shrunk toward replacement level with a 200-play prior.
 *               Replacement level is the 25th percentile of QBs with 150+ plays. Times 0.75 (backtest fit), capped at 12.
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
import { genDeparted, genExtras, genGamelogs, genHistory, genMeta, genPlayers, genSchedule, gamelogsStamp, historyStamp, type GenMove, type GenPlayer, type StatLine } from "./generated";
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
  /** ESPN's longer news line (the short one is often just "out" on game day). */
  detail?: string;
  date?: string;
}

export interface Transaction {
  date: string;
  team: string; // nickname
  text: string;
}

const ARRIVES = /\b(signed|re-signed|activated|claimed|acquired|elevated|promoted|reinstated|recalled|designated .* to return|returned)\b/i;
const DEPARTS: [RegExp, string][] = [
  [/retire/i, "Retired"],
  [/\b(released|waived|terminated|cut)\b/i, "Released"],
  [/\btraded\b/i, "Traded"],
  [/\bsuspended\b|exempt list/i, "Suspended"],
  [/\bplaced\b.*\binjured reserve\b/i, "Injured reserve"],
  [/\bplaced\b.*\b(reserve|physically unable|non-football)\b/i, "Reserve list"],
];

/**
 * Rostered players a team's ESPN transactions take away before nflverse's roster catches up (Lane Johnson's retirement
 * sat a day as "active" on the Eagles): retired, released or waived, traded, suspended, or placed on a reserve list.
 * Each sentence is read on its own ("Signed X. Placed Y on injured reserve."), a player's newest sentence wins (re-signed
 * after a release keeps him), and an arrival word wins inside a sentence ("activated from injured reserve"). ESPN stamps a
 * day's moves with one time and lists the newest first, so within a day the feed's own order decides.
 */
export function departures(moves: Transaction[], roster: GenPlayer[]): Map<string, { status: string; source: string; absence: number }> {
  const out = new Map<string, { status: string; source: string; absence: number }>();
  const named = roster
    .map((p) => {
      const parts = p.n.replace(/[’‘]/g, "'").trim().split(/\s+/);
      const last = parts.length > 2 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1)!;
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return parts.length >= 2 ? { p, re: new RegExp(`\\b${esc(parts[0])}\\s+(?:[A-Z]\\.?\\s+)?${esc(last)}\\b`, "i") } : undefined;
    })
    .filter((x): x is { p: GenPlayer; re: RegExp } => Boolean(x));
  const ordered = moves.map((m, i) => ({ m, i })).sort((a, b) => a.m.date.localeCompare(b.m.date) || b.i - a.i).map((x) => x.m);
  for (const m of ordered) {
    for (const sentence of m.text.split(/(?<=\.)\s+/)) {
      for (const { p, re } of named) {
        if (!re.test(sentence)) continue;
        if (ARRIVES.test(sentence)) {
          out.delete(p.id);
          continue;
        }
        const hit = DEPARTS.find(([r]) => r.test(sentence));
        if (hit) out.set(p.id, { status: hit[1], source: `ESPN transactions ${m.date.slice(5, 10)}`, absence: 1 });
      }
    }
  }
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  // 6 s, then the disk copy (cached() below): the game page waits on these.
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(6_000) });
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
          rows.push({ id, name: i.athlete?.displayName ?? "", team, pos: i.athlete?.position?.abbreviation, status: i.status, comment: i.shortComment ?? i.longComment, detail: i.longComment, date: i.date });
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
  if (/^(out|inactive|injured reserve|ir|suspension|suspended|pup|nfi|physically unable|non-football)/.test(s) || /\binactive\b/i.test(comment ?? "")) return 1;
  if (s.startsWith("doubtful")) return 0.85;
  if (s.startsWith("questionable")) return /did not participate/i.test(practice ?? "") ? 0.5 : 0.25;
  return 0;
}

/** ESPN comments that speak to one game only: game-day inactives, in-game exits, a ruling for that day. */
const GAME_DAY = /\binactive\b|won't return|will not return|ruled out|out for (?:the rest of )?(?:sunday|monday|thursday|saturday|friday)/i;

/**
 * Where a game sits in its team's schedule: the cutoff for news about the previous game (its kickoff + 30 h:
 * inactives, in-game exits and the write-ups on them post within a day, and no team plays again inside three)
 * and this game's week.
 */
export interface StatusClock {
  prevEnd?: number;
  week?: number;
}

/** From the schedule's kickoff times, not its scores, so it is right before the next ingest catches up. */
export function statusClock(team: string, kickoff: string): StatusClock {
  const t = Date.parse(kickoff);
  const season = genMeta()?.season;
  let prev: number | undefined;
  let week: number | undefined;
  let weekKick = Infinity;
  for (const g of genSchedule()) {
    if (g.season !== season || (g.home !== team && g.away !== team)) continue;
    const k = Date.parse(g.kickoff);
    if (k < t - 60_000) prev = Math.max(prev ?? k, k);
    else if (k < weekKick) {
      weekKick = k;
      week = g.week;
    }
  }
  return { prevEnd: prev === undefined ? undefined : prev + 30 * 3600_000, week };
}

/**
 * One player's status for one game, freshest source first. An ESPN game-day designation dated inside the
 * previous game's news window was about that game: it falls back to this week's official report, or, with
 * none yet, to questionable (he sat or left last time, nothing since). An official report from an earlier
 * week is not this week's report and is ignored.
 */
/** A status in words that follow a name: "on injured reserve", "out", "inactive", "doubtful". */
export function absentWords(status: string): string {
  const s = status.split(" (")[0].toLowerCase();
  if (s.includes("injured reserve")) return "on injured reserve";
  if (s.includes("physically unable")) return "on the PUP list";
  if (s.includes("non-football")) return "on the NFI list";
  return s;
}

export function playerStatus(p: GenPlayer, e: EspnInjury | undefined, clock: StatusClock): { status: string; source: string; absence: number } {
  const report = p.inj?.st && (clock.week === undefined || p.inj.wk >= clock.week) ? p.inj : undefined;
  if (e) {
    const stale = GAME_DAY.test(e.comment ?? "") && clock.prevEnd !== undefined && e.date !== undefined && Date.parse(e.date) <= clock.prevEnd;
    if (!stale) return { status: /\binactive\b/i.test(e.comment ?? "") ? "Inactive" : e.status, source: "ESPN", absence: absenceOf(e.status, e.comment, report?.pr) };
    if (!report) return { status: "Questionable (out last game, no update since)", source: "ESPN", absence: 0.25 };
  }
  if (report) return { status: report.st!, source: "official report", absence: absenceOf(report.st, null, report.pr) };
  return { status: "Active", source: "", absence: 0 };
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

/** Season weights for a quarterback's track record: this season, last, and three before that. */
const QB_SEASON_WEIGHTS = [1, 0.7, 0.5, 0.35, 0.25];

/** Weighted QB plays and EPA across up to five seasons (this season and last from players.json, older from history.json). */
function qbRecord(p: GenPlayer): { n: number; e: number; seasons: number } {
  const season = genMeta()?.season ?? new Date().getFullYear();
  const hist = genHistory()?.players[p.id] ?? {};
  const lines: (StatLine | null | undefined)[] = [p.s, p.ps, hist[season - 2], hist[season - 3], hist[season - 4]];
  let n = 0;
  let e = 0;
  let seasons = 0;
  lines.forEach((s, i) => {
    const plays = qbPlays(s);
    if (!plays) return;
    n += QB_SEASON_WEIGHTS[i] * plays;
    e += QB_SEASON_WEIGHTS[i] * qbEpa(s);
    seasons++;
  });
  return { n, e, seasons };
}

/** Replacement levels: QB EPA per play, and skill EPA per touch or target by position. */
const levels = () =>
  memoSync(`avail:levels:${gamelogsStamp()}:${historyStamp()}`, 3600, () => {
    const players = genPlayers();
    const qb = players
      .filter((p) => p.pg === "QB")
      .map((p) => qbRecord(p))
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
/**
 * Share of the raw QB difference that goes into the margin. scripts/backtest-qb.mjs on 2022 to 2025
 * (1,139 games, walk-forward): Elo MAE 9.95, Elo + 0.75 x QB 9.88 (best on the grid), full strength 9.90;
 * on the 386 games with a 2+ point QB term, 10.32 to 10.07. It does not improve cover rate against the
 * closing line, which already prices the QB.
 */
const QB_SCALE = 0.75;

/**
 * Shrunk EPA per play for a quarterback over his weighted track record (up to five seasons, recent ones
 * count more). The pull is toward a backup-level QB for a thin record and toward an average QB once he
 * has about 500 weighted plays, so one injured season cannot erase a proven starter.
 */
export function qbEpaPerPlay(p: GenPlayer): { value: number; plays: number } {
  return shrinkQb(qbRecord(p));
}

function shrinkQb(r: { n: number; e: number }): { value: number; plays: number } {
  const { qbRepl, qbMean } = levels();
  const prior = qbRepl + (qbMean - qbRepl) * Math.min(1, r.n / 500);
  return { value: (r.e + prior * QB_PRIOR) / (r.n + QB_PRIOR), plays: Math.round(r.n) };
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
  /** True when he played the team's most recent game: the absence is news, not something the numbers already carry. */
  fresh?: boolean;
}

export interface TeamAvailability {
  team: string;
  /** pts moves the margin (baseline blends last season's QBs, as the Elo does); totalPts moves the model total (baseline is this season's QBs only, as the EPA total is). */
  qb?: { expected: string; expectedEpa: number; baseline: number; baselineQbs: string; playsPerGame: number; pts: number; totalPts: number; note: string; uncertain: boolean };
  items: AvailItem[];
  offense: number; // points this offense loses (negative) or gains
  offenseTotal: number; // the same for the model total: totalPts in place of the QB's pts
  defense: number; // points this defense loses (negative): the opponent scores that many more
  total: number; // offense + defense
  moves: Transaction[];
  /** Week-over-week roster changes from nflverse weekly rosters: joined from another team, signed, promoted, to reserve. */
  rosterMoves: GenMove[];
  /** Every rostered player who is not plainly active, by id: the one status the whole game page uses. */
  statuses: Record<string, { status: string; source: string; absence: number }>;
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

function teamAvailability(team: string, espn: EspnInjury[], moves: Transaction[], clock: StatusClock): TeamAvailability {
  const players = genPlayers();
  const byId = new Map(players.map((p) => [p.id, p]));
  const { games, lastTeam, byTeam } = teamLines();
  const teamGames = games.get(team)?.size ?? 0;
  const lines = byTeam.get(team) ?? [];
  const gamesFor = (id: string) => new Set(lines.filter((l) => l.id === id).map((l) => l.wk)).size;
  // A lineman or defender with no stat line all season has no game lines; his games with snaps stand in.
  const playedFor = (p: GenPlayer) => gamesFor(p.id) || Math.min(p.u?.gs ?? 0, teamGames);
  const teamLastWk = Math.max(0, ...lines.map((l) => l.wk));
  const playedLast = (id: string) => lines.some((l) => l.id === id && l.wk === teamLastWk);
  const espnById = new Map(espn.filter((e) => e.team === team).map((e) => [e.id, e]));
  const roster = players.filter((p) => p.t === team);

  // A retirement, release, trade, or suspension in ESPN's transactions outranks the injury feeds; a reserve placement
  // counts only when those feeds do not already have him out (they carry the injury and its label).
  const departedNow = departures(moves.filter((m) => m.team === team), roster);
  const statusFor = (p: GenPlayer) => {
    const st = playerStatus(p, espnById.get(p.id), clock);
    const tx = departedNow.get(p.id);
    return tx && (!/reserve/i.test(tx.status) || st.absence < 1) ? tx : st;
  };

  const items: AvailItem[] = [];

  // Quarterback: the expected starter against the QBs whose snaps built the team's numbers. The unit edges
  // are this season's; the Elo still carries most of last season, so early in the year the baseline leans on
  // last season's QBs and shifts to this season's as games pile up (this season's weight = games / (games + 6)).
  let qb: TeamAvailability["qb"];
  const qbLines = lines.filter((l) => byId.get(l.id)?.pg === "QB");
  const used = new Map<string, number>();
  for (const l of qbLines) used.set(l.id, (used.get(l.id) ?? 0) + qbPlays(l.s));
  const usedTotal = [...used.values()].reduce((a, b) => a + b, 0);
  if (usedTotal > 0) {
    const valueOf = (id: string, raw?: { n: number; e: number }) => (byId.get(id) ? qbEpaPerPlay(byId.get(id)!).value : raw ? shrinkQb(raw).value : levels().qbRepl);
    const nowMix = [...used.entries()].reduce((a, [id, n]) => a + valueOf(id) * n, 0) / usedTotal;
    const prevRows = Object.entries(genHistory()?.teamQb[String((genMeta()?.season ?? 0) - 1)]?.[team] ?? {});
    const prevTotal = prevRows.reduce((a, [, r]) => a + r.n, 0);
    const prevMix = prevTotal ? prevRows.reduce((a, [id, r]) => a + valueOf(id, r) * r.n, 0) / prevTotal : undefined;
    const wNow = prevMix === undefined ? 1 : teamGames / (teamGames + 6);
    const baseline = wNow * nowMix + (1 - wNow) * (prevMix ?? nowMix);
    const share = (rows: [string, number][], total: number) => [...rows].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} ${Math.round((n / total) * 100)}%`).join(", ");
    const baselineQbs = [
      `this season ${share([...used.entries()].map(([id, n]) => [byId.get(id)?.n ?? id, n]), usedTotal)}`,
      prevMix !== undefined ? `last season ${share(prevRows.map(([, r]) => [r.name, r.n]), prevTotal)}` : "",
    ].filter(Boolean).join("; ") + (prevMix !== undefined ? `; weighted ${Math.round(wNow * 100)}/${Math.round((1 - wNow) * 100)}` : "");
    const playsPerGame = usedTotal / Math.max(1, teamGames);
    const candidates = roster
      .filter((p) => p.pg === "QB")
      .map((p) => ({ p, st: statusFor(p) }))
      .sort((a, b) => (a.p.dc?.rank ?? 99) - (b.p.dc?.rank ?? 99) || (used.get(b.p.id) ?? 0) - (used.get(a.p.id) ?? 0));
    // Questionable counts as healthy even with no final-day practice (0.5): he is blended with the backup, not benched.
    const healthy = candidates.filter((c) => c.st.absence <= 0.5);
    const first = healthy[0];
    if (first) {
      const firstEpa = qbEpaPerPlay(first.p).value;
      const next = healthy[1];
      const q = first.st.absence; // 0, or 0.25 to 0.5 when questionable
      const expectedEpa = next && q > 0 ? (1 - q) * firstEpa + q * qbEpaPerPlay(next.p).value : firstEpa;
      const clampQb = (x: number) => Math.max(-12, Math.min(12, round1(x * playsPerGame * QB_SCALE)));
      const pts = clampQb(expectedEpa - baseline);
      // The model total is built from this season's EPA only, which already carries this season's QBs.
      const totalPts = clampQb(expectedEpa - nowMix);
      const sat = candidates.filter((c) => c.st.absence > 0.5 && (used.get(c.p.id) ?? 0) > 0);
      const arrived = lastTeam.get(first.p.id) && lastTeam.get(first.p.id)!.team !== team;
      const why = [
        `${first.p.n} expected to start${q > 0 ? ` (${first.st.status}; ${Math.round(q * 100)}% chance ${next?.p.n ?? "the backup"} plays)` : ""}`,
        ...sat.map((c) => `${c.p.n} ${c.st.status.toLowerCase()} (${c.st.source})`),
        arrived ? `new from the ${lastTeam.get(first.p.id)!.team}` : "",
        `${round3(expectedEpa)} EPA a play over his track record against ${round3(baseline)} for the QBs who built the team's numbers (${baselineQbs})`,
        `at ${round1(playsPerGame)} QB plays a game, scaled ${QB_SCALE} (fit on 2022 to 2025)`,
      ].filter(Boolean);
      qb = { expected: first.p.n, expectedEpa: round3(expectedEpa), baseline: round3(baseline), baselineQbs, playsPerGame: round1(playsPerGame), pts, totalPts, note: why.join("; "), uncertain: q > 0 };
      if (Math.abs(pts) >= 0.5) items.push({ id: first.p.id, name: first.p.n, pos: "QB", side: "offense", kind: "qb", status: q > 0 ? first.st.status : "Starts", source: first.st.source || "depth chart", absence: 0, weight: 1, pts, note: why.join("; "), measured: true });
    }
  }

  // Everyone else who is out, doubtful, or questionable, weighted by games played and the chance he sits.
  for (const p of roster) {
    if (p.pg === "QB" || p.pg === "K" || p.pg === "P" || p.pg === "LS") continue;
    const st = statusFor(p);
    if (st.absence <= 0) continue;
    const played = playedFor(p);
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
      fresh: playedLast(p.id),
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

  // Retired or cut in season and on no roster now (departed.json): he built the team's numbers in the games he played,
  // so his absence is charged like a trade's. Quarterbacks are already in the QB baseline.
  for (const p of genDeparted()) {
    if (p.t !== team || p.pg === "QB") continue;
    const played = playedFor(p);
    if (!played || !teamGames) continue;
    const v = playerValue(p);
    if (!v || v.pts <= 0) continue;
    const weight = Math.min(1, played / teamGames);
    const pts = -round1(v.pts * weight);
    if (pts === 0) continue;
    const retired = p.r.status === "RET";
    items.push({ id: p.id, name: p.n, pos: p.p ?? p.pg ?? "", side: ["OL", "RB", "WR", "TE"].includes(p.pg ?? "") ? "offense" : "defense", kind: "left", status: retired ? "retired" : "released", source: "nflverse roster", absence: 1, weight: round1(weight), pts, note: `${v.basis}; played ${played} of ${teamGames} before he ${retired ? "retired" : "was released"}`, measured: v.measured, fresh: playedLast(p.id) });
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
  const skill = cap(items.filter((i) => i.side === "offense" && i.kind !== "qb").reduce((a, b) => a + b.pts, 0));
  const offense = round1((qb?.pts ?? 0) + skill);
  const offenseTotal = round1((qb?.totalPts ?? 0) + skill);
  const statuses: TeamAvailability["statuses"] = {};
  for (const p of roster) {
    const st = statusFor(p);
    if (st.status !== "Active") statuses[p.id] = st;
  }
  const defense = round1(cap(items.filter((i) => i.side === "defense").reduce((a, b) => a + b.pts, 0)));
  items.sort((a, b) => a.pts - b.pts);
  return { team, qb, items, offense, offenseTotal, defense, total: round1(offense + defense), moves: moves.filter((m) => m.team === team).slice(0, 8), rosterMoves: (genExtras()?.moves ?? []).filter((m) => m.team === team).slice(0, 10), statuses };
}

/** Both teams for one game. Never throws: missing feeds fall back to the official report and say so. */
export async function gameAvailability(home: string, away: string, kickoff: string): Promise<GameAvailability> {
  const [inj, tx] = await Promise.all([espnInjuries(), espnTransactions()]);
  const notes: string[] = [];
  if (inj.error) notes.push(`${inj.error}. Using the official report only.`);
  if (tx.error) notes.push(tx.error);
  const sources = [inj.rows.length ? `ESPN injuries ${new Date(inj.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET` : "", "nflverse official report", "nflverse rosters and depth charts", tx.rows.length ? "ESPN transactions" : ""].filter(Boolean);
  return { home: teamAvailability(home, inj.rows, tx.rows, statusClock(home, kickoff)), away: teamAvailability(away, inj.rows, tx.rows, statusClock(away, kickoff)), asOf: inj.at, sources, notes };
}
