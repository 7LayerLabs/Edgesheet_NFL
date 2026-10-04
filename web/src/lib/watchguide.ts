/**
 * Watch guide: the "Why watch" section written as a viewing guide, in the voice of a
 * diehard who has studied both teams telling a friend who has never seen either what
 * to look for and when.
 *
 * Pipeline, all in code except the prose:
 *   1. buildCandidates(game)   concrete, sourced "things to watch", each with facts that carry ids
 *   2. rankCandidates(...)     Jev (TypeSafe) scores how compelling each is to a neutral diehard;
 *                              code enforces that the top three span at least two kinds; a fixed
 *                              priority order is the fallback when Jev is unavailable
 *   3. generateWatchGuide(...) Sonnet writes headline, hook, three items, card line, from the top
 *                              five candidates only; every name and number is checked against the
 *                              candidate facts; one retry; never published unvalidated
 *   4. cache                   data/ai/watchguide/<season>/<gameId>.json with an evidence version
 *                              (a hash of the fact texts) so a guide is rewritten only when the
 *                              evidence changes
 *
 * Server-only (reads disk). The component and the slate read the cache; nothing here runs on
 * page load.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Game, Prospect, Team } from "./types";
import { evaluateWeather } from "./weather";
import { redZoneTargets, thirdDownTargets, type SituationName } from "./situational";
import { generateJSON, isUnavailable, llmInfo, type Provider, type Unavailable, type Usage } from "./llm";
import { numbersIn, seasonOf } from "./report";

/* ------------------------------------------------------------ candidates */

export type CandidateKind = "player" | "edge" | "situation" | "weather" | "market" | "rank" | "portal" | "projection";

export interface GuideFact {
  id: string;
  text: string;
}

export interface Candidate {
  id: string;
  kind: CandidateKind;
  /** One line that says what this is, for the ranker and the prompt. */
  title: string;
  facts: GuideFact[];
  /** Radar player ids this candidate is about, so the UI can link and show headshots. */
  playerIds: string[];
  /** Player names that appear in the facts. */
  names: string[];
  /** Fallback priority when Jev is unavailable. Higher is better. */
  priority: number;
  /** Jev score 0..3 once ranked. */
  jev?: number;
}

const KIND_LABEL: Record<CandidateKind, string> = {
  player: "a player to watch",
  edge: "a unit mismatch",
  situation: "a situational tendency",
  weather: "the weather",
  market: "market context",
  rank: "standings context",
  portal: "a roster storyline",
  projection: "the model against the market",
};

const strengthWeight: Record<string, number> = { dominant: 95, clear: 85, real: 70, slight: 50, even: 0 };

function playerCandidates(game: Game): Candidate[] {
  const out: Candidate[] = [];
  for (const team of [game.away, game.home]) {
    const radar = game.prospects.filter((p) => p.team === team.abbr && p.radar).sort((a, b) => (b.radar!.score ?? 0) - (a.radar!.score ?? 0)).slice(0, 2);
    radar.forEach((p, i) => {
      const r = p.radar!;
      const base = `P${team.abbr}${i + 1}`;
      const facts: GuideFact[] = [];
      const size = [p.ht, p.wt ? `${p.wt} lbs` : ""].filter(Boolean).join(", ");
      facts.push({ id: base, text: `${p.name}, ${team.short} ${p.pos}, ${p.cls}${size ? `, ${size}` : ""}, jersey ${p.jersey || "unknown"}. Radar score ${r.score} (production ${r.production}, pedigree ${r.pedigree}, usage ${r.usage}), tier ${p.tier}, ${r.eligibilityNote}${r.injury?.status ? ` Injury report: ${r.injury.status}${r.injury.injury ? ` (${r.injury.injury.toLowerCase()})` : ""}.` : ""}${p.lensNote ? ` ${p.lensNote}` : ""}` });
      if (p.stat) facts.push({ id: `${base}s`, text: `${p.name} this season: ${p.stat}.` });
      if (r.statLine?.length) facts.push({ id: `${base}l`, text: `${p.name} stat line: ${r.statLine.map((s) => `${s.label} ${s.value}`).join(", ")}.` });
      r.evidence.forEach((e, j) => facts.push({ id: `${base}e${j + 1}`, text: `${p.name}: ${e.label}${e.note ? ` (${e.note})` : ""}.` }));
      if (r.watch) facts.push({ id: `${base}w`, text: `${p.name}, what to watch for a ${p.pos}: ${r.watch}` });
      if (p.weakness) facts.push({ id: `${base}x`, text: `${p.name}, the knock: ${p.weakness}.` });
      if (p.lines?.length) facts.push({ id: `${base}b`, text: `${p.name} in this game so far: ${p.lines.map((l) => `${l.category} ${l.headline}`).join("; ")}.` });
      out.push({ id: base, kind: "player", title: `${p.name} (${team.short} ${p.pos}, radar ${r.score})`, facts, playerIds: [p.id], names: [p.name], priority: r.score });
    });
  }
  return out;
}

