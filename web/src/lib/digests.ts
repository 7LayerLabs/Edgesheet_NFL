/**
 * Message builders for push delivery (Telegram today, Discord later). Pure
 * functions over the app's own data: a Slate, Game objects, archive entries,
 * the follows file. No fetching, no node:fs. Output is Telegram-flavored HTML
 * (<b>, <i>, <code>, <a>), which Discord can take after a light reformat.
 *
 * Every number shown comes from a Game or an ArchiveEntry. Nothing is invented.
 * The model's leans are always labeled "model, not a pick".
 */
import type { ArchiveEntry } from "./archive";
import { historyStats } from "./archive";
import { kickoffTime } from "./format";
import type { Follows } from "./follows";
import type { RadarPlayer } from "./radar";
import { scoreTag, scoutScore } from "./score";
import { escapeHtml as h } from "./telegram";
import type { Game } from "./types";

/* ----------------------------------------------------------------- config */

export const DEFAULT_BASE_URL = "http://localhost:3100";

export function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export const NOT_A_PICK = "Model, not a pick.";

const isD1 = (g: Game) => g.division === "NFL";

const ET = "America/New_York";

export function longDate(date: string): string {
  return new Date(`${date}T12:00:00-04:00`).toLocaleDateString("en-US", { timeZone: ET, weekday: "long", month: "long", day: "numeric" });
}

const matchupLabel = (g: Game) => {
  const t = (x: Game["home"]) => `${x.rank ? `No. ${x.rank} ` : ""}${x.short}`;
  return `${t(g.away)} at ${t(g.home)}`;
};

const gameLink = (g: Game, base: string) => `<a href="${base}/game/${g.id}">${h(matchupLabel(g))}</a>`;

/* ------------------------------------------------------------------ leans */

export type LeanStrength = "strong" | "moderate";

export interface SideLean {
  game: Game;
  kind: "side";
  strength: LeanStrength;
  team: string; // abbr the model leans toward
  gap: number; // points between model margin and market margin
  text: string; // projection.vsMarket
}

export interface TotalLean {
  game: Game;
  kind: "total";
  strength: LeanStrength;
  direction: "over" | "under";
  gap: number;
  modelTotal: number;
  marketTotal: number;
}

export type Lean = SideLean | TotalLean;

/** Thresholds in points. A side lean under 2 and a total lean under 2.5 are "no lean" in projection.ts already. */
export const LEAN_THRESHOLDS = { side: { strong: 4, moderate: 2 }, total: { strong: 5, moderate: 2.5 } };

/** Model leans for games that have both a projection and a posted market number. */
export function modelLeans(games: Game[]): Lean[] {
  const out: Lean[] = [];
  for (const g of games) {
    if (!isD1(g) || !g.projection || g.status === "final") continue;
    const p = g.projection;
    if (p.modelSide && p.sideGap !== undefined && g.market.spread && p.vsMarket) {
      const strength: LeanStrength | undefined = p.sideGap >= LEAN_THRESHOLDS.side.strong ? "strong" : p.sideGap >= LEAN_THRESHOLDS.side.moderate ? "moderate" : undefined;
      if (strength) out.push({ game: g, kind: "side", strength, team: p.modelSide, gap: p.sideGap, text: p.vsMarket });
    }
    if (p.totalLean && p.totalLean !== "none" && p.totalGap !== undefined && p.modelTotal !== undefined && g.market.total) {
      const a = Math.abs(p.totalGap);
      const strength: LeanStrength | undefined = a >= LEAN_THRESHOLDS.total.strong ? "strong" : a >= LEAN_THRESHOLDS.total.moderate ? "moderate" : undefined;
      if (strength) out.push({ game: g, kind: "total", strength, direction: p.totalLean, gap: a, modelTotal: p.modelTotal, marketTotal: g.market.total.line });
    }
  }
  const rank = (l: Lean) => (l.strength === "strong" ? 0 : 1) * 1000 - l.gap;
  return out.sort((a, b) => rank(a) - rank(b));
}

