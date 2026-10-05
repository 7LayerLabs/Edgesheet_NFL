/**
 * Shared TypeSafe Jev client. Jev is a System One judgment model: send `state`
 * (a string or JSON) plus typed questions and get calibrated probabilities back.
 * It does not write text. Three question types:
 *   noul   -> probability (0..1) that a yes/no condition holds
 *   choice -> one option out of a set, with a probability per option
 *   score  -> position on ordered descriptive levels (0..levels-1), with probabilities
 *
 * Everything here degrades: no key, timeout, or any API error returns `undefined`
 * and the caller falls back to its non-AI path. Never throw past this module.
 * Per attempt timeout 5s, one retry, usage appended to data/ai/usage.jsonl in the
 * same shape the LLM adapter writes (provider "typesafe").
 *
 * Server only (reads node:fs for the key fallback and the usage log). Do not import
 * from a client component.
 *
 * Usage, one request, many independent questions over the same state:
 *   const a = await askJev({ post: text, player: {...} }, {
 *     injury: noulQ("Does `post` report an injury to `player`?"),
 *     drama: scoreQ("How dramatic is `game` right now?", ["blowout", "competitive", "deciding moment"]),
 *   }, { purpose: "feed" });
 *   if (a) a.injury.noul, a.drama.score
 *
 * Or the flat helpers: nouls(), choice(), score().
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TypeSafeClient,
  noul as sdkNoul,
  score as sdkScore,
  choice as sdkChoice,
  type ChoiceCriteria,
  type ChoiceQuestion,
  type EntryType,
  type NoulQuestion,
  type Questions,
  type ScoreCriteria,
  type ScoreQuestion,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

export type JevState = EntryType;
export type JevAnswers<Q extends Questions> = SystemOneResult<Q>["answers"];

export interface JevOpts {
  /** Tag written to the usage log ("feed", "report-verify", "flip"). */
  purpose?: string;
  /** Free-form reference for the usage log (game id, page). */
  ref?: string;
  /** Per attempt timeout. Default 5000. */
  timeoutMs?: number;
  /** Model override. Default jev-latest (or TYPESAFE_DEFAULT_MODEL). */
  model?: string;
}

const TIMEOUT_MS = 5000;
const RETRIES = 1;
const USAGE_FILE = path.join(process.cwd(), "data", "ai", "usage.jsonl");

/* ------------------------------------------------------------------ key */