function edgeCandidates(game: Game): Candidate[] {
  return game.matchups
    .filter((m) => m.edge && m.edge !== "even")
    .map((m, i) => {
      const base = `E${i + 1}`;
      const facts: GuideFact[] = [
        { id: base, text: `${m.a} vs ${m.b}: advantage ${m.edge} (${m.strength ?? "real"}). ${m.why}` },
        { id: `${base}e`, text: `${m.a} vs ${m.b}, the numbers: ${m.evidence}.` },
      ];
      if (m.watch) facts.push({ id: `${base}w`, text: `${m.a} vs ${m.b}, watch for: ${m.watch}` });
      return { id: base, kind: "edge" as const, title: `${m.a} vs ${m.b} (${m.strength ?? "real"} ${m.edge} edge)`, facts, playerIds: [], names: [], priority: strengthWeight[m.strength ?? "real"] ?? 60 };
    });
}

function nameList(rows: SituationName[], max = 3): { text: string; ids: string[]; names: string[] } {
  const top = rows.filter((r) => r.n >= 2).slice(0, max);
  return { text: top.map((r) => `${r.name} (${r.n})`).join(", "), ids: top.map((r) => r.id).filter((x): x is string => Boolean(x)), names: top.map((r) => r.name) };
}

function situationCandidates(game: Game): Candidate[] {
  const out: Candidate[] = [];
  const s = game.situations;
  if (!s) return out;
  s.cues.forEach((c, i) => {
    out.push({ id: `S${i + 1}`, kind: "situation", title: `${c.key} situation, ${c.offTeam} offense vs ${c.defTeam} defense`, facts: [{ id: `S${i + 1}`, text: c.text }], playerIds: [], names: [], priority: 55 + Math.min(30, Math.round(c.weight / 2)) });
  });
  // Who gets the ball on money downs.
  for (const [tag, ts] of [["A", s.away], ["H", s.home]] as const) {
    const third = thirdDownTargets(ts.team);
    const rz = redZoneTargets(ts.team);
    const facts: GuideFact[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    if (third) {
      const c = nameList(third.carriers);
      const t = nameList(third.targets);
      if (c.text || t.text) {
        facts.push({ id: `D${tag}3`, text: `${ts.team} on third down this season: ${c.text ? `ball carriers ${c.text}` : "no repeat ball carrier"}${t.text ? `; targets ${t.text}` : ""} (counts are plays).` });
        c.ids.concat(t.ids).forEach((x) => ids.add(x));
        c.names.concat(t.names).forEach((x) => names.add(x));
      }
    }
    if (rz) {
      const c = nameList(rz.carriers);
      const t = nameList(rz.targets);
      if (c.text || t.text) {
        facts.push({ id: `D${tag}R`, text: `${ts.team} inside the 20 this season: ${c.text ? `ball carriers ${c.text}` : "no repeat ball carrier"}${t.text ? `; targets ${t.text}` : ""} (counts are plays).` });
        c.ids.concat(t.ids).forEach((x) => ids.add(x));
        c.names.concat(t.names).forEach((x) => names.add(x));
      }
    }
    const thirdRow = ts.offense.find((r) => r.key === "thirdMedConv");
    if (thirdRow && !thirdRow.small && thirdRow.rank) facts.push({ id: `D${tag}c`, text: `${ts.team} converts third-and-medium at ${thirdRow.value} (No. ${thirdRow.rank} of ${thirdRow.of}).` });
    if (facts.length) {
      // Only radar players get linked ids; the rest stay as names from the play text.
      const radarIds = new Set(game.prospects.map((p) => p.id));
      out.push({ id: `D${tag}`, kind: "situation", title: `${ts.team}: who gets the ball on money downs`, facts, playerIds: [...ids].filter((x) => radarIds.has(x)), names: [...names], priority: 58 });
    }
  }
  return out;
}

function weatherCandidates(game: Game): Candidate[] {
  if (!game.weather || game.status === "final") return [];
  const w = game.weather;
  const flags = evaluateWeather(w).filter((f) => f.level === "elevated" || f.level === "flag");
  if (!flags.length) return [];
  const facts: GuideFact[] = [{ id: "X1", text: `Forecast at kickoff: ${w.tempF} degrees, feels like ${w.feelsLikeF}, wind ${w.windDir} ${w.windMph} mph with gusts to ${w.gustMph}, rain chance ${w.precipChance}%${w.precipWindow ? ` ${w.precipWindow}` : ""}, ${w.surface}, roof ${w.roof}.` }];
  flags.forEach((f, i) => facts.push({ id: `X${i + 2}`, text: `Weather ${f.level}: ${f.title}. ${f.effect}` }));
  const top = flags.find((f) => f.level === "elevated") ?? flags[0];
  return [{ id: "X", kind: "weather", title: `Weather: ${top.title}`, facts, playerIds: [], names: [], priority: top.level === "elevated" ? 72 : 48 }];
}

function marketCandidates(game: Game): Candidate[] {
  const out: Candidate[] = [];
  const s = game.market.spread;
  const t = game.market.total;
  if (s) {
    const a = Math.abs(s.line);
    const move = s.line - s.open;
    const facts: GuideFact[] = [{ id: "K1", text: `Market: ${s.team} ${s.line > 0 ? "+" : ""}${s.line} (opened ${s.open > 0 ? "+" : ""}${s.open})${t ? `, total ${t.line} (opened ${t.open})` : ""}, ${game.market.books ?? 0} books. Context, not a pick.` }];
    if (a <= 2.5) out.push({ id: "K1", kind: "market", title: `Toss-up by the market: ${s.team} ${s.line}`, facts, playerIds: [], names: [], priority: 62 });
    if (Math.abs(move) >= 1.5) out.push({ id: "K2", kind: "market", title: `Line moved ${Math.abs(move).toFixed(1)} points ${move > 0 ? "toward the underdog" : "toward the favorite"}`, facts: [...facts, { id: "K2", text: `The spread moved from ${s.open} to ${s.line} this week, ${Math.abs(move).toFixed(1)} points ${move > 0 ? "toward the underdog" : "toward the favorite"}.` }], playerIds: [], names: [], priority: 60 });
  }
  if (t && (t.line >= 50 || t.line <= 39.5)) {
    out.push({ id: "K3", kind: "market", title: `Total ${t.line}: the market expects ${t.line >= 50 ? "points" : "a field-position grind"}`, facts: [{ id: "K3", text: `Total of ${t.line} (opened ${t.open}). The market expects ${t.line >= 50 ? "a lot of points" : "a low-scoring, field-position game"}.` }], playerIds: [], names: [], priority: 50 });
  }
  return out;
}

function standingsCandidates(game: Game): Candidate[] {
  const rows = (game.stakes ?? []).slice(0, 2);
  return rows.map((text, i) => ({ id: `R${i + 1}`, kind: "rank" as const, title: text, facts: [{ id: `R${i + 1}`, text }], playerIds: [], names: [], priority: i === 0 ? 62 : 48 }));
}

function injuryCandidates(game: Game): Candidate[] {
  const rows = (game.injuryReport ?? []).filter((r) => r.status === "Out" || r.status === "Doubtful").filter((r) => game.prospects.some((p) => p.id === r.id)).slice(0, 2);
  return rows.map((r, i) => {
    const text = `${r.name} (${r.team} ${r.pos}) is listed ${r.status}${r.injury ? ` (${r.injury.toLowerCase()})` : ""} on the official week ${r.week} injury report${r.practice ? `; practice: ${r.practice.toLowerCase()}` : ""}.`;
    return { id: `I${i + 1}`, kind: "rank" as const, title: `${r.name} ${r.status} on the injury report`, facts: [{ id: `I${i + 1}`, text }], playerIds: [r.id], names: [r.name], priority: 58 };
  });
}

function projectionCandidates(game: Game): Candidate[] {
  const p = game.projection;
  if (!p) return [];
  const facts: GuideFact[] = [];
  const winner = p.winner === game.home.abbr ? game.home : game.away;
  facts.push({ id: "J1", text: `Model projection (a model, not a pick): ${winner.short} by ${p.margin.toFixed(1)}, ${Math.round(p.winProb * 100)}% to win, projected ${game.away.short} ${p.away}, ${game.home.short} ${p.home}, total ${p.total}.` });
  facts.push({ id: "J2", text: `Projected shape: ${p.shape}` });
  let priority = 0;
  let title = "";
  if (p.vsMarket && (p.sideGap ?? 0) >= 3) {
    facts.push({ id: "J3", text: `Model against the number: ${p.vsMarket}` });
    priority = 55 + Math.min(20, Math.round(p.sideGap ?? 0));
    title = `Model disagrees with the market by ${(p.sideGap ?? 0).toFixed(1)} points`;
  }
  if (p.modelTotal !== undefined && p.totalLean && p.totalLean !== "none" && (p.totalGap ?? 0) >= 4) {
    facts.push({ id: "J4", text: `Model total ${p.modelTotal} against the market total, lean ${p.totalLean}${p.totalNote ? `. ${p.totalNote}` : ""}` });
    if (!title) {
      priority = 52;
      title = `Model total ${p.modelTotal} leans ${p.totalLean}`;
    }
  }
  if (!title) return [];
  return [{ id: "J", kind: "projection", title, facts, playerIds: [], names: [], priority }];
}

/** Every concrete, sourced thing a fan could be told to look for in this game. */
export function buildCandidates(game: Game): Candidate[] {
  return [
    ...playerCandidates(game),
    ...edgeCandidates(game),
    ...situationCandidates(game),
    ...weatherCandidates(game),
    ...marketCandidates(game),
    ...standingsCandidates(game),
    ...injuryCandidates(game),
    ...projectionCandidates(game),
  ];
}

/** Hash of the fact texts: the guide is rewritten only when the evidence changes. */
export function evidenceVersion(cands: Candidate[]): string {
  const h = createHash("sha1");
  for (const c of cands) for (const f of c.facts) h.update(f.text + "\n");
  return h.digest("hex").slice(0, 12);
}

/* --------------------------------------------------------------- ranking */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

let envLoaded = false;
function typesafeKey(): string | undefined {
  if (!process.env.TYPESAFE_API_KEY && !envLoaded) {
    envLoaded = true;
    try {
      const m = /^\s*TYPESAFE_API_KEY\s*=\s*(.+)\s*$/m.exec(readFileSync(path.join(process.cwd(), ".env.local"), "utf8"));
      if (m) process.env.TYPESAFE_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return process.env.TYPESAFE_API_KEY?.trim() || undefined;
}

export const JEV_LEVELS = [
  "Skip it. Generic context a casual fan would not care about or could not see on the broadcast.",
  "Nice to know. Background that explains the game but does not tell you where to look.",
  "Worth watching for. A specific player, unit, or situation with numbers behind it that a fan can spot during the game.",
  "Must see. The single most compelling thing in this game: a star with a real stat line, a dominant mismatch, or a tendency that will decide a close game.",
];

export interface RankResult {
  ranked: Candidate[];
  ranker: "jev" | "priority";
  note?: string;
}

/**
 * Order candidates by how compelling they are to a neutral diehard, one Jev request with a
 * Score question per candidate (speculative fan-out over the same state). Code keeps the policy:
 * the top three must come from at least two different kinds. Falls back to the fixed priority
 * order when the key is missing or the call fails.
 */
export async function rankCandidates(game: Game, cands: Candidate[]): Promise<RankResult> {
  const byPriority = [...cands].sort((a, b) => b.priority - a.priority);
  const key = typesafeKey();
  if (!key) return { ranked: enforceMix(byPriority), ranker: "priority", note: "TYPESAFE_API_KEY not set" };
  if (!cands.length) return { ranked: [], ranker: "priority" };
  try {
    const state = {
      game: `${game.away.short} at ${game.home.short}, ${game.division}${game.market.spread ? `, market ${game.market.spread.team} ${game.market.spread.line}` : ""}`,
      candidates: cands.map((c) => ({ id: c.id, kind: KIND_LABEL[c.kind], summary: c.title, facts: c.facts.map((f) => f.text) })),
    };
    const questions: Record<string, unknown> = {};
    for (const c of cands) {
      questions[c.id] = {
        type: "score",
        instructions: `How compelling is candidate \`${c.id}\` in \`candidates\` to a neutral diehard fan deciding what to look for in this game? Judge only that candidate.`,
        criteria: JEV_LEVELS,
      };
    }
    const res = await fetchWithRetry(TYPESAFE_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, model: "jev-latest", questions }) });
    if (!res.ok) throw new Error(`typesafe ${res.status}`);
    const j = (await res.json()) as { answers?: Record<string, { type: string; score?: number }> };
    for (const c of cands) {
      const a = j.answers?.[c.id];
      if (a && typeof a.score === "number") c.jev = a.score;
    }
    const scored = [...cands].sort((a, b) => (b.jev ?? -1) - (a.jev ?? -1) || b.priority - a.priority);
    return { ranked: enforceMix(scored), ranker: "jev" };
  } catch (err) {
    return { ranked: enforceMix(byPriority), ranker: "priority", note: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 && res.status !== 529) return res;
    last = res;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return last!;
}

/** The top three must span at least two kinds. If the first three share a kind, the best candidate of another kind moves up to third. */
export function enforceMix(sorted: Candidate[]): Candidate[] {
  if (sorted.length < 3) return sorted;
  const top = sorted.slice(0, 3);
  if (new Set(top.map((c) => c.kind)).size >= 2) return sorted;
  const idx = sorted.findIndex((c, i) => i >= 3 && c.kind !== top[0].kind);
  if (idx < 0) return sorted;
  const out = [...sorted];
  const [moved] = out.splice(idx, 1);
  out.splice(2, 0, moved);
  return out;
}

/* --------------------------------------------------------------- writing */

export interface GuideItem {
  title: string;
  what: string;
  when: string;
  who: string;
  /** Radar player id when `who` is a radar player; the UI links and shows the headshot. */
  whoPlayerId?: string;
  factIds: string[];
}

export interface WatchGuide {
  headline: string;
  hook: string;
  items: GuideItem[];
  cardLine: string;
}

export const GUIDE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One line for the card, under 12 words, no colon tricks, no question." },
    hook: { type: "string", description: "One sentence that sells this game to someone who has never seen either team." },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Three to six words." },
          what: { type: "string", description: "Two or three sentences in the diehard voice with the numbers inside them." },
          when: { type: "string", description: "The moment or situation to look for it. Under 15 words." },
          who: { type: "string", description: "The player or unit. A player name exactly as given, or a unit like 'Tennessee offensive line'." },
          whoPlayerId: { type: "string", description: "The player id from the candidate when who is a radar player; empty string otherwise." },
          factIds: { type: "array", items: { type: "string" } },
        },
        required: ["title", "what", "when", "who", "whoPlayerId", "factIds"],
        additionalProperties: false,
      },
    },
    cardLine: { type: "string", description: "One sentence under 20 words for the slate card, the single best reason to watch." },
  },
  required: ["headline", "hook", "items", "cardLine"],
  additionalProperties: false,
};

