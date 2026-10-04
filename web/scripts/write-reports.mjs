#!/usr/bin/env node
/**
 * Write reports on purpose, not for every game. Finds today's Division I games
 * that already have a pregame lock in data/archive (locks are only taken for
 * FBS and FCS) and posts each one to the running server's /api/report, one at
 * a time. Cached reports are skipped by the route unless --force is given.
 *
 *   node scripts/write-reports.mjs                # today's locked D1 games
 *   node scripts/write-reports.mjs --date 2026-10-04
 *   node scripts/write-reports.mjs --ids 401858249,401856706
 *   node scripts/write-reports.mjs --dry           # list, do not write
 *   node scripts/write-reports.mjs --force         # rewrite even if cached
 *   node scripts/write-reports.mjs --limit 5
 *   BASE=http://localhost:3000 (default)
 *
 * Budget: roughly 4,000 input and 900 output tokens per report (two attempts at most),
 * about 2 to 5 cents on claude-opus-5 or gpt-5.4. A 40-game Saturday is about a dollar.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = process.env.BASE || "http://localhost:3000";
const ET = "America/New_York";
const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const date = opt("date") || etDate();
const season = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) <= 2 ? 1 : 0);
const limit = Number(opt("limit") || 0) || Infinity;
const force = flag("force");

let ids = (opt("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!ids.length) {
  const dir = path.join(process.cwd(), "data", "archive", String(season));
  if (!existsSync(dir)) {
    console.log(`No archive for ${season} at ${dir}. Open the slate once so locks are taken.`);
    process.exit(0);
  }
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (etDate(new Date(e.pregame.kickoff)) === date) rows.push({ id: e.gameId, label: `${e.pregame.away} at ${e.pregame.home}`, kickoff: e.pregame.kickoff, score: e.pregame.scoutScore });
    } catch {}
  }
  rows.sort((a, b) => b.score - a.score);
  ids = rows.slice(0, limit).map((r) => r.id);
  console.log(`${rows.length} locked Division I games on ${date}${Number.isFinite(limit) ? `, taking the top ${ids.length} by Watch Score` : ""}.`);
  for (const r of rows.slice(0, limit)) console.log(`  ${r.id}  ${r.label}  (score ${r.score})`);
}

if (flag("dry")) process.exit(0);
if (!ids.length) process.exit(0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cost = 0;
let ok = 0;
let failed = 0;
for (const id of ids) {
  const started = Date.now();
  process.stdout.write(`${id} ... `);
  try {
    const res = await fetch(`${BASE}/api/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, force }) });
    const j = await res.json().catch(() => ({}));
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (res.ok && j.ok) {
      ok++;
      cost += j.costUsd || 0;
      console.log(`written by ${j.model}, ${j.words} words, ${j.attempts} attempt${j.attempts === 1 ? "" : "s"}, $${(j.costUsd || 0).toFixed(4)}, ${secs}s`);
    } else if (j.unavailable) {
      console.log(`stopped: ${j.error}`);
      break;
    } else if (j.failed) {
      failed++;
      console.log(`NOT published: ${j.failed.reasons.join(" / ")}`);
    } else {
      failed++;
      console.log(`error ${res.status}: ${j.error || "unknown"}`);
    }
  } catch (err) {
    failed++;
    console.log(`error: ${err.message}`);
  }
  await sleep(1500);
}
console.log(`\n${ok} written, ${failed} not published, about $${cost.toFixed(3)} spent (per usage log in data/ai/usage.jsonl).`);
