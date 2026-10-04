#!/usr/bin/env node
/**
 * Write watch guides (the Why watch viewing guide) for a date's games.
 * Runs in-process through tsx so it can import the TypeScript libs directly.
 *
 *   npm run guides                       # today's Division I games (ET)
 *   npm run guides -- --date 2026-10-10
 *   npm run guides -- --limit 5          # top N by Watch Score
 *   npm run guides -- --ids 401858249,401856706
 *   npm run guides -- --force            # rewrite even when the evidence version matches
 *   npm run guides -- --dry              # list, do not write
 *   npm run guides -- --show 2           # print N finished guides to the console (default 2)
 *
 * Cached guides whose evidence version matches are skipped (free). Budget: about 2,500 input and
 * 500 output tokens per guide on claude-sonnet-5, roughly 1 cent, plus one small Jev request.
 */
import { readFileSync } from "node:fs";

// Keys: process.env first, then .env.local (the libs read ANTHROPIC and TYPESAFE themselves; CFBD must be present before slate loads).
try {
  const env = readFileSync(".env.local", "utf8");
  for (const k of ["ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "ODDS_API_KEY"]) {
    if (process.env[k]) continue;
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(.+)\\s*$`, "m").exec(env);
    if (m) process.env[k] = m[1].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(opt("limit") || 0) || Infinity;
const force = flag("force");
const show = Number(opt("show") ?? 2);
const BUDGET = Number(opt("budget") || 5); // dollars, hard stop

const { getSlate, getGame, etDate } = await import("../src/lib/slate");
const { scoutScore } = await import("../src/lib/score");
const { generateWatchGuide, buildCandidates } = await import("../src/lib/watchguide");
const { isUnavailable } = await import("../src/lib/llm");

const date = opt("date") || etDate();
let ids = (opt("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!ids.length) {
  const slate = await getSlate(date);
  const d1 = slate.games;
  const rows = d1.map((g) => ({ id: g.id, label: `${g.away.short} at ${g.home.short}`, status: g.status, score: scoutScore(g) })).sort((a, b) => b.score - a.score);
  console.log(`${rows.length} games on ${slate.date}${slate.date !== date ? ` (asked for ${date}, next slate date with games)` : ""}${Number.isFinite(limit) ? `, taking the top ${Math.min(limit, rows.length)} by Watch Score` : ""}.`);
  for (const r of rows.slice(0, limit)) console.log(`  ${r.id}  ${r.label.padEnd(40)} ${r.status.padEnd(9)} score ${r.score}`);
  ids = rows.slice(0, limit).map((r) => r.id);
}
if (flag("dry") || !ids.length) process.exit(0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cost = 0;
let written = 0;
let skipped = 0;
let failed = 0;
const finished = [];
for (const id of ids) {
  const started = Date.now();
  process.stdout.write(`${id} ... `);
  try {
    const game = await getGame(id);
    if (!game) {
      console.log("no such game");
      failed++;
      continue;
    }
    const before = cost;
    const out = await generateWatchGuide(game, { force });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (isUnavailable(out)) {
      console.log(`stopped: ${out.unavailable}`);
      break;
    }
    const fresh = Date.now() - new Date(out.generatedAt).getTime() < 120_000;
    if (out.guide && !fresh) {
      skipped++;
      console.log(`cached (evidence ${out.evidenceVersion}), skipped`);
      continue;
    }
    cost += out.usage.costUsd;
    if (out.guide) {
      written++;
      finished.push({ game, out });
      console.log(`${game.away.short} at ${game.home.short}: written by ${out.model}, ranked by ${out.ranker}${out.rankerNote ? ` (${out.rankerNote})` : ""}, ${out.attempts} attempt${out.attempts === 1 ? "" : "s"}, ${out.candidateCount} candidates, $${out.usage.costUsd.toFixed(4)}, ${secs}s`);
    } else {
      failed++;
      console.log(`${game.away.short} at ${game.home.short}: NOT published after ${out.attempts} attempt${out.attempts === 1 ? "" : "s"} ($${out.usage.costUsd.toFixed(4)}): ${out.failed?.reasons.join(" / ")}`);
      if (out.attemptLog.length) for (const [i, log] of out.attemptLog.entries()) console.log(`    attempt ${i + 1}: ${log.length ? log.join(" / ") : "passed"}`);
    }
    if (cost - before === 0 && !out.guide) console.log(`    candidates: ${buildCandidates(game).length}`);
  } catch (err) {
    failed++;
    console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cost >= BUDGET) {
    console.log(`Budget of $${BUDGET} reached, stopping.`);
    break;
  }
  await sleep(1200);
}

console.log(`\n${written} written, ${skipped} cached, ${failed} not published, about $${cost.toFixed(3)} spent${written ? ` ($${(cost / written).toFixed(4)} per guide written)` : ""}.`);

for (const { game, out } of finished.slice(0, show)) {
  const g = out.guide;
  console.log(`\n==== ${game.away.short} at ${game.home.short} (${game.status}) ====`);
  console.log(`HEADLINE: ${g.headline}`);
  console.log(`HOOK: ${g.hook}`);
  g.items.forEach((it, i) => {
    console.log(`\n${i + 1}. ${it.title}  [${it.who}${it.whoPlayerId ? `, id ${it.whoPlayerId}` : ""}]`);
    console.log(`   ${it.what}`);
    console.log(`   When: ${it.when}   (facts ${it.factIds.join(", ")})`);
  });
  console.log(`CARD: ${g.cardLine}`);
  console.log(`ranked by ${out.ranker}; top five: ${out.top.map((t) => `${t.id}:${t.kind}${t.jev !== undefined ? `@${t.jev.toFixed(2)}` : ""}`).join(", ")}`);
}