const SYSTEM = `You write the viewing guide for EdgeSheet NFL, a game guide for people deciding what to watch on Sunday.
You are a diehard who has studied both teams, talking to a friend who has never seen either. Tell them exactly what to look for and when. Specific, confident, numbers inside the sentences. No hedging, no filler, no emojis, no em dashes (use commas, periods, or "to"). Plain English, short declarative sentences.
Example of the voice: "Watch the Lions on first down. They throw on 58 percent of early downs and the Bears allow a 20-plus yard pass on 11 percent of dropbacks, No. 29 in the league. If Jameson Williams gets behind the safety on the first drive, this game is over by halftime."
Rules that cannot be broken:
1. Every number you write must appear in the candidate facts exactly as given (ranks, percentages, lines, yards, counts). Do not compute new numbers, do not round, do not add up. Spell out small counts (one, two, three) when you can.
2. Every player you name must appear in the facts. Do not add quarterbacks, coaches, or anyone from memory. Team names as given.
3. Do not invent schemes, injuries, history, or motivation. If it is not in the facts, it does not exist.
4. Write exactly three items. Each item is about one candidate. Pick the three most compelling of the five, keeping at least two different kinds. The first item is the one thing to see if they only watch one drive.
5. "what" is two or three sentences: what to look for, the numbers that say why, and what it means if it shows up. "when" names the moment (first drive, third-and-medium, inside the 20, when they fall behind, fourth quarter, when the wind picks up). "who" is the player name exactly as written, or the unit.
6. Never give betting advice. The market and the model are context. Never say "the data", "the facts", or "the evidence".
Return only the JSON object.`;

