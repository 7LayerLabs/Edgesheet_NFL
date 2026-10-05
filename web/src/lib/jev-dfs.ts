/**
 * Jev reads the news for the DraftKings simulator: per player, the chance he plays this game, whether his role
 * is shrinking or growing, and who takes his work if he sits. Server only.
 *
 * News: his ESPN injury comment when dated inside the last 72 hours, plus beat-feed items tagged to him in the
 * same window, newest first, at most 6. No fresh news, no key, or any Jev error: the status prior stands and the
 * role is his usual one. Never throws.
 *
 * One askJev request per player, independent questions over the same state:
 *   plays        (Noul)   will he be active and play in this game
 *   role         (Score)  limited / usual / bigger than usual
 *   beneficiary  (Choice) which listed teammate takes most of his work if he sits (only with teammates; asked in
 *                         both option orders and averaged)
 * Policy lives here, not in the model:
 *   - a play probability within 0.1 of 0.5 keeps the status prior (the Jev number is still logged)
 *   - a role answer with confidence under 0.5 counts as his usual role
 *   - a beneficiary counts only at probability 0.5 or more
 * Dates go to Jev as words built in code ("1 day after the previous game, 6 days before this game"): it reads
 * dates as text and does not compare them reliably (docs.typesafe.ai, jev-1.13 jaggedness).
 *
 * Judgments are memoized 6 hours per player, status, game, teammates and news texts, so unchanged news is never
 * re-asked; at most 6 requests in flight. Every Jev-backed judgment is appended to data/dk/jev-dfs.jsonl, which
 * scripts/score-jev-dfs.mjs grades against who actually played.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { espnInjuries, type EspnInjury } from "./availability";
import { feedForTeams, KIND_LABEL, type FeedItem } from "./feed";
import { genMeta, genSchedule } from "./generated";
import { askJev, choiceQ, jevAvailable, noulQ, scoreQ, toScoreResult } from "./jev";
import { memo } from "./memo";

export interface NewsCandidate {
  id: string; // our player id (ESPN athlete id)
  name: string;
  team: string; // nickname, e.g. "Vikings"
  pos: "QB" | "RB" | "WR" | "TE";
  status: string; // playerStatus().status, e.g. "Questionable", "Questionable (out last game, no update since)", "Active"
  statusSource: string; // "ESPN" | "official report" | ""
  prior: number; // status-only probability he plays (1 - absence)
  kickoff: string; // ISO of the game being projected
  opponent: string; // nickname
  proj?: number; // his DK projection, logged for validation only
  teammates: { id: string; name: string; pos: string }[]; // same-position teammates who could absorb his work
}

export interface NewsJudgment {
  id: string;
  pPlay: number; // what the simulator uses
  pPlaySource: "jev" | "status";
  jevPlay?: number; // raw Jev probability, logged
  role: "limited" | "usual" | "bigger";
  roleConfidence?: number;
  beneficiaryId?: string; // teammate Jev picked, only when its probability >= 0.5
  beneficiaryProb?: number;
  posts: number; // fresh news items used
  at: string; // ISO time judged
}

export const ROLE_MULTIPLIER: Record<NewsJudgment["role"], number> = { limited: 0.75, usual: 1, bigger: 1.15 };

const WINDOW_MS = 72 * 3600_000;
const MAX_NEWS = 6;
const TTL_SECONDS = 6 * 3600;
const MAX_IN_FLIGHT = 6;
/** A play probability this close to 0.5 is Jev saying it can't tell: keep the prior. */
const NEAR_HALF = 0.1;
const ROLE_MIN_CONFIDENCE = 0.5;
const BENEFICIARY_MIN = 0.5;
const ROLES: NewsJudgment["role"][] = ["limited", "usual", "bigger"];
const NOBODY = "nobody in particular";
const LOG_FILE = path.join(process.cwd(), "data", "dk", "jev-dfs.jsonl");
const ET = "America/New_York";
const round3 = (x: number) => Math.round(x * 1000) / 1000;

