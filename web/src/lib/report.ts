/**
 * Written report. Builds an evidence packet from a Game where every fact has an
 * id, asks the model for a structured report, then checks the output against the
 * packet: every player name must exist in the packet and every number must appear
 * in it. One retry with the violations listed; if it still fails, nothing is
 * published and the reason is recorded. Reports are cached per season and game
 * under data/ai/reports with the evidence version they were written from.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Game, Prospect } from "./types";
import { evaluateWeather } from "./weather";
import { kickoffTime, spreadText } from "./format";
import { generateJSON, isUnavailable, llmInfo, type Provider, type Unavailable, type Usage } from "./llm";

/* ---------------------------------------------------------------- packet */

export interface Fact {
  id: string;
  text: string;
}

export interface Packet {
  gameId: string;
  title: string;
  pregame: boolean;
  evidenceAsOf: string;
  facts: Fact[];
  /** Player names that may appear in the report. */
  names: string[];
  /** Every number that appears anywhere in the facts. */
  numbers: number[];
  /** Lowercased vocabulary of the packet, for proper-noun checks. */
  vocab: Set<string>;
}

const NUM_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.match(NUM_RE) ?? []) {
    // Sign is dropped: a spread of -2.5 and "by 2.5" are the same fact.
    const n = Math.abs(Number(m.replace(/,/g, "")));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const wordsOf = (text: string) => (text.toLowerCase().match(/[a-z][a-z'’.-]*/g) ?? []).map((w) => w.replace(/[.'’-]+$/, ""));

function prospectFacts(p: Prospect, idx: number): Fact[] {
  const base = `R${idx + 1}`;
  const out: Fact[] = [];
  const size = [p.ht, p.wt ? `${p.wt} lbs` : ""].filter(Boolean).join(", ");
  out.push({ id: base, text: `${p.name}, ${p.team} ${p.pos}, ${p.cls}${size ? `, ${size}` : ""}. tier ${p.tier}, ${p.projected}.${p.radar ? ` Radar score ${p.radar.score} (production ${p.radar.production}, pedigree ${p.radar.pedigree}, usage ${p.radar.usage}).` : ""}` });
  if (p.stat) out.push({ id: `${base}s`, text: `${p.name}: ${p.stat}.` });
  const ev = p.radar?.evidence ?? p.traits.map((label) => ({ label, note: undefined as string | undefined }));
  ev.forEach((e, i) => out.push({ id: `${base}e${i + 1}`, text: `${p.name}: ${e.label}${e.note ? ` (${e.note})` : ""}.` }));
  if (p.weakness) out.push({ id: `${base}w`, text: `${p.name}: ${p.weakness}.` });
  if (p.watchFor) out.push({ id: `${base}x`, text: `${p.name}, what to watch: ${p.watchFor}` });
  if (p.radar?.eligibilityNote) out.push({ id: `${base}g`, text: `${p.name}: ${p.radar.eligibilityNote}` });
  if (p.lines?.length) out.push({ id: `${base}b`, text: `${p.name} in this game: ${p.lines.map((l) => `${l.category} ${l.headline}`).join("; ")}.` });
  return out;
}

/** Everything the model is allowed to say, one fact per line, each with an id. */
export function buildPacket(game: Game): Packet {
  const f: Fact[] = [];
  const names = new Set<string>();
  const team = (t: Game["home"]) => `${t.short} (${t.abbr}${t.rank ? `, No. ${t.rank} in the ${t.rankPoll ?? "poll"}` : ""}${t.record ? `, record ${t.record}` : ""}${t.conference ? `, ${t.conference}` : ""})`;

  f.push({ id: "G1", text: `${team(game.away)} at ${team(game.home)}. ${game.division}. Kickoff ${kickoffTime(game.kickoff)} ET, ${game.venue}${game.city ? `, ${game.city}` : ""}, on ${game.network}.` });
  f.push({ id: "G2", text: game.status === "upcoming" ? "The game has not kicked off. This is a pregame report." : game.status === "live" ? "The game is in progress." : `Final${game.score ? `: ${game.away.short} ${game.score.away}, ${game.home.short} ${game.score.home}` : ""}.` });
  if (game.styleLine) f.push({ id: "G3", text: `Style line: ${game.styleLine}.` });
  game.whyWatchReasons.forEach((r, i) => f.push({ id: `W${i + 1}`, text: r }));
  f.push({ id: "P1", text: `Pressure point: ${game.pressurePoint}` });
  game.matchups.forEach((m, i) => {
    const n = i + 1;
    f.push({ id: `M${n}`, text: `${m.a} vs ${m.b}: advantage ${m.edge ?? "even"}${m.strength ? ` (${m.strength})` : ""}. ${m.why}` });
    f.push({ id: `M${n}e`, text: `${m.a} vs ${m.b}, evidence: ${m.evidence}.` });
    if (m.watch) f.push({ id: `M${n}w`, text: `${m.a} vs ${m.b}, watch for: ${m.watch}` });
  });
  const p = game.projection;
  if (p) {
    const winner = p.winner === game.home.abbr ? game.home : game.away;
    f.push({ id: "J1", text: `Model projection (a model, not a pick): ${winner.short} by ${p.margin.toFixed(1)}, ${Math.round(p.winProb * 100)}% to win, projected score ${game.away.short} ${p.away}, ${game.home.short} ${p.home}, total ${p.total}. Confidence ${p.confidence}.` });
    f.push({ id: "J2", text: `Projected shape: ${p.shape}` });
    if (p.vsMarket) f.push({ id: "J3", text: `Model against the number: ${p.vsMarket}` });
    if (p.modelTotal !== undefined) f.push({ id: "J4", text: `Model total ${p.modelTotal}${p.totalLean && p.totalLean !== "none" ? `, lean ${p.totalLean}` : ", no lean"}${p.totalNote ? `. ${p.totalNote}` : ""}` });
    if (p.weatherTilt) f.push({ id: "J5", text: `Weather tilt: ${p.weatherTilt}` });
    p.basis.forEach((b, i) => f.push({ id: `J6.${i + 1}`, text: `Projection basis: ${b}` }));
  }
  const consensus = (game as Game & { consensus?: unknown }).consensus;
  if (consensus && typeof consensus === "object") f.push({ id: "C1", text: `Consensus: ${JSON.stringify(consensus)}` });

  game.prospects.forEach((pr, i) => {
    names.add(pr.name);
    f.push(...prospectFacts(pr, i));
  });
  game.keepAnEyeOn.forEach((k, i) => {
    names.add(k.name);
    f.push({ id: `E${i + 1}`, text: `Keep an eye on ${k.name} (${k.team}): ${k.note}` });
  });

  for (const [side, t] of [["away", game.away], ["home", game.home]] as const) {
    const o = game.offense[t.abbr];
    const d = game.defense[t.abbr];
    const tag = side === "away" ? "A" : "H";
    if (o && o.sample !== "unavailable") {
      f.push({ id: `S${tag}1`, text: `${t.short} offense: ${o.label}${o.sample === "small" ? " (small sample)" : ""}.${o.summary ? ` ${o.summary}` : ""}` });
      o.metrics?.forEach((m, i) => f.push({ id: `S${tag}1.${i + 1}`, text: `${t.short} offense ${m.label}: ${m.value}${m.rank ? ` (No. ${m.rank}${m.of ? ` of ${m.of}` : ""})` : ""}.` }));
    } else f.push({ id: `S${tag}1`, text: `${t.short} offense: tendencies not charted.` });
    if (d && d.sample !== "unavailable") {
      f.push({ id: `S${tag}2`, text: `${t.short} defense: ${d.label}${d.sample === "small" ? " (small sample)" : ""}.${d.summary ? ` ${d.summary}` : ""}` });
      d.metrics?.forEach((m, i) => f.push({ id: `S${tag}2.${i + 1}`, text: `${t.short} defense ${m.label}: ${m.value}${m.rank ? ` (No. ${m.rank}${m.of ? ` of ${m.of}` : ""})` : ""}.` }));
    } else f.push({ id: `S${tag}2`, text: `${t.short} defense: tendencies not charted.` });
  }

  if (game.weather) {
    const w = game.weather;
    f.push({ id: "X1", text: `Forecast at kickoff: ${w.tempF} degrees, feels like ${w.feelsLikeF}, wind ${w.windDir} ${w.windMph} mph with gusts to ${w.gustMph}, rain chance ${w.precipChance}%${w.precipWindow ? ` ${w.precipWindow}` : ""}, humidity ${w.humidity}%, ${w.surface}, roof ${w.roof}, elevation ${w.elevationFt} ft.` });
    evaluateWeather(w).forEach((fl, i) => f.push({ id: `X${i + 2}`, text: `Weather ${fl.level}: ${fl.title}. ${fl.effect}` }));
  } else f.push({ id: "X1", text: "No forecast available." });

  const mk = game.market;
  if (mk.spread) {
    f.push({ id: "K1", text: `Market: ${spreadText(mk.spread.team, mk.spread.line)} (opened ${mk.spread.open > 0 ? "+" : ""}${mk.spread.open})${mk.total ? `, total ${mk.total.line} (opened ${mk.total.open})` : ""}${mk.moneyline ? `, moneyline ${game.home.abbr} ${mk.moneyline.home}, ${game.away.abbr} ${mk.moneyline.away}` : ""}. ${mk.books ?? 0} books. Shown as context, not a pick.` });
  } else f.push({ id: "K1", text: "No book we track lists this game." });

  game.storylines.forEach((s, i) => f.push({ id: `T${i + 1}`, text: s }));
  const situations = (game as Game & { situations?: unknown }).situations;
  if (Array.isArray(situations)) situations.forEach((s, i) => f.push({ id: `Z${i + 1}`, text: typeof s === "string" ? s : JSON.stringify(s) }));

  if (game.box) {
    game.box.teams.forEach((t, i) => {
      t.leaders.forEach((l) => names.add(l.name));
      f.push({ id: `B${i + 1}`, text: `${t.team}${t.points !== null ? ` ${t.points} points` : ""}, box score leaders: ${t.leaders.map((l) => `${l.name} ${l.category} ${l.headline}`).join("; ")}.` });
    });
  }
  const post = game.archive?.postgame;
  if (post) {
    post.edges.forEach((e, i) => f.push({ id: `V${i + 1}`, text: `Graded: ${e.a} vs ${e.b}, called advantage ${e.edge}, verdict ${e.verdict}. Actual: ${e.actual}.` }));
    post.prospects.forEach((pr, i) => f.push({ id: `V${post.edges.length + i + 1}`, text: `Graded: ${pr.name} ${pr.verdict}. ${pr.line}` }));
    f.push({ id: "V0", text: `Pressure point verdict: ${post.pressurePointVerdict}.${post.spreadResult ? ` Spread: ${post.spreadResult}.` : ""}${post.totalResult ? ` Total went ${post.totalResult}.` : ""}` });
  }
  if (game.gaps?.length) f.push({ id: "N1", text: `What this report cannot say: ${game.gaps.join(" ")}` });

  const all = f.map((x) => x.text).join("\n");
  const vocab = new Set<string>(wordsOf(all));
  for (const n of names) for (const w of wordsOf(n)) vocab.add(w);
  return {
    gameId: game.id,
    title: `${game.away.short} at ${game.home.short}`,
    pregame: game.status === "upcoming",
    evidenceAsOf: game.reportAsOf,
    facts: f,
    names: [...names],
    numbers: [...new Set(numbersIn(all))],
    vocab,
  };
}

/* ------------------------------------------------------------- validate */

export interface Report {
  headline: string;
  openingParagraph: string;
  sections: { title: string; paragraphs: string[]; factIds: string[] }[];
  oneLineForCard: string;
}

export const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    headline: { type: "string", description: "Under 12 words. No colon tricks, no question." },
    openingParagraph: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
          factIds: { type: "array", items: { type: "string" }, description: "Ids of the packet facts this section rests on." },
        },
        required: ["title", "paragraphs", "factIds"],
        additionalProperties: false,
      },
    },
    oneLineForCard: { type: "string", description: "One sentence, under 20 words, for the game card." },
  },
  required: ["headline", "openingParagraph", "sections", "oneLineForCard"],
  additionalProperties: false,
};