function userPrompt(game: Game, top: Candidate[], previous?: { guide: WatchGuide; violations: string[] }): string {
  const blocks = top
    .map((c, i) => `Candidate ${i + 1} (${KIND_LABEL[c.kind]}${c.playerIds.length ? `, player id ${c.playerIds.join(", ")}` : ""}): ${c.title}\n${c.facts.map((f) => `  [${f.id}] ${f.text}`).join("\n")}`)
    .join("\n\n");
  const names = [...new Set(top.flatMap((c) => c.names))];
  const retry = previous
    ? `\n\nYour previous attempt was rejected. Violations:\n${previous.violations.map((x) => `- ${x}`).join("\n")}\nRewrite the whole guide and fix every item. Remove any number or name that is not in the facts rather than rephrasing it.\n\nPrevious attempt:\n${JSON.stringify(previous.guide)}`
    : "";
  return `Game: ${game.away.short} at ${game.home.short}, ${game.division}. ${game.status === "upcoming" ? "Pregame." : game.status === "live" ? "In progress." : "Final; write the guide as what to look for on a replay."}\n\nCandidates (the only source you may use):\n\n${blocks}\n\nPlayers you may name: ${names.length ? names.join("; ") : "none"}.${retry}\n\nWrite the guide as JSON with keys headline, hook, items (title, what, when, who, whoPlayerId, factIds), cardLine.`;
}