let envLoaded = false;
/** TYPESAFE_* lines from an env file, empty values dropped. */
function typesafeKeys(f: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(f)) return out;
  let text = "";
  try {
    text = readFileSync(f, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(TYPESAFE_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    const v = m?.[2].replace(/^["']|["']$/g, "").trim();
    if (m && v) out[m[1]] = v;
  }
  return out;
}
/**
 * The project's own key (web/.env.local) wins over a machine-wide TYPESAFE_API_KEY, which belongs to other projects
 * (Next only fills .env.local values that the environment has not set, so this is applied here). With no project key,
 * the environment, then ~/scripts/.env.
 */
function loadFallbackEnv() {
  if (envLoaded) return;
  envLoaded = true;
  Object.assign(process.env, typesafeKeys(path.join(process.cwd(), ".env.local")));
  if (process.env.TYPESAFE_API_KEY?.trim()) return;
  for (const [k, v] of Object.entries(typesafeKeys(path.join(os.homedir(), "scripts", ".env")))) if (!process.env[k]) process.env[k] = v;
}

function apiKey(): string | undefined {
  loadFallbackEnv();
  const v = process.env.TYPESAFE_API_KEY?.trim();
  return v ? v : undefined;
}

/** True when a key is present. Safe to call from server components for a UI note. */
export function jevAvailable(): boolean {
  return Boolean(apiKey());
}

/** Human note for the UI when Jev is off. */
export const JEV_MISSING_NOTE = "add TYPESAFE_API_KEY to .env.local";

/* --------------------------------------------------------------- client */

let client: TypeSafeClient | undefined;
function getClient(): TypeSafeClient | undefined {
  const key = apiKey();
  if (!key) return undefined;
  if (client) return client;
  try {
    client = new TypeSafeClient({
      apiKey: key,
      timeout: TIMEOUT_MS,
      logLevel: "off",
      retry: { maxRetries: RETRIES, backoffInitialMs: 300, backoffMaxMs: 1500 },
    });
  } catch {
    return undefined;
  }
  return client;
}

/* ---------------------------------------------------------------- usage */

/**
 * The API does not return a price. docs.typesafe.ai/models lists jev at $0.042 per million
 * input tokens, output free (read 2026-10-03). Override with TYPESAFE_PRICE_IN / TYPESAFE_PRICE_OUT.
 */
const PRICE_IN_PER_MTOK = 0.042;
function costUsd(input: number, output: number): number {
  const pin = Number(process.env.TYPESAFE_PRICE_IN ?? PRICE_IN_PER_MTOK);
  const pout = Number(process.env.TYPESAFE_PRICE_OUT ?? 0);
  return (input * pin + output * pout) / 1_000_000;
}

function logUsage(entry: { model: string; purpose: string; ref?: string; input: number; output: number; costUsd: number; ms: number; questions: number; ok: boolean; error?: string }) {
  try {
    mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    appendFileSync(USAGE_FILE, JSON.stringify({ at: new Date().toISOString(), provider: "typesafe", ...entry, cacheRead: 0 }) + "\n");
  } catch {}
}

/** Last error message from askJev, for scripts and debug notes. Never shown to a fan. */
export let lastJevError: string | undefined;

/* ---------------------------------------------------------------- askJev */

/**
 * One request: every question sees the same state and is answered independently.
 * Returns the typed answers map, or undefined when Jev is off or the call failed.
 */
export async function askJev<const Q extends Questions>(state: JevState, questions: Q, opts: JevOpts = {}): Promise<JevAnswers<Q> | undefined> {
  const c = getClient();
  if (!c) {
    lastJevError = "TYPESAFE_API_KEY missing";
    return undefined;
  }
  const n = Object.keys(questions).length;
  if (n === 0) return undefined;
  const started = Date.now();
  try {
    const res = await c.systemOne({ state, questions, ...(opts.model ? { model: opts.model } : {}) }, { timeout: opts.timeoutMs ?? TIMEOUT_MS });
    logUsage({
      model: res.model,
      purpose: opts.purpose ?? "jev",
      ref: opts.ref,
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      costUsd: costUsd(res.usage.input_tokens, res.usage.output_tokens),
      ms: Date.now() - started,
      questions: n,
      ok: true,
    });
    lastJevError = undefined;
    return res.answers;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastJevError = msg;
    logUsage({ model: opts.model ?? "jev-latest", purpose: opts.purpose ?? "jev", ref: opts.ref, input: 0, output: 0, costUsd: 0, ms: Date.now() - started, questions: n, ok: false, error: msg.slice(0, 200) });
    return undefined;
  }
}

/* ------------------------------------------------------- question builders */

/** A yes/no question. `yes` and `no` describe what each outcome means (optional, recommended). */
export function noulQ(instructions: EntryType, yes?: EntryType, no?: EntryType): NoulQuestion {
  return yes === undefined && no === undefined ? sdkNoul(instructions) : sdkNoul(instructions, { true: yes ?? null, false: no ?? null });
}

/** Ordered levels, index 0 first. Each level should describe a concrete situation. */
export function scoreQ<const T extends ScoreCriteria>(instructions: EntryType, levels: T): ScoreQuestion<T> {
  return sdkScore(instructions, levels);
}

/** Pick one option. Map option -> description (null for none). Add a no-match option when nothing may fit. */
export function choiceQ<const T extends ChoiceCriteria>(instructions: EntryType, options: T): ChoiceQuestion<T> {
  return sdkChoice(instructions, options);
}

/* ------------------------------------------------------------ flat helpers */

/** A noul question as a string, or with yes/no criteria. */
export type NoulSpec = string | { q: EntryType; yes?: EntryType; no?: EntryType };

/**
 * Several yes/no questions over one state in one request. Returns {key: probability}.
 *   const p = await nouls({ post, player }, { injury: "Does `post` report an injury to `player`?", praise: {...} });
 */
export async function nouls<K extends string>(state: JevState, questions: Record<K, NoulSpec>, opts?: JevOpts): Promise<Record<K, number> | undefined> {
  const qs: Record<string, NoulQuestion> = {};
  for (const k of Object.keys(questions) as K[]) {
    const spec = questions[k];
    qs[k] = typeof spec === "string" ? noulQ(spec) : noulQ(spec.q, spec.yes, spec.no);
  }
  const a = await askJev(state, qs, opts);
  if (!a) return undefined;
  const out = {} as Record<K, number>;
  for (const k of Object.keys(questions) as K[]) {
    const ans = a[k];
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return undefined;
    out[k] = ans.noul;
  }
  return out;
}

export interface ChoiceResult<K extends string = string> {
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

/** One pick out of a set. Returns the chosen option plus the distribution. */
export async function choice<K extends string>(state: JevState, instructions: EntryType, options: Record<K, EntryType>, opts?: JevOpts): Promise<ChoiceResult<K> | undefined> {
  const a = await askJev(state, { pick: sdkChoice(instructions, options as ChoiceCriteria) }, opts);
  const ans = a?.pick;
  if (!ans || ans.type !== "choice") return undefined;
  return { choice: ans.choice as K, probabilities: { ...(ans.probabilities as Record<K, number>) }, confidence: ans.confidence };
}

export interface ScoreResult {
  /** Probability-weighted level, 0 .. levels.length-1, may fall between levels. */
  score: number;
  /** Same thing scaled to 0..1. */
  unit: number;
  /** Probability per level index. */
  probabilities: number[];
  confidence: number;
  /** The level with the highest probability. */
  top: number;
}

/** One position on ordered levels. `levels[0]` is the lowest. */
export async function score(state: JevState, instructions: EntryType, levels: readonly string[], opts?: JevOpts): Promise<ScoreResult | undefined> {
  if (levels.length < 2) return undefined;
  const a = await askJev(state, { rate: sdkScore(instructions, levels as unknown as ScoreCriteria) }, opts);
  const ans = a?.rate;
  if (!ans || ans.type !== "score") return undefined;
  return toScoreResult(ans, levels.length);
}

/** Convert a raw Score answer (from askJev) into the plain ScoreResult shape. */
export function toScoreResult(ans: { score: number; confidence: number; probabilities: Record<string, number> }, levelCount: number): ScoreResult {
  const probabilities: number[] = [];
  for (let i = 0; i < levelCount; i++) probabilities.push(ans.probabilities[String(i)] ?? 0);
  let top = 0;
  probabilities.forEach((p, i) => {
    if (p > probabilities[top]) top = i;
  });
  return { score: ans.score, unit: levelCount > 1 ? ans.score / (levelCount - 1) : 0, probabilities, confidence: ans.confidence, top };
}

/* --------------------------------------------------- batch over many items */

/**
 * Ask the same set of questions about many items in ONE request. State becomes
 * {shared, items: [...]} and each question is rewritten per item to point at `items[i]`.
 * The question text must contain the token ITEM, which is replaced by the path.
 *   batchNouls(items, { injury: "Does ITEM.text report an injury to ITEM.player?" }, { shared })
 * Returns one {key: probability} per item (same order), or undefined.
 * Jev takes text only, so keep items small (a post, a name, a few fields). Callers chunk if needed.
 */
export async function batchNouls<K extends string>(
  items: JevState[],
  questions: Record<K, NoulSpec>,
  opts: JevOpts & { shared?: Record<string, EntryType>; chunk?: number } = {},
): Promise<Record<K, number>[] | undefined> {
  if (items.length === 0) return [];
  const chunk = Math.max(1, opts.chunk ?? 25);
  if (items.length > chunk) {
    const out: Record<K, number>[] = [];
    for (let i = 0; i < items.length; i += chunk) {
      const part = await batchNouls(items.slice(i, i + chunk), questions, { ...opts, chunk: items.length });
      if (!part) return undefined;
      out.push(...part);
    }
    return out;
  }
  const sub = (s: EntryType, i: number): EntryType => {
    if (typeof s === "string") return s.replace(/ITEM/g, `items[${i}]`);
    if (s === null) return null;
    return JSON.parse(JSON.stringify(s).replace(/ITEM/g, `items[${i}]`)) as EntryType;
  };
  const qs: Record<string, NoulQuestion> = {};
  const keys = Object.keys(questions) as K[];
  items.forEach((_, i) => {
    for (const k of keys) {
      const spec = questions[k];
      qs[`${k}__${i}`] = typeof spec === "string" ? noulQ(sub(spec, i)) : noulQ(sub(spec.q, i), spec.yes === undefined ? undefined : sub(spec.yes, i), spec.no === undefined ? undefined : sub(spec.no, i));
    }
  });
  const state: JevState = { ...(opts.shared ?? {}), items: items as never };
  const a = await askJev(state, qs, opts);
  if (!a) return undefined;
  return items.map((_, i) => {
    const row = {} as Record<K, number>;
    for (const k of keys) {
      const ans = a[`${k}__${i}`];
      row[k] = ans && ans.type === "noul" ? ans.noul : 0;
    }
    return row;
  });
}

/**
 * Same idea for one Score per item in one request. Returns one ScoreResult per item.
 */
export async function batchScores(
  items: JevState[],
  instructions: EntryType,
  levels: readonly string[],
  opts: JevOpts & { shared?: Record<string, EntryType> } = {},
): Promise<ScoreResult[] | undefined> {
  if (items.length === 0) return [];
  if (levels.length < 2) return undefined;
  const qs: Record<string, ScoreQuestion> = {};
  items.forEach((_, i) => {
    const ins = typeof instructions === "string" ? instructions.replace(/ITEM/g, `items[${i}]`) : (JSON.parse(JSON.stringify(instructions).replace(/ITEM/g, `items[${i}]`)) as EntryType);
    qs[`s__${i}`] = sdkScore(ins, levels as unknown as ScoreCriteria);
  });
  const state: JevState = { ...(opts.shared ?? {}), items: items as never };
  const a = await askJev(state, qs, opts);
  if (!a) return undefined;
  return items.map((_, i) => {
    const ans = a[`s__${i}`];
    if (!ans || ans.type !== "score") return { score: 0, unit: 0, probabilities: [], confidence: 0, top: 0 };
    return toScoreResult(ans, levels.length);
  });
}