interface News {
  text: string;
  source: string;
  at: string; // ISO
}

/* ------------------------------------------------------------ news */

const sourceOf = (it: FeedItem) => `${it.outlet ?? it.author} (${KIND_LABEL[it.kind].toLowerCase()}${it.where ? `, ${it.where}` : ""})`;

/** His fresh ESPN comment and tagged feed items, deduped by text, newest first, at most MAX_NEWS. */
function newsFor(c: NewsCandidate, espn: EspnInjury | undefined, feed: FeedItem[], now: number): News[] {
  const fresh = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && t >= now - WINDOW_MS && t <= now + 5 * 60_000;
  };
  const all: News[] = [];
  if (espn?.comment && fresh(espn.date)) all.push({ text: espn.comment, source: "ESPN injury report", at: new Date(Date.parse(espn.date!)).toISOString() });
  for (const it of feed) if (it.tags.includes(c.id) && fresh(it.publishedAt)) all.push({ text: it.text, source: sourceOf(it), at: it.publishedAt });
  const seen = new Set<string>();
  return all
    .filter((n) => {
      const k = n.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_NEWS);
}

/** One feed per team, tagged to that team's candidates. A failed feed is an empty one. */
async function feedsByTeam(candidates: NewsCandidate[]): Promise<Map<string, FeedItem[]>> {
  const teams = [...new Set(candidates.map((c) => c.team))];
  const items = await Promise.all(
    teams.map((t) =>
      feedForTeams(
        [t],
        candidates.filter((c) => c.team === t).map((c) => ({ id: c.id, name: c.name, team: c.team })),
      ).then(
        (r) => r.items,
        () => [] as FeedItem[],
      ),
    ),
  );
  return new Map(teams.map((t, i) => [t, items[i]]));
}

/* ------------------------------------------------------------ dates in words */

/** Calendar day number in Eastern time, so "1 day after" means the next date on an ET calendar. */
const etDay = (t: number) => Date.parse(`${new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t))}T00:00:00Z`) / 86_400_000;
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const longDate = (t: number, withTime = false) =>
  new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "long", month: "long", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).format(new Date(t)) + (withTime ? " ET" : "");

/** This game's week and his team's previous game before it, from the schedule. */
function gameContext(team: string, kickoff: string): { week?: number; prev?: { at: number; opponent: string; week: number } } {
  const k = Date.parse(kickoff);
  const season = genMeta()?.season;
  let week: number | undefined;
  let prev: { at: number; opponent: string; week: number } | undefined;
  for (const g of genSchedule()) {
    if (g.season !== season || (g.home !== team && g.away !== team)) continue;
    const t = Date.parse(g.kickoff);
    if (Math.abs(t - k) < 60_000) week = g.week;
    else if (t < k && (!prev || t > prev.at)) prev = { at: t, opponent: g.home === team ? g.away : g.home, week: g.week };
  }
  return { week, prev };
}

function kickoffText(k: number, week: number | undefined, now: number): string {
  const d = etDay(k) - etDay(now);
  const rel = d === 0 ? "today" : d === 1 ? "tomorrow" : d > 1 ? `${days(d)} from now` : `${days(-d)} ago`;
  return `${longDate(k, true)}${week ? ` (week ${week})` : ""}, ${rel}`;
}

function postedText(t: number, kick: number, prev: number | undefined): string {
  const parts: string[] = [];
  if (prev !== undefined) {
    if (t < prev) parts.push("before the previous game");
    else {
      const d = etDay(t) - etDay(prev);
      parts.push(d === 0 ? "the day of the previous game" : `${days(d)} after the previous game`);
    }
  }
  const d = etDay(kick) - etDay(t);
  parts.push(d === 0 ? "the day of this game" : `${days(d)} before this game`);
  return `${longDate(t)} (${parts.join(", ")})`;
}

/* ------------------------------------------------------------ Jev */

let inFlight = 0;
const waiting: (() => void)[] = [];
/** At most MAX_IN_FLIGHT requests at once; a finishing request hands its slot to the next in line. */
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((r) => waiting.push(r));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