/* -------------------------------------------------------------- validate */

const STOP = new Set(
  "a an the this that these those it its if when while where which who whom whose what why how both neither either no not yes and but or nor for in on at to by with from of as into over under after before during until here there then now also still only even just more most less least much many few several each every any some all one two three four five six seven eight nine ten first second third fourth fifth last next watch expect look think call say see start keep give take get go come make put turn hold run pass throw block cover rush win lose edge advantage mismatch lean total side model market offense defense line front game half quarter drive snap carry carries yards points percent rate success explosive explosiveness pace tempo scouts scout nfl draft radar sleeper future eligible established emerging tier report pregame postgame final live kickoff et tv weather wind rain heat cold storm roof grass turf feels gusts humidity elevation no. vs mph lbs ft pct epa if his he they them their".split(/\s+/),
);

const wordsOf = (text: string) => (text.toLowerCase().match(/[a-z][a-z'’.-]*/g) ?? []).map((w) => w.replace(/[.'’-]+$/, ""));

interface Vocab {
  numbers: number[];
  vocab: Set<string>;
  factIds: Set<string>;
  playerIds: Set<string>;
  names: Set<string>;
}

function vocabOf(game: Game, top: Candidate[]): Vocab {
  const all = top.flatMap((c) => c.facts.map((f) => f.text)).join("\n");
  const vocab = new Set(wordsOf(all));
  const names = new Set<string>();
  for (const c of top) for (const n of c.names) {
    names.add(n);
    for (const w of wordsOf(n)) vocab.add(w);
  }
  for (const t of [game.home, game.away]) for (const w of wordsOf(`${t.name} ${t.short} ${t.abbr} ${t.conference}`)) vocab.add(w);
  return { numbers: [...new Set(numbersIn(all))], vocab, factIds: new Set(top.flatMap((c) => c.facts.map((f) => f.id))), playerIds: new Set(top.flatMap((c) => c.playerIds)), names };
}

