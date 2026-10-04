/**
 * One Odds API snapshot for this week's NFL games that have not kicked off.
 *
 *   node scripts/odds-snapshot.mjs            # 1 Odds API call (3 credits), no other network
 *   node scripts/odds-snapshot.mjs --dry      # 0 credits: lists events via the free /events endpoint and reports matches
 *   node scripts/odds-snapshot.mjs --reserve 60   # refuse to spend when fewer than 60 credits remain (default 40)
 *
 * Appends to data/odds/<season>/<gameId>.json and records quota headers in data/odds/usage.json.
 * Budget: the 500 free credits a month are shared with the college app. NFL runs every 6 hours
 * Thu through Mon (20 calls a week, 60 credits, about 260 a month); college runs every 4 hours
 * Wed through Sat. Props are on demand only.
 *
 * The slate comes from data/generated/schedule.json (scripts/ingest.mjs), no key needed.
 */
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendSnapshot, fetchEventList, fetchSlateOdds, isoWindow, matchEvents, readUsage } from "../src/lib/odds-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const reserveArg = args.indexOf("--reserve");
const RESERVE = reserveArg >= 0 ? Number(args[reserveArg + 1]) : Number(process.env.ODDS_RESERVE ?? 40);

async function loadEnv() {
  try {
    const env = await readFile(path.join(root, ".env.local"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
await loadEnv();

const ODDS = process.env.ODDS_API_KEY;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

if (!ODDS) {
  console.error("odds-snapshot: ODDS_API_KEY missing. Add it to .env.local. Nothing written.");
  process.exit(0);
}

let schedule;
try {
  schedule = JSON.parse(readFileSync(path.join(root, "data", "generated", "schedule.json"), "utf8"));
} catch {
  console.error("odds-snapshot: data/generated/schedule.json missing. Run npm run ingest first. Nothing written.");
  process.exit(0);
}
const teamTable = JSON.parse(readFileSync(path.join(root, "data", "nfl-teams.json"), "utf8")).teams;
const teamsBySchool = new Map(teamTable.map((t) => [t.short, { school: t.location, mascot: t.short, abbreviation: t.abbr }]));

const now = new Date();
const season = Number(process.env.SEASON ?? (now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1));
const thisSeason = schedule.filter((g) => g.season === season);
// Current week: the smallest week with an unplayed game, plus any other game kicking off inside the next 8 days.
const unplayed = thisSeason.filter((g) => !g.played);
if (!unplayed.length) {
  log("no unplayed games this season; nothing to do");
  process.exit(0);
}
const week = Math.min(...unplayed.map((g) => g.week));
const horizon = Date.now() + 8 * 86400 * 1000;
const open = unplayed.filter((g) => (g.week === week || Date.parse(g.kickoff) <= horizon) && Date.parse(g.kickoff) > Date.now() - 4 * 3600 * 1000);
log("season", season, "week", week, "games not yet kicked off", open.length);
const refs = open.map((g) => ({ id: String(g.id), home: g.home, away: g.away, kickoff: g.kickoff }));

const usage = readUsage(root);
if (!DRY && usage.remaining !== undefined && usage.remaining <= RESERVE) {
  log(`quota ${usage.remaining} credits left, reserve is ${RESERVE}; not spending. Use --reserve to lower it.`);
  process.exit(0);
}

const nowIso = now.toISOString();
const events = DRY ? await fetchEventList(ODDS) : await fetchSlateOdds(root, ODDS, isoWindow(now));
log("Odds API events", events.length, DRY ? "(dry: no odds, no credits)" : "");

const matches = matchEvents(refs, events, teamsBySchool);
let appended = 0;
let unchanged = 0;
for (const r of refs) {
  const m = matches.get(r.id);
  if (!m) continue;
  if (DRY) {
    log(`match ${r.away} @ ${r.home}  <-  ${m.event.away_team} @ ${m.event.home_team}${m.swapped ? " (swapped)" : ""}  score ${m.score.toFixed(1)}`);
    continue;
  }
  const { appended: did } = appendSnapshot(root, { season, gameId: r.id, home: r.home, away: r.away, kickoff: r.kickoff, event: m.event, swapped: m.swapped, at: nowIso });
  if (did) appended++;
  else unchanged++;
}
const unmatchedEvents = events.filter((e) => ![...matches.values()].some((m) => m.event.id === e.id));
log("matched", matches.size, "of", refs.length, "games;", unmatchedEvents.length, "events had no game");
for (const e of unmatchedEvents.slice(0, 15)) log("  no match:", e.away_team, "@", e.home_team, e.commence_time);
for (const r of refs) if (!matches.has(r.id)) log("  unmatched game:", r.away, "@", r.home, r.kickoff);
if (!DRY) {
  const u = readUsage(root);
  log("appended", appended, "unchanged", unchanged, `credits remaining ${u.remaining ?? "unknown"}, used ${u.used ?? "unknown"}`);
}