function logJudgment(row: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  } catch {
    /* the log is for grading later; a failed write never blocks a projection */
  }
}

/** One request for one player. Throws when Jev gives no usable answer, so the memo keeps nothing and the caller falls back. */
async function judge(c: NewsCandidate, news: News[]): Promise<NewsJudgment> {
  const now = Date.now();
  const kick = Date.parse(c.kickoff);
  const { week, prev } = gameContext(c.team, c.kickoff);

  // Teammates are choice options by name; a repeated name (or one that collides with the no-match option) gets its id.
  const byLabel = new Map<string, { id: string; name: string }>();
  const options: Record<string, string> = {};
  for (const t of c.teammates) {
    const label = byLabel.has(t.name) || t.name === NOBODY ? `${t.name} (${t.id})` : t.name;
    byLabel.set(label, { id: t.id, name: t.name });
    options[label] = `${t.pos} on the ${c.team}`;
  }
  options[NOBODY] = "No single teammate in `teammates` takes most of his work: it is split among several players or goes to someone not listed.";

  const state = {
    player: `${c.name}, ${c.pos}`,
    team: c.team,
    opponent: c.opponent,
    kickoff: kickoffText(kick, week, now),
    ...(prev ? { previous_game: `${longDate(prev.at)} against the ${prev.opponent} (week ${prev.week})${prev.at > now ? ", not played yet" : ""}` } : {}),
    status: c.statusSource ? `${c.status}; source: ${c.statusSource}` : c.status,
    news: news.map((n) => ({ text: n.text, source: n.source, at: postedText(Date.parse(n.at), kick, prev?.at) })),
    teammates: c.teammates.map((t) => ({ name: t.name, position: t.pos })),
  };

  const questions: Questions = {
    plays: noulQ(
      "Will `player` be active and play in the game against `opponent` at `kickoff`? Items in `news` that describe an earlier game or an earlier week (he was inactive for it, missed it, or left it hurt) are about that game, not this one.",
      "He is active and plays in the game against `opponent` at `kickoff`.",
      "He is inactive, ruled out, or does not play in the game against `opponent` at `kickoff`.",
    ),
    // Levels say what the news reports, not what an injury implies: worded as "a limited role ... or returning slowly",
    // 17 of 20 week-5 questionable players came back limited at high confidence, most with nothing in the news about role.
    role: scoreQ("Based on `news`, if `player` plays in the game against `opponent` at `kickoff`, how big will his role be?", [
      "The news says he will have a limited role: a snap count, a part-time role, a split workload, or being eased back in.",
      "His usual role: the news does not say his snaps, carries, or targets will change.",
      "The news says he will have a bigger role than usual: the lead back, more targets, or a starter's workload because another player is out.",
    ]),
  };
  // Jev leans toward the first Choice option (jev-1.13 jaggedness; 5 of 20 week-5 picks flipped when reversed), so the
  // same Choice goes in both orders in this one request and the probabilities are averaged.
  const labels = Object.keys(options);
  if (c.teammates.length) {
    const q = "If `player` does not play in the game against `opponent`, which teammate takes over most of his work?";
    questions.beneficiary = choiceQ(q, options);
    questions.beneficiaryReversed = choiceQ(q, Object.fromEntries([...labels].reverse().map((l) => [l, options[l]])));
  }

  const started = Date.now();
  const a = await limited(() => askJev(state, questions, { purpose: "dfs", ref: c.id }));
  const ms = Date.now() - started;
  const playsAns = a?.plays;
  if (!a || playsAns?.type !== "noul" || typeof playsAns.noul !== "number") throw new Error("no Jev answer");

  const jevPlay = round3(playsAns.noul);
  const useJev = Math.abs(jevPlay - 0.5) >= NEAR_HALF;

  let role: NewsJudgment["role"] = "usual";
  let roleConfidence: number | undefined;
  let roleTop: NewsJudgment["role"] | undefined;
  const roleAns = a.role;
  if (roleAns?.type === "score") {
    const r = toScoreResult(roleAns, ROLES.length);
    roleConfidence = round3(r.confidence);
    roleTop = ROLES[r.top];
    if (r.confidence >= ROLE_MIN_CONFIDENCE) role = roleTop;
  }

  let top: { label: string; prob: number } | undefined;
  const benAns = [a.beneficiary, a.beneficiaryReversed].flatMap((x) => (x?.type === "choice" ? [x] : []));
  if (benAns.length) {
    for (const l of labels) {
      const prob = round3(benAns.reduce((s, x) => s + (x.probabilities[l] ?? 0), 0) / benAns.length);
      if (!top || prob > top.prob) top = { label: l, prob };
    }
  }
  const pick = top && byLabel.has(top.label) ? { ...byLabel.get(top.label)!, prob: top.prob } : undefined;
  const beneficiary = pick && pick.prob >= BENEFICIARY_MIN ? pick : undefined;

  const judgment: NewsJudgment = {
    id: c.id,
    pPlay: useJev ? jevPlay : c.prior,
    pPlaySource: useJev ? "jev" : "status",
    jevPlay,
    role,
    roleConfidence,
    ...(beneficiary ? { beneficiaryId: beneficiary.id, beneficiaryProb: beneficiary.prob } : {}),
    posts: news.length,
    at: new Date().toISOString(),
  };
  logJudgment({
    at: judgment.at,
    id: c.id,
    name: c.name,
    team: c.team,
    pos: c.pos,
    kickoff: c.kickoff,
    status: c.status,
    statusSource: c.statusSource,
    prior: c.prior,
    proj: c.proj,
    news: news.length,
    newsTexts: news.map((n) => n.text.slice(0, 300)),
    jevPlay,
    pPlay: judgment.pPlay,
    pPlaySource: judgment.pPlaySource,
    role,
    roleTop,
    roleConfidence,
    beneficiary: beneficiary ? { id: beneficiary.id, name: beneficiary.name, prob: beneficiary.prob } : null,
    beneficiaryTop: top ? { pick: top.label, prob: top.prob, orders: benAns.map((x) => x.choice) } : null,
    ms,
  });
  return judgment;
}