function leanLine(l: Lean, base: string): string {
  const s = l.game.market.spread!;
  if (l.kind === "side") {
    return `${gameLink(l.game, base)}: model leans <b>${h(l.team)}</b> by ${l.gap.toFixed(1)} vs ${h(s.team)} ${s.line}`;
  }
  return `${gameLink(l.game, base)}: model leans <b>${l.direction}</b> by ${l.gap.toFixed(1)}, model total ${l.modelTotal} vs posted ${l.marketTotal}`;
}

export interface LeanOptions {
  /** Max lines per group (strong side, strong total, moderate side, moderate total). Omit for no cap. */
  limit?: number;
}

/**
 * Side and total leans, strong first. With `limit`, each group is capped and
 * the message says how many more there are, so the morning slate stays short
 * while /leans can show everything.
 */
export function leansSection(games: Game[], base = baseUrl(), opts: LeanOptions = {}): string {
  const leans = modelLeans(games);
  const lines: string[] = [];
  if (!leans.length) {
    const eligible = games.filter((g) => isD1(g) && g.projection && g.market.spread && g.status !== "final").length;
    lines.push(eligible ? `No side or total gap clears the lean threshold today. ${NOT_A_PICK}` : "No game today has both a projection and a posted line. Nothing to lean on.");
    return lines.join("\n");
  }
  const group = (title: string, xs: Lean[]) => {
    if (!xs.length) return;
    const shown = opts.limit ? xs.slice(0, opts.limit) : xs;
    lines.push(`<b>${title}</b> (${xs.length})`);
    for (const l of shown) lines.push(`• ${leanLine(l, base)}`);
    if (shown.length < xs.length) lines.push(`   plus ${xs.length - shown.length} more, send /leans for the full list`);
  };
  group(`Side gaps of ${LEAN_THRESHOLDS.side.strong}+ pts vs the spread`, leans.filter((l) => l.strength === "strong" && l.kind === "side"));
  group(`Total gaps of ${LEAN_THRESHOLDS.total.strong}+ pts vs the total`, leans.filter((l) => l.strength === "strong" && l.kind === "total"));
  group(`Side gaps of ${LEAN_THRESHOLDS.side.moderate} to ${LEAN_THRESHOLDS.side.strong} pts`, leans.filter((l) => l.strength === "moderate" && l.kind === "side"));
  group(`Total gaps of ${LEAN_THRESHOLDS.total.moderate} to ${LEAN_THRESHOLDS.total.strong} pts`, leans.filter((l) => l.strength === "moderate" && l.kind === "total"));
  const overs = leans.filter((l) => l.kind === "total" && l.direction === "over").length;
  const unders = leans.filter((l) => l.kind === "total" && l.direction === "under").length;
  if (overs + unders) lines.push(`<i>Totals skew: ${overs} over, ${unders} under.</i>`);
  lines.push(`<i>${NOT_A_PICK} ${LEAN_BACKTEST_NOTE} Graded on the Record page after every final.</i>`);
  return lines.join("\n");
}

/**
 * What the leans have earned so far, from scripts/backtest-qb.mjs (data/backtest/qb.json). Said next to
 * every lean list so a gap reads as a disagreement with the market, not a pick. Update after re-running.
 */
export const LEAN_BACKTEST_NOTE =
  "Backtest 2022 to 2025 (Elo plus the QB adjustment, 1,139 games): the model side covered about 48% against the closing line, and no gap size beat the 52.4% break-even. Totals are not backtested yet. Read these as disagreements with the market, not picks.";

/** Standalone /leans reply. */
export function leansDigest(games: Game[], date: string, base = baseUrl()): string {
  return [`<b>Model leans, ${h(longDate(date))}</b>`, "", leansSection(games, base)].join("\n");
}

/* ---------------------------------------------------------- morning slate */

export interface SlateLike {
  date: string;
  games: Game[];
  season?: number;
  week?: { week: number } | undefined;
}

function gameLine(g: Game, base: string, score: number): string {
  const why = g.whyWatch.replace(/\s+/g, " ").trim();
  return `<b>${score}</b> ${gameLink(g, base)} · ${h(kickoffTime(g.kickoff))} ET · ${h(g.network)}\n   ${h(why)}`;
}