const STOP = new Set(
  "a an the this that these those it its if when while where which who whom whose what why how both neither either no not yes and but or nor for in on at to by with from of as into over under after before during until here there then now also still only even just more most less least much many few several each every any some all one two three four five six seven eight nine ten first second third fourth fifth last next watch expect look think call say see start keep give take get go come make put turn hold run pass throw block cover rush win lose edge advantage mismatch lean total side model market offense defense line front game half quarter drive snap carry carries yards points percent rate success explosive explosiveness pace tempo scouts scout nfl draft radar sleeper future eligible established emerging tier report pregame postgame final live kickoff et tv weather wind rain heat cold storm roof grass turf feels gusts humidity elevation no. vs mph lbs ft pct epa".split(/\s+/),
);

/** Capitalized tokens that are not in the packet are the fingerprint of an invented name. */
function unknownProperNouns(text: string, packet: Packet): string[] {
  const out = new Set<string>();
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const tokens = s.match(/[A-Z][A-Za-z'’.-]*/g) ?? [];
    tokens.forEach((raw, i) => {
      const tok = raw.replace(/['’]s$/i, "").replace(/[.'’-]+$/, "");
      if (tok.length < 2) return;
      const lower = tok.toLowerCase();
      if (packet.vocab.has(lower) || STOP.has(lower)) return;
      // Sentence-initial ordinary words ("Second", "Watch") are allowed; a run of two unknown capitals is not.
      const atStart = i === 0 && s.startsWith(raw);
      const next = tokens[i + 1]?.replace(/[.'’-]+$/, "").toLowerCase();
      if (atStart && !(next && !packet.vocab.has(next) && !STOP.has(next))) return;
      out.add(tok);
    });
  }
  return [...out];
}

function numberOk(n: number, packet: Packet): boolean {
  if (packet.numbers.includes(n)) return true;
  // Counts up to three are ordinary English ("2 of the 4 matchups"); anything larger, including a rank, must be in the packet.
  if (Number.isInteger(n) && n >= 0 && n <= 3) return true;
  const decimals = (String(n).split(".")[1] ?? "").length;
  for (const p of packet.numbers) {
    if (Number(p.toFixed(decimals)) === n) return true;
    // A percentage written from a 0..1 value, or the reverse.
    if (Math.abs(p * 100 - n) < 0.051 || Math.abs(p / 100 - n) < 0.0051) return true;
    // A margin or total rounded to the nearest whole or half point.
    if (Math.abs(p - n) < 0.5 && decimals === 0 && !Number.isInteger(p)) return true;
  }
  return false;
}

export function reportText(r: Report): string {
  return [r.headline, r.openingParagraph, ...r.sections.flatMap((s) => [s.title, ...s.paragraphs]), r.oneLineForCard].join("\n");
}

export function wordCount(r: Report): number {
  return [r.openingParagraph, ...r.sections.flatMap((s) => s.paragraphs)].join(" ").split(/\s+/).filter(Boolean).length;
}

/** Returns a list of violations. Empty means the report only says what the packet says. */
export function validateReport(r: Report, packet: Packet): string[] {
  const v: string[] = [];
  if (!r || typeof r.headline !== "string" || !Array.isArray(r.sections) || !r.sections.length) return ["report is not in the required shape"];
  const text = reportText(r);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) v.push("contains an emoji");
  if (/[—–]/.test(text)) v.push("contains an em dash or en dash; use commas, periods, or 'to'");
  const words = wordCount(r);
  if (words < 240) v.push(`too short: ${words} words in the body, need 250 to 450`);
  if (words > 460) v.push(`too long: ${words} words in the body, need 250 to 450`);
  if (/\b(packet|fact ids?|evidence ids?|the data says|the data shows)\b/i.test(text)) v.push("mentions the packet or the data instead of just stating the evidence");
  const ids = new Set(packet.facts.map((f) => f.id));
  for (const s of r.sections) for (const id of s.factIds ?? []) if (!ids.has(id)) v.push(`section "${s.title}" cites unknown fact id ${id}`);
  const badNums = [...new Set(numbersIn(text).filter((n) => !numberOk(n, packet)))];
  if (badNums.length) v.push(`numbers not in the evidence packet: ${badNums.join(", ")}`);
  const badNames = unknownProperNouns(text, packet);
  if (badNames.length) v.push(`names or proper nouns not in the evidence packet: ${badNames.join(", ")}`);
  return v;
}

/* ---------------------------------------------------------------- prompt */

const SYSTEM = `You write the written report for EdgeSheet NFL, a game guide for people deciding what to watch on Sunday.
Voice: confident, specific, numbers inside the sentences, no hedging filler, no emojis, no em dashes (use commas, periods, or "to"). Plain English. Short declarative sentences. Example of the house voice: "This is not a lean. It is a mismatch, and a prominent one."
Rules that cannot be broken:
1. Every number you write must appear in the evidence packet exactly as given (ranks, percentages, lines, scores, yards). Do not compute new numbers, do not round, do not add up.
2. Every player you name must be in the packet. Do not add coaches, players, or quotes from memory. If the packet does not name a quarterback, do not name one.
3. Do not invent schemes, injuries, history, or motivation. If something is not in the packet, it does not exist for this report.
4. Explain and rank the evidence. Say which matchup matters most and why. Model leans may be described the way the packet describes them (a model, not a pick). Never give betting advice, never tell the reader what to bet.
5. Length is a hard limit: 250 to 450 words counted across the opening paragraph and the section paragraphs together. Aim for 330. Two to four sections, one or two short paragraphs each. Each section lists the packet fact ids it rests on. Headline, section titles, and the card line are not counted.
6. Write as the house, not as a reader of a document. Never mention the packet, fact ids, "the data", or "the evidence shows". State the fact. Section titles are plain, no numbering.
Return only the JSON object.`;

function userPrompt(packet: Packet, previous?: { report: Report; violations: string[] }): string {
  const lines = packet.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const retry = previous
    ? `\n\nYour previous attempt was rejected. Violations:\n${previous.violations.map((x) => `- ${x}`).join("\n")}\nRewrite the whole report and fix every item. Remove any number or name that is not in the packet rather than rephrasing it. If it was too long, cut whole sentences until the body is under 400 words; if too short, add evidence from the packet.\n\nPrevious attempt (${wordCount(previous.report)} body words):\n${JSON.stringify(previous.report)}`
    : "";
  return `Game: ${packet.title}. ${packet.pregame ? "Pregame." : "The game has started or finished; write about what the evidence shows, including any graded results."}\n\nEvidence packet (the only source you may use):\n${lines}\n\nPlayers you may name: ${packet.names.length ? packet.names.join("; ") : "none, the packet names no players"}.${retry}\n\nWrite the report as JSON with keys headline, openingParagraph, sections (title, paragraphs, factIds), oneLineForCard.`;
}

/* ----------------------------------------------------------------- cache */

export interface CachedReport {
  gameId: string;
  season: number;
  generatedAt: string;
  provider: Provider;
  model: string;
  pregame: boolean;
  evidenceAsOf: string;
  attempts: number;
  /** Violations found on each attempt, in order. Empty array means that attempt passed. */
  attemptLog: string[][];
  words?: number;
  usage: Usage;
  report?: Report;
  failed?: { reasons: string[] };
  factCount: number;
}

const DIR = path.join(process.cwd(), "data", "ai", "reports");

export function seasonOf(kickoffIso: string): number {
  const d = new Date(kickoffIso);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() + 1 <= 2 ? y - 1 : y;
}

const file = (season: number, id: string) => path.join(DIR, String(season), `${id}.json`);

export function readReport(season: number, gameId: string): CachedReport | undefined {
  const f = file(season, gameId);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as CachedReport;
  } catch {
    return undefined;
  }
}

function writeReport(c: CachedReport) {
  const f = file(c.season, c.gameId);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 1));
}