function unknownProperNouns(text: string, v: Vocab): string[] {
  const out = new Set<string>();
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const tokens = s.match(/[A-Z][A-Za-z'’.-]*/g) ?? [];
    tokens.forEach((raw, i) => {
      const tok = raw.replace(/['’]s$/i, "").replace(/[.'’-]+$/, "");
      if (tok.length < 2) return;
      const lower = tok.toLowerCase();
      if (v.vocab.has(lower) || STOP.has(lower)) return;
      const atStart = i === 0 && s.startsWith(raw);
      const next = tokens[i + 1]?.replace(/[.'’-]+$/, "").toLowerCase();
      if (atStart && !(next && !v.vocab.has(next) && !STOP.has(next))) return;
      out.add(tok);
    });
  }
  return [...out];
}

function numberOk(n: number, v: Vocab): boolean {
  if (v.numbers.includes(n)) return true;
  if (Number.isInteger(n) && n >= 0 && n <= 3) return true;
  const decimals = (String(n).split(".")[1] ?? "").length;
  for (const p of v.numbers) {
    if (Number(p.toFixed(decimals)) === n) return true;
    if (Math.abs(p * 100 - n) < 0.051 || Math.abs(p / 100 - n) < 0.0051) return true;
    if (Math.abs(p - n) < 0.5 && decimals === 0 && !Number.isInteger(p)) return true;
  }
  return false;
}

export function guideText(g: WatchGuide): string {
  return [g.headline, g.hook, ...g.items.flatMap((i) => [i.title, i.what, i.when, i.who]), g.cardLine].join("\n");
}

/** Empty list means the guide only says what the candidate facts say. */
export function validateGuide(g: WatchGuide, game: Game, top: Candidate[]): string[] {
  const v: string[] = [];
  if (!g || typeof g.headline !== "string" || !Array.isArray(g.items)) return ["guide is not in the required shape"];
  if (g.items.length !== 3) v.push(`need exactly 3 items, got ${g.items.length}`);
  const text = guideText(g);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) v.push("contains an emoji");
  if (/[—–]/.test(text)) v.push("contains an em dash or en dash; use commas, periods, or 'to'");
  if (/\b(candidate|fact ids?|the data|the facts|the evidence)\b/i.test(text)) v.push("mentions the candidates, the data, or the evidence instead of just saying it");
  if (/\b(bet|wager|parlay|take the (over|under|points))\b/i.test(text)) v.push("gives betting advice");
  const vocab = vocabOf(game, top);
  g.items.forEach((it, i) => {
    for (const id of it.factIds ?? []) if (!vocab.factIds.has(id)) v.push(`item ${i + 1} cites unknown fact id ${id}`);
    if (it.whoPlayerId && !vocab.playerIds.has(it.whoPlayerId)) v.push(`item ${i + 1} names player id ${it.whoPlayerId} that is not a candidate player`);
    const words = (it.what ?? "").split(/\s+/).filter(Boolean).length;
    if (words < 15) v.push(`item ${i + 1} "what" is too short (${words} words); write two or three sentences`);
    if (words > 90) v.push(`item ${i + 1} "what" is too long (${words} words); two or three sentences`);
  });
  const kinds = new Set(g.items.map((it) => top.find((c) => (it.factIds ?? []).some((id) => c.facts.some((f) => f.id === id)))?.kind).filter(Boolean));
  if (g.items.length === 3 && kinds.size < 2) v.push("the three items must come from at least two different kinds of candidate");
  const badNums = [...new Set(numbersIn(text).filter((n) => !numberOk(n, vocab)))];
  if (badNums.length) v.push(`numbers not in the candidate facts: ${badNums.join(", ")}`);
  const badNames = unknownProperNouns(text, vocab);
  if (badNames.length) v.push(`names or proper nouns not in the candidate facts: ${badNames.join(", ")}`);
  return v;
}

/* ----------------------------------------------------------------- cache */

export interface CachedGuide {
  gameId: string;
  season: number;
  generatedAt: string;
  provider: Provider;
  model: string;
  ranker: "jev" | "priority";
  rankerNote?: string;
  status: Game["status"];
  evidenceVersion: string;
  candidateCount: number;
  /** The five candidates sent to the writer, in rank order, with Jev scores. */
  top: { id: string; kind: CandidateKind; title: string; jev?: number; playerIds: string[] }[];
  attempts: number;
  attemptLog: string[][];
  usage: Usage;
  guide?: WatchGuide;
  failed?: { reasons: string[] };
}

const DIR = path.join(process.cwd(), "data", "ai", "watchguide");
const file = (season: number, id: string) => path.join(DIR, String(season), `${id}.json`);

export function readGuide(season: number, gameId: string): CachedGuide | undefined {
  const f = file(season, gameId);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as CachedGuide;
  } catch {
    return undefined;
  }
}

/** The published guide for a game, or undefined. Safe for the slate: one small file read, memo-free. */
export function publishedGuide(game: Pick<Game, "id" | "kickoff" | "division">): WatchGuide | undefined {
  return readGuide(seasonOf(game.kickoff), game.id)?.guide;
}

function writeGuide(c: CachedGuide) {
  const f = file(c.season, c.gameId);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 1));
}

