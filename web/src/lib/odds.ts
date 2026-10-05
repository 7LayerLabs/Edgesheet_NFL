/**
 * Line movement, closing lines, and player props from The Odds API.
 * Server-only (node:fs). Pure logic lives in odds-core.mjs so the cron script
 * shares it; this file adds the key, the memo, the request throttle, and the
 * Game-facing summary.
 *
 * Budget: the free tier is 500 credits a month and a slate call costs 3
 * (three markets, one region). The page path only refreshes when the newest
 * snapshot is older than ODDS_PAGE_INTERVAL_MIN (default 90) and the quota has
 * more than ODDS_RESERVE (default 40) credits left. The cron script is the
 * intended sampler; see scripts/odds-snapshot.mjs.
 */
import { nflTeams } from "./nfl";
import { memo } from "./memo";
import {
  appendSnapshot,
  closingOf,
  fetchEventProps,
  fetchSlateOdds,
  isoWindow,
  listOddsFiles,
  matchEvents,
  movementText,
  openingOf,
  readOddsFile,
  readUsage,
  storeProps,
  type BookLine,
  type Consensus,
  type LinePoint,
  type OddsEvent,
  type OddsFile,
  type PropRow,
  type Snapshot,
  type TeamLike,
} from "./odds-core.mjs";
import type { Game } from "./types";

export type { BookLine, Consensus, LinePoint, OddsFile, PropRow, Snapshot };

const ROOT = process.cwd();
const MEMO_SEC = 600;
const PAGE_INTERVAL_MIN = Number(process.env.ODDS_PAGE_INTERVAL_MIN ?? 90);
const RESERVE = Number(process.env.ODDS_RESERVE ?? 40);
const PROPS_INTERVAL_MIN = Number(process.env.ODDS_PROPS_INTERVAL_MIN ?? 60);

export const hasOddsKey = () => Boolean(process.env.ODDS_API_KEY);
export const KEY_NOTE = "Add ODDS_API_KEY to .env.local to track line movement across books, closing lines, and props.";

/** Everything the game page needs. Plain JSON, safe to pass to the browser. */
export interface GameOdds {
  keyMissing: boolean;
  eventId?: string;
  /** Consensus per snapshot, oldest first. */
  history: LinePoint[];
  movement: string;
  opening?: LinePoint;
  /** Last snapshot before kickoff; only set once the game has kicked off. */
  closing?: LinePoint;
  latest?: Snapshot;
  books: number;
  props?: { at: string; rows: PropRow[] };
  asOf?: string;
  note?: string;
  usage?: { remaining?: number; used?: number; calls: number };
}

/* ------------------------------------------------------------ fetch */

/** One memoized slate call (cost 3). Throws when the key is missing. */
export function fetchOdds(): Promise<OddsEvent[]> {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  return memo("odds:slate", MEMO_SEC, () => fetchSlateOdds(ROOT, key, isoWindow()));
}

/** Props for one event (cost 4). Never called automatically. */
export function eventOdds(eventId: string, markets?: string): Promise<OddsEvent> {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  return fetchEventProps(ROOT, key, eventId, markets);
}

/** Our games carry nicknames; books list "Kansas City Chiefs". school = location, mascot = nickname, keyed by nickname. */
async function teamsBySchool(season: number): Promise<Map<string, TeamLike>> {
  void season;
  return new Map(nflTeams().map((t) => [t.short, { school: t.location, mascot: t.short, abbreviation: t.abbr }]));
}

/** Snapshots taken before kickoff only. A line posted during the game prices the score, not the matchup. */
function beforeKick(file: OddsFile | undefined): OddsFile | undefined {
  const kick = Date.parse(file?.kickoff ?? "");
  return file && Number.isFinite(kick) ? { ...file, snapshots: file.snapshots.filter((s) => Date.parse(s.at) <= kick) } : file;
}

/** The newest pregame snapshot's consensus for a game (home spread, negative = home favored), for the slate's current line. */
export function latestLine(season: number, gameId: string): { spread?: number; total?: number; mlHome?: number; mlAway?: number; books: number; at: string } | undefined {
  const f = beforeKick(readOddsFile(ROOT, season, gameId));
  const s = f?.snapshots?.[f.snapshots.length - 1];
  if (!s) return undefined;
  return { spread: s.consensus.spread, total: s.consensus.total, mlHome: s.consensus.mlHome, mlAway: s.consensus.mlAway, books: s.consensus.books, at: s.at };
}