export function morningSlate(slate: SlateLike, base = baseUrl()): string {
  const games = slate.games;
  const d1 = games.filter(isD1);
  const lines: string[] = [];
  lines.push(`<b>EdgeSheet slate, ${h(longDate(slate.date))}</b>${slate.week ? ` · Week ${slate.week.week}` : ""}`);
  lines.push(`${games.length} games on the slate.`);
  if (!games.length) {
    lines.push("No games on this date.");
    lines.push(`<a href="${base}/">Open the slate</a>`);
    return lines.join("\n");
  }
  const sorted = [...games].sort((a, b) => scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents));
  lines.push("");
  lines.push("<b>Top 5 by Watch Score</b>");
  for (const g of sorted.slice(0, 5)) lines.push(gameLine(g, base, scoutScore(g.scoreComponents)));

  const top5 = new Set(sorted.slice(0, 5).map((g) => g.id));
  const gems = sorted.filter((g) => scoreTag(g) === "Hidden Gem" && !top5.has(g.id)).slice(0, 4);
  lines.push("");
  lines.push("<b>Hidden Gems</b> (75+ score, not on a flagship network)");
  if (gems.length) for (const g of gems) lines.push(gameLine(g, base, scoutScore(g.scoreComponents)));
  else {
    const inTop = sorted.slice(0, 5).filter((g) => scoreTag(g) === "Hidden Gem");
    lines.push(inTop.length ? `All of today's gems are already in the top 5 (${inTop.map((g) => h(matchupLabel(g))).join(", ")}).` : "None today.");
  }

  lines.push("");
  lines.push("<b>Model leans</b>");
  lines.push(leansSection(d1, base, { limit: 5 }));
  lines.push("");
  lines.push(`<a href="${base}/?date=${slate.date}">Open the slate</a>`);
  return lines.join("\n");
}

/* ------------------------------------------------------- kickoff reminder */

export interface ReminderHit {
  game: Game;
  teams: string[]; // followed school names in this game
  minutes: number; // minutes to kickoff
}