export const guideProvider = () => llmInfo({ small: true });

/* -------------------------------------------------------------- generate */

export interface GenerateGuideOpts {
  force?: boolean;
  /** Return the cached guide even when the evidence version differs (the UI's default). */
  anyVersion?: boolean;
}

/**
 * Write the guide for one game: candidates, Jev ranking, Sonnet draft, validation, cache.
 * Returns the cached record (with `guide` when published, `failed` when not) or Unavailable
 * when no model key is present. Skips the model when a cached guide matches the evidence version.
 */
export async function generateWatchGuide(game: Game, opts: GenerateGuideOpts = {}): Promise<CachedGuide | Unavailable> {
  const season = seasonOf(game.kickoff);
  const cands = buildCandidates(game);
  const version = evidenceVersion(cands);
  if (!opts.force) {
    const cached = readGuide(season, game.id);
    if (cached?.guide && (cached.evidenceVersion === version || opts.anyVersion)) return cached;
  }
  if (cands.length < 2) {
    const out: CachedGuide = { gameId: game.id, season, generatedAt: new Date().toISOString(), provider: "anthropic", model: "", ranker: "priority", status: game.status, evidenceVersion: version, candidateCount: cands.length, top: [], attempts: 0, attemptLog: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, failed: { reasons: ["fewer than two sourced things to watch; not enough evidence for a guide"] } };
    writeGuide(out);
    return out;
  }
  const info = llmInfo({ small: true });
  if (isUnavailable(info)) return info;

  const { ranked, ranker, note } = await rankCandidates(game, cands);
  const top = ranked.slice(0, 5);
  const topMeta = top.map((c) => ({ id: c.id, kind: c.kind, title: c.title, jev: c.jev, playerIds: c.playerIds }));

  let previous: { guide: WatchGuide; violations: string[] } | undefined;
  let attempts = 0;
  let provider: Provider = info.provider;
  let model = info.model;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  const attemptLog: string[][] = [];
  let lastViolations: string[] = [];
  for (let i = 0; i < 2; i++) {
    attempts++;
    const res = await generateJSON<WatchGuide>(userPrompt(game, top, previous), GUIDE_SCHEMA, { system: SYSTEM, purpose: "watchguide", ref: game.id, small: true, maxTokens: 1500 });
    if (isUnavailable(res)) return res;
    provider = res.provider;
    model = res.model;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens;
    usage.costUsd += res.usage.costUsd;
    const guide = res.data;
    // Normalize: empty player id strings become undefined; a player id that is not a candidate player is dropped before validation only if the name is still fine.
    for (const it of guide.items ?? []) if (!it.whoPlayerId) delete it.whoPlayerId;
    const violations = validateGuide(guide, game, top);
    attemptLog.push(violations);
    if (!violations.length) {
      const out: CachedGuide = { gameId: game.id, season, generatedAt: new Date().toISOString(), provider, model, ranker, rankerNote: note, status: game.status, evidenceVersion: version, candidateCount: cands.length, top: topMeta, attempts, attemptLog, usage, guide };
      writeGuide(out);
      return out;
    }
    lastViolations = violations;
    previous = { guide, violations };
  }
  const out: CachedGuide = { gameId: game.id, season, generatedAt: new Date().toISOString(), provider, model, ranker, rankerNote: note, status: game.status, evidenceVersion: version, candidateCount: cands.length, top: topMeta, attempts, attemptLog, usage, failed: { reasons: lastViolations } };
  writeGuide(out);
  return out;
}

/* ------------------------------------------------------- postgame lines */

/** The box-score line for a guide item's player, when the game has a box. Code only, no model. */
export function howItWent(item: GuideItem, game: Game): string | undefined {
  if (!item.whoPlayerId || game.status === "upcoming") return undefined;
  const p: Prospect | undefined = game.prospects.find((x) => x.id === item.whoPlayerId);
  if (p?.lines?.length) return p.lines.map((l) => `${l.category} ${l.headline}`).join("; ");
  for (const t of game.box?.teams ?? []) {
    const rows = t.leaders.filter((l) => l.id === item.whoPlayerId);
    if (rows.length) return rows.map((l) => `${l.category} ${l.headline}`).join("; ");
  }
  return undefined;
}