/**
 * A judgment for every candidate, keyed by player id. Without a key, or with no fresh news for a player, his
 * status prior and usual role come back with no Jev call.
 */
export async function newsJudgments(candidates: NewsCandidate[]): Promise<Map<string, NewsJudgment>> {
  const out = new Map<string, NewsJudgment>();
  const now = Date.now();
  const statusOnly = (c: NewsCandidate): NewsJudgment => ({ id: c.id, pPlay: Math.max(0, Math.min(1, c.prior)), pPlaySource: "status", role: "usual", posts: 0, at: new Date(now).toISOString() });
  try {
    if (!candidates.length || !jevAvailable()) {
      for (const c of candidates) out.set(c.id, statusOnly(c));
      return out;
    }
    const [inj, feeds] = await Promise.all([espnInjuries(), feedsByTeam(candidates)]);
    const espnById = new Map(inj.rows.map((r) => [r.id, r]));
    await Promise.all(
      candidates.map(async (c) => {
        const news = newsFor(c, espnById.get(c.id), feeds.get(c.team) ?? [], now);
        if (!news.length) {
          out.set(c.id, statusOnly(c));
          return;
        }
        const hash = createHash("sha1")
          .update(JSON.stringify([c.status, c.kickoff, c.teammates.map((t) => t.id), news.map((n) => n.text)]))
          .digest("hex")
          .slice(0, 16);
        try {
          out.set(c.id, await memo(`jev-dfs:${c.id}:${hash}`, TTL_SECONDS, () => judge(c, news)));
        } catch {
          out.set(c.id, statusOnly(c));
        }
      }),
    );
  } catch {
    for (const c of candidates) if (!out.has(c.id)) out.set(c.id, statusOnly(c));
  }
  return out;
}