/** Followed teams with a game kicking off in the next `windowMinutes`. Already-started games are skipped. */
export function upcomingForFollows(games: Game[], follows: Follows, now: Date = new Date(), windowMinutes = 60): ReminderHit[] {
  const followed = new Set(follows.teams.map((t) => t.toLowerCase()));
  const watchedGames = new Set(follows.games);
  const out: ReminderHit[] = [];
  for (const g of games) {
    const ms = new Date(g.kickoff).getTime() - now.getTime();
    if (ms < 0 || ms > windowMinutes * 60_000) continue;
    const teams = [g.away, g.home].filter((t) => followed.has(t.short.toLowerCase())).map((t) => t.short);
    if (!teams.length && !watchedGames.has(g.id)) continue;
    out.push({ game: g, teams, minutes: Math.round(ms / 60_000) });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

export function kickoffReminder(hits: ReminderHit[], base = baseUrl()): string | undefined {
  if (!hits.length) return undefined;
  const lines = ["<b>Kickoff soon</b>"];
  for (const { game: g, teams, minutes } of hits) {
    const who = teams.length ? `You follow ${teams.map(h).join(" and ")}.` : "On your watchlist.";
    const line = g.market.spread ? ` · ${h(g.market.spread.team)} ${g.market.spread.line}${g.market.total ? `, total ${g.market.total.line}` : ""}` : "";
    lines.push(`• ${gameLink(g, base)} in ${minutes} min (${h(kickoffTime(g.kickoff))} ET) · ${h(g.network)}${line}`);
    lines.push(`   ${who} Watch Score ${scoutScore(g.scoreComponents)}. ${h(g.whyWatch)}`);
  }
  return lines.join("\n");
}

/* --------------------------------------------------------- postgame grades */

export function gradeLine(e: ArchiveEntry, base = baseUrl()): string {
  const p = e.postgame!;
  const pre = e.pregame;
  const edges = p.edges.filter((x) => x.edge !== "even" && x.verdict !== "unmeasured");
  const hits = edges.filter((x) => x.verdict === "played out").length;
  const pros = p.prospects.filter((x) => x.verdict !== "unmeasured");
  const showed = pros.filter((x) => x.verdict === "showed up").length;
  const parts: string[] = [];
  parts.push(`Watch Score ${pre.scoutScore}${p.excitement != null ? ` vs excitement ${p.excitement.toFixed(1)}` : ", excitement not available"}`);
  parts.push(edges.length ? `matchup calls ${hits} of ${edges.length}` : "matchup calls unmeasured");
  parts.push(pros.length ? `radar names ${showed} of ${pros.length}` : "radar names unmeasured");
  const pr = p.projectionResult;
  if (pr) {
    parts.push(`projection winner ${pr.winnerRight ? "right" : "wrong"} (${h(pre.projection!.winner)}, off by ${pr.marginError})`);
    if (pr.modelSideCovered !== undefined) parts.push(`model side ${h(pre.projection!.modelSide ?? "")} ${pr.modelSideCovered ? "covered" : "did not cover"}`);
    else if (pre.projection?.modelSide) parts.push("model side push or no line");
    if (pr.totalLeanRight !== undefined) parts.push(`total lean ${h(pre.projection!.totalLean ?? "")} ${pr.totalLeanRight ? "right" : "wrong"}`);
    else if (pre.projection?.totalLean && pre.projection.totalLean !== "none") parts.push("total lean push");
  } else parts.push("no projection locked");
  const score = `<b>${h(pre.away)} ${p.score.away}, ${h(pre.home)} ${p.score.home}</b>`;
  return `<a href="${base}/game/${e.gameId}">${score}</a>${p.spreadResult ? ` · ${h(p.spreadResult)}` : ""}${p.totalResult ? `, ${h(p.totalResult)}` : ""}\n   ${parts.join(" · ")}`;
}

/** Entries graded after `sinceIso` (postgame.capturedAt), oldest first, plus the newest cursor to store. */
export function newlyGraded(entries: ArchiveEntry[], sinceIso?: string): { entries: ArchiveEntry[]; cursor?: string } {
  const graded = entries.filter((e) => e.postgame && (!sinceIso || e.postgame.capturedAt > sinceIso)).sort((a, b) => a.postgame!.capturedAt.localeCompare(b.postgame!.capturedAt));
  const cursor = graded.length ? graded[graded.length - 1].postgame!.capturedAt : sinceIso;
  return { entries: graded, cursor };
}

export function postgameDigest(entries: ArchiveEntry[], base = baseUrl()): string | undefined {
  if (!entries.length) return undefined;
  const lines = [`<b>Postgame grades</b> (${entries.length} ${entries.length === 1 ? "game" : "games"})`];
  for (const e of entries) lines.push(`• ${gradeLine(e, base)}`);
  lines.push(`<a href="${base}/history">Full record</a>`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ radar alerts */

export interface RadarAlert {
  key: string; // `${gameId}:${playerId}`
  gameId: string;
  playerId: string;
  name: string;
  team: string;
  pos: string;
  line: string;
  score: number;
  matchup: string;
}

/** Followed players who posted a "showed up" line in a graded game. `seen` holds keys already sent. */
export function radarAlerts(entries: ArchiveEntry[], follows: Follows, seen: Set<string> = new Set()): RadarAlert[] {
  const followed = new Set(follows.players);
  if (!followed.size) return [];
  const out: RadarAlert[] = [];
  for (const e of entries) {
    if (!e.postgame) continue;
    for (const p of e.postgame.prospects) {
      if (!followed.has(p.id) || p.verdict !== "showed up") continue;
      const key = `${e.gameId}:${p.id}`;
      if (seen.has(key)) continue;
      out.push({ key, gameId: e.gameId, playerId: p.id, name: p.name, team: p.team, pos: p.pos, line: p.line, score: p.score, matchup: `${e.pregame.away} ${e.postgame.score.away}, ${e.pregame.home} ${e.postgame.score.home}` });
    }
  }
  return out;
}

export function radarAlertDigest(alerts: RadarAlert[], base = baseUrl()): string | undefined {
  if (!alerts.length) return undefined;
  const lines = ["<b>Radar alert: a followed player showed up</b>"];
  for (const a of alerts) lines.push(`• <b>${h(a.name)}</b> (${h(a.team)} ${h(a.pos)}, radar ${a.score}): ${h(a.line)}\n   <a href="${base}/game/${a.gameId}">${h(a.matchup)}</a> · <a href="${base}/player/${a.playerId}">player page</a>`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ record */

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

export function recordDigest(entries: ArchiveEntry[], base = baseUrl()): string {
  const s = historyStats(entries);
  if (!s.games) return `<b>The record</b>\nNothing locked yet. Calls lock the first time a slate or game page is built while the game is upcoming.\n<a href="${base}/history">Record page</a>`;
  const lines = [
    `<b>The record</b> · ${s.games} locked, ${s.graded} graded`,
    `Model winner: ${pct(s.winnerRight, s.winnerGraded)} (${s.winnerRight} of ${s.winnerGraded})${s.avgMarginError != null ? `, margin off by ${s.avgMarginError.toFixed(1)} avg` : ""}`,
    `Model vs number: ${pct(s.modelSideCovered, s.modelSideGraded)} (${s.modelSideCovered} of ${s.modelSideGraded} model sides covered)`,
    `Model total lean: ${pct(s.totalLeanRight, s.totalLeanGraded)} (${s.totalLeanRight} of ${s.totalLeanGraded})`,
    `Matchup calls: ${pct(s.edgePlayedOut, s.edgeCalls)} (${s.edgePlayedOut} played out, ${s.edgeMissed} missed, of ${s.edgeCalls})`,
    `Pressure point: ${pct(s.pressurePlayedOut, s.pressureGraded)} (${s.pressurePlayedOut} of ${s.pressureGraded})`,
    `Radar names: ${pct(s.prospectShowedUp, s.prospectCalls)} (${s.prospectShowedUp} of ${s.prospectCalls} showed up)`,
    `Favorites covered: ${pct(s.favoriteCovered, s.spreadGraded)} (${s.favoriteCovered} of ${s.spreadGraded}, context not picks)`,
  ];
  const buckets = s.byBucket.filter((b) => b.games);
  if (buckets.length) {
    lines.push("Watch Score bucket vs excitement:");
    for (const b of buckets) lines.push(`• ${b.label}: ${b.avgExcitement != null ? b.avgExcitement.toFixed(1) : "n/a"} avg over ${b.games} g`);
  }
  lines.push(`<i>${NOT_A_PICK}</i>`);
  lines.push(`<a href="${base}/history">Record page</a>`);
  return lines.join("\n");
}

/* ------------------------------------------------------- team lookups */

/** Loose team match: school name, abbreviation, or full name, case-insensitive, prefix allowed. */
export function findTeamGames(games: Game[], query: string): Game[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hit = (t: Game["home"]) => [t.short, t.abbr, t.name].some((x) => x.toLowerCase() === q);
  let out = games.filter((g) => hit(g.home) || hit(g.away));
  if (!out.length) {
    const starts = (t: Game["home"]) => [t.short, t.name].some((x) => x.toLowerCase().startsWith(q));
    out = games.filter((g) => starts(g.home) || starts(g.away));
  }
  if (!out.length) {
    const inc = (t: Game["home"]) => t.short.toLowerCase().includes(q);
    out = games.filter((g) => inc(g.home) || inc(g.away));
  }
  return out;
}

/** Resolve a query to the school name the data uses, using this week's games. */
export function resolveSchool(games: Game[], query: string): string | undefined {
  const q = query.trim().toLowerCase();
  const g = findTeamGames(games, query)[0];
  if (!g) return undefined;
  const pick = [g.home, g.away].find((t) => [t.short, t.abbr, t.name].some((x) => x.toLowerCase() === q)) ?? [g.home, g.away].find((t) => t.short.toLowerCase().startsWith(q) || t.name.toLowerCase().startsWith(q)) ?? [g.home, g.away].find((t) => t.short.toLowerCase().includes(q));
  return pick?.short;
}

/* ------------------------------------------------------------- one game */

export function gameDigest(g: Game, base = baseUrl()): string {
  const s = scoutScore(g.scoreComponents);
  const lines: string[] = [];
  lines.push(`<b>${h(matchupLabel(g))}</b> · Watch Score ${s} · ${h(scoreTag(g))}`);
  const status = g.status === "final" && g.score && Number.isFinite(g.score.home) ? `Final: ${h(g.away.abbr)} ${g.score.away}, ${h(g.home.abbr)} ${g.score.home}` : g.status === "live" ? "In progress (schedule-based; no live feed)" : `${h(kickoffTime(g.kickoff))} ET, ${h(longDate(g.kickoff.slice(0, 10)))}`;
  lines.push(`${status} · ${h(g.network)}${g.venue ? ` · ${h(g.venue)}` : ""}`);
  if (g.away.record || g.home.record) lines.push(`${h(g.away.short)} ${h(g.away.record || "record n/a")}, ${h(g.home.short)} ${h(g.home.record || "record n/a")}`);
  lines.push("");
  lines.push("<b>Why watch</b>");
  for (const r of g.whyWatchReasons) lines.push(`• ${h(r)}`);
  if (g.market.spread) lines.push(`Market: ${h(g.market.spread.team)} ${g.market.spread.line}${g.market.total ? `, total ${g.market.total.line}` : ""}${g.market.books ? ` (${g.market.books} books)` : ""}`);
  else lines.push("Market: no book we track lists this game.");
  if (g.projection) {
    const p = g.projection;
    lines.push("");
    lines.push(`<b>Projection</b> (${h(p.confidence)} confidence)`);
    lines.push(`${h(p.winner)} by ${p.margin.toFixed(1)}, win prob ${Math.round(p.winProb * 100)}%. Score line ${h(g.away.abbr)} ${p.away}, ${h(g.home.abbr)} ${p.home}.`);
    if (p.vsMarket) lines.push(h(p.vsMarket));
    if (p.totalNote) lines.push(h(p.totalNote));
    lines.push(`<i>${NOT_A_PICK}</i>`);
  }
  if (g.matchups.length) {
    lines.push("");
    lines.push("<b>Where it gets decided</b>");
    lines.push(h(g.pressurePoint));
    for (const m of g.matchups.slice(0, 4)) lines.push(`• ${h(m.a)} vs ${h(m.b)}: ${h(m.edge ?? "even")}${m.strength ? ` (${h(m.strength)})` : ""}`);
  }
  const radar = g.prospects.slice(0, 6);
  if (radar.length) {
    lines.push("");
    lines.push("<b>Watch radar</b>");
    for (const p of radar) lines.push(`• ${h(p.name)} (${h(p.team)} ${h(p.pos)}, ${h(p.cls)}) ${h(p.tier)}${p.radar ? ` ${p.radar.score}` : ""}${p.stat ? `: ${h(p.stat)}` : ""}${p.lines?.length ? `\n   Today: ${h(p.lines.map((l) => l.headline).join(" · "))}` : ""}`);
  } else lines.push("\nNo player from either team clears the radar threshold.");
  if (g.archive?.postgame) {
    lines.push("");
    lines.push("<b>Did it play out</b>");
    lines.push(gradeLine(g.archive, base));
  }
  lines.push("");
  lines.push(`<a href="${base}/game/${g.id}">Full report</a>`);
  return lines.join("\n");
}

/* ------------------------------------------------------------- team radar */

export function teamRadarDigest(school: string, players: RadarPlayer[], game: Game | undefined, base = baseUrl()): string {
  const lines: string[] = [];
  lines.push(`<b>${h(school)} radar</b>${game ? ` · this week: ${gameLink(game, base)}` : " · no game on the slate this week"}`);
  if (!players.length) {
    lines.push("No player clears the radar threshold, or the roster is not ingested.");
    return lines.join("\n");
  }
  for (const p of players.slice(0, 10)) {
    lines.push(`• <b>${h(p.name)}</b> ${h(p.pos)} ${h(p.cls)} · ${h(p.tier)} ${p.score}${p.slot ? ` · pick No. ${p.slot}` : " · undrafted"}\n   ${h(p.stat || p.evidence.map((e) => e.label).join(", ") || "no production line")}`);
  }
  if (players.length > 10) lines.push(`and ${players.length - 10} more on the site.`);
  lines.push(`<a href="${base}/radar">Radar board</a>`);
  return lines.join("\n");
}

/* ----------------------------------------------------------------- help */

export function helpDigest(): string {
  return [
    "<b>EdgeSheet bot</b>",
    "/slate · today's slate: top 5, hidden gems, model leans",
    "/leans · model side and total leans (model, not a pick)",
    "/record · how the calls have graded out",
    "/radar &lt;team&gt; · that team's watch radar",
    "/game &lt;team&gt; · that team's game this week",
    "/help · this list",
  ].join("\n");
}