function quotaOk(): { ok: boolean; why?: string } {
  const u = readUsage(ROOT);
  if (u.remaining !== undefined && u.remaining <= RESERVE) return { ok: false, why: `Odds API quota is down to ${u.remaining} credits; holding the last ${RESERVE} in reserve.` };
  return { ok: true };
}

const minutesSince = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity);

/**
 * Take a snapshot for one game from the page path, under the throttle. The
 * same slate response also refreshes every other game that already has a
 * file and has not kicked off, since that data is already paid for.
 */
export async function snapshotGame(game: Game, season: number): Promise<{ file?: OddsFile; note?: string }> {
  if (!hasOddsKey()) return { file: readOddsFile(ROOT, season, game.id), note: KEY_NOTE };
  const existing = readOddsFile(ROOT, season, game.id);
  if (game.status !== "upcoming") return { file: existing };
  if (minutesSince(existing?.lastChecked) < PAGE_INTERVAL_MIN) return { file: existing };
  const q = quotaOk();
  if (!q.ok) return { file: existing, note: q.why };
  let events: OddsEvent[];
  try {
    events = await fetchOdds();
  } catch (err) {
    return { file: existing, note: `Odds API did not answer: ${(err as Error).message}` };
  }
  const byId = new Map(events.map((e) => [e.id, e]));
  const now = new Date().toISOString();
  // Refresh every open file we already matched.
  for (const f of listOddsFiles(ROOT, season)) {
    if (f.gameId === game.id || !f.eventId || Date.parse(f.kickoff) < Date.now()) continue;
    const ev = byId.get(f.eventId);
    if (ev && minutesSince(f.lastChecked) >= 5) appendSnapshot(ROOT, { season, gameId: f.gameId, home: f.home, away: f.away, kickoff: f.kickoff, event: ev, swapped: Boolean(f.swapped), at: now });
  }
  // This game: by stored event id, else by name.
  let ev = existing?.eventId ? byId.get(existing.eventId) : undefined;
  let swapped = Boolean(existing?.swapped);
  if (!ev) {
    const teams = await teamsBySchool(season);
    const m = matchEvents([{ id: game.id, home: game.home.short, away: game.away.short, kickoff: game.kickoff }], events, teams).get(game.id);
    if (!m) return { file: existing, note: `No US book lists ${game.away.short} at ${game.home.short} on The Odds API right now.` };
    ev = m.event;
    swapped = m.swapped;
  }
  return { file: appendSnapshot(ROOT, { season, gameId: game.id, home: game.home.short, away: game.away.short, kickoff: game.kickoff, event: ev, swapped, at: now }).file };
}