/** Which provider would write, or what key is missing. For the UI note. */
export const reportProvider = () => llmInfo();

/* -------------------------------------------------------------- generate */

export async function generateReport(game: Game, opts: { force?: boolean } = {}): Promise<CachedReport | Unavailable> {
  const season = seasonOf(game.kickoff);
  if (!opts.force) {
    const cached = readReport(season, game.id);
    if (cached?.report) return cached;
  }
  const packet = buildPacket(game);
  let previous: { report: Report; violations: string[] } | undefined;
  let attempts = 0;
  let provider: Provider = "anthropic";
  let model = "";
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  let lastViolations: string[] = [];
  const attemptLog: string[][] = [];
  for (let i = 0; i < 2; i++) {
    attempts++;
    const res = await generateJSON<Report>(userPrompt(packet, previous), REPORT_SCHEMA, { system: SYSTEM, purpose: "report", ref: game.id });
    if (isUnavailable(res)) return res;
    provider = res.provider;
    model = res.model;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens;
    usage.costUsd += res.usage.costUsd;
    const violations = validateReport(res.data, packet);
    attemptLog.push(violations);
    if (!violations.length) {
      const out: CachedReport = { gameId: game.id, season, generatedAt: new Date().toISOString(), provider, model, pregame: packet.pregame, evidenceAsOf: packet.evidenceAsOf, attempts, attemptLog, words: wordCount(res.data), usage, report: res.data, factCount: packet.facts.length };
      writeReport(out);
      return out;
    }
    lastViolations = violations;
    previous = { report: res.data, violations };
  }
  const out: CachedReport = { gameId: game.id, season, generatedAt: new Date().toISOString(), provider, model, pregame: packet.pregame, evidenceAsOf: packet.evidenceAsOf, attempts, attemptLog, usage, failed: { reasons: lastViolations }, factCount: packet.facts.length };
  writeReport(out);
  return out;
}