/** Fetch props for a game that already has a matched event. Cached for an hour. */
export async function fetchPropsForGame(season: number, gameId: string): Promise<{ ok: boolean; message: string; rows?: number }> {
  if (!hasOddsKey()) return { ok: false, message: KEY_NOTE };
  const file = readOddsFile(ROOT, season, gameId);
  if (!file?.eventId) return { ok: false, message: "This game is not matched to an Odds API event yet. Open the page once with a key, or run odds:snapshot." };
  if (file.props && minutesSince(file.props.at) < PROPS_INTERVAL_MIN) return { ok: true, message: `Props fetched ${Math.round(minutesSince(file.props.at))} minutes ago; refresh available after ${PROPS_INTERVAL_MIN}.`, rows: file.props.rows.length };
  const q = quotaOk();
  if (!q.ok) return { ok: false, message: q.why! };
  try {
    const ev = await eventOdds(file.eventId);
    const next = storeProps(ROOT, file, ev);
    const rows = next.props?.rows.length ?? 0;
    return { ok: true, message: rows ? `${rows} prop lines stored.` : "No US book posts player props for this game yet.", rows };
  } catch (err) {
    return { ok: false, message: `Odds API did not answer: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------ reads */

export const lineHistory = (season: number, gameId: string): Snapshot[] => beforeKick(readOddsFile(ROOT, season, gameId))?.snapshots ?? [];

export const closingLine = (season: number, gameId: string, kickoffIso?: string): LinePoint | undefined => closingOf(readOddsFile(ROOT, season, gameId), kickoffIso);

export const openingLine = (season: number, gameId: string): LinePoint | undefined => openingOf(readOddsFile(ROOT, season, gameId));

export const movement = (season: number, gameId: string, homeAbbr: string, awayAbbr: string): string => movementText(lineHistory(season, gameId), homeAbbr, awayAbbr);

export function summarize(raw: OddsFile | undefined, game: Pick<Game, "kickoff" | "status"> & { home: { abbr: string }; away: { abbr: string } }, note?: string): GameOdds {
  const file = beforeKick(raw);
  const u = readUsage(ROOT);
  const usage = { remaining: u.remaining, used: u.used, calls: u.calls ?? 0 };
  const keyMissing = !hasOddsKey();
  if (!file || !file.snapshots.length) {
    return { keyMissing, history: [], movement: keyMissing ? KEY_NOTE : (note ?? "No line snapshots yet. The next snapshot run will add this game if a US book lists it."), books: 0, note, usage, eventId: file?.eventId, props: file?.props };
  }
  const snaps = file.snapshots;
  const kickoffPassed = Date.parse(game.kickoff) <= Date.now() || game.status !== "upcoming";
  return {
    keyMissing,
    eventId: file.eventId,
    history: snaps.map((s) => ({ at: s.at, spread: s.consensus.spread, total: s.consensus.total, mlHome: s.consensus.mlHome, mlAway: s.consensus.mlAway, books: s.consensus.books })),
    movement: movementText(snaps, game.home.abbr, game.away.abbr),
    opening: openingOf(file),
    closing: kickoffPassed ? closingOf(file, game.kickoff) : undefined,
    latest: snaps[snaps.length - 1],
    books: snaps[snaps.length - 1].consensus.books,
    props: file.props,
    asOf: file.lastChecked ?? snaps[snaps.length - 1].at,
    note,
    usage,
  };
}

/** For slate.ts getGame: refresh under the throttle, then summarize. Never throws. */
export async function gameOdds(game: Game, season: number): Promise<GameOdds> {
  try {
    const { file, note } = await snapshotGame(game, season);
    return summarize(file, game, note);
  } catch (err) {
    return summarize(readOddsFile(ROOT, season, game.id), game, `Odds unavailable: ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------ closing-line value */

export interface ClvRecord {
  /** Closing consensus spread in archive convention: favorite abbr, negative line. */
  closingSpread?: { team: string; line: number };
  closingTotal?: number;
  closingAt?: string;
  hoursBeforeKick?: number;
  closingBooks?: number;
  /** Points the closing line moved toward the model side. Positive = the market agreed after the lock. */
  sideClv?: number;
  /** Points the closing total moved toward the model's over/under lean. */
  totalClv?: number;
}

export interface LockedCall {
  spread?: { team: string; line: number };
  total?: number;
  abbr: { home: string; away: string };
  projection?: { modelSide?: string; totalLean?: "over" | "under" | "none" };
}

/** Pure: compare a locked call to a closing point. Spreads are in archive convention. */
export function clvFrom(pre: LockedCall, closing: LinePoint | undefined): ClvRecord | undefined {
  if (!closing) return undefined;
  const r = Math.round;
  const rec: ClvRecord = { closingAt: closing.at, hoursBeforeKick: closing.hoursBeforeKick, closingBooks: closing.books };
  if (closing.spread !== undefined) {
    const closeHome = closing.spread;
    rec.closingSpread = closeHome <= 0 ? { team: pre.abbr.home, line: closeHome } : { team: pre.abbr.away, line: -closeHome };
    if (pre.spread && pre.projection?.modelSide) {
      const lockHome = pre.spread.team === pre.abbr.home ? pre.spread.line : -pre.spread.line;
      rec.sideClv = r((pre.projection.modelSide === pre.abbr.home ? lockHome - closeHome : closeHome - lockHome) * 10) / 10;
    }
  }
  if (closing.total !== undefined) {
    rec.closingTotal = closing.total;
    const lean = pre.projection?.totalLean;
    if (pre.total !== undefined && lean && lean !== "none") rec.totalClv = r((lean === "over" ? closing.total - pre.total : pre.total - closing.total) * 10) / 10;
  }
  return rec;
}

/** For archive.ts: the closing-line record for a locked call, if a snapshot exists before kickoff. */
export function closingValue(season: number, gameId: string, kickoff: string, pre: LockedCall): ClvRecord | undefined {
  try {
    return clvFrom(pre, closingLine(season, gameId, kickoff));
  } catch {
    return undefined;
  }
}

/** Find a game's odds file without knowing the season (API route use). */
export function findOddsFile(gameId: string): OddsFile | undefined {
  return listOddsFiles(ROOT).find((f) => f.gameId === gameId);
}
