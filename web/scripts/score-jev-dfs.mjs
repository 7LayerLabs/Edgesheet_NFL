/**
 * Grade the Jev news judgments (src/lib/jev-dfs.ts) against who actually played.
 *
 *   node scripts/score-jev-dfs.mjs
 *
 * Reads data/dk/jev-dfs.jsonl. Per player and game, the last judgment made before kickoff counts.
 * The week comes from data/generated/schedule.json (his team's game at that kickoff). He played when
 * data/generated/gamelogs.json has a regular-season line for him that week. Only games already in the
 * game logs are graded, so a game whose stats are not posted yet never counts as a miss.
 * Known gap: nflverse writes no line for a zero-stat game, so an active player with no stats counts
 * as not playing.
 *
 * Prints the Brier score of Jev's play probability next to the status-only prior on the same players
 * (lower is better; Jev stays in the projection only if it beats the prior), and actual DK points
 * over projection by role level (DraftKings Classic scoring, as dkPoints in src/lib/dfs.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const LOG = path.join(root, "data", "dk", "jev-dfs.jsonl");
const GEN = path.join(root, "data", "generated");
const MATCH_MS = 6 * 3600_000; // a schedule kickoff within 6 h of the logged one is the same game

const readJson = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};

/** DraftKings Classic points for one stat line (no two-point conversions). Same formula as src/lib/dfs.ts. */
function dkPoints(s) {
  if (!s) return 0;
  const n = (k) => s[k] ?? 0;
  const py = n("py"), ry = n("ry"), rcy = n("rcy");
  const pts =
    py * 0.04 + n("ptd") * 4 - n("pint") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rtd") * 6 + (ry >= 100 ? 3 : 0) +
    n("rec") + rcy * 0.1 + n("rctd") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fl") + n("sttd") * 6;
  return Math.round(pts * 10) / 10;
}

const fmt = (x, d = 3) => (x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);

const rows = existsSync(LOG)
  ? readFileSync(LOG, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
  : [];
if (!rows.length) {
  console.log(`No Jev DFS judgments logged yet (${path.relative(root, LOG)}). Nothing to grade.`);
  process.exit(0);
}

// The last judgment before kickoff, per player and game.
const latest = new Map();
let afterKick = 0;
for (const r of rows) {
  if (!r.id || !r.kickoff || !r.at) continue;
  if (Date.parse(r.at) >= Date.parse(r.kickoff)) {
    afterKick++;
    continue;
  }
  const k = `${r.id}|${r.kickoff}`;
  const cur = latest.get(k);
  if (!cur || r.at > cur.at) latest.set(k, r);
}

const schedule = readJson(path.join(GEN, "schedule.json"), []);
const logs = readJson(path.join(GEN, "gamelogs.json"), { meta: {}, games: {}, players: {} });

let pending = 0;
let unmatched = 0;
const graded = [];
for (const r of latest.values()) {
  const k = Date.parse(r.kickoff);
  const game = schedule.find((g) => (g.home === r.team || g.away === r.team) && Math.abs(Date.parse(g.kickoff) - k) < MATCH_MS);
  if (!game) {
    unmatched++;
    continue;
  }
  const posted = game.season === logs.meta?.season && Object.values(logs.games ?? {}).some((g) => g.wk === game.week && g.st === "regular" && (g.home === r.team || g.away === r.team));
  if (!posted) {
    pending++;
    continue;
  }
  const line = (logs.players?.[r.id] ?? []).find((l) => l.wk === game.week && l.st === "regular");
  graded.push({ ...r, week: game.week, played: line ? 1 : 0, dk: line ? dkPoints(line.s) : 0 });
}

console.log(`Jev DFS judgments: ${rows.length} logged, ${latest.size} player-games judged before kickoff, ${afterKick} after kickoff (ignored).`);
console.log(`Graded ${graded.length}; waiting on stats ${pending}; no schedule match ${unmatched}.`);
if (!graded.length) process.exit(0);

// Brier on the same players: Jev's raw number, the status prior, and what the simulator used.
const brier = (list, key) => list.reduce((a, r) => a + (r[key] - r.played) ** 2, 0) / list.length;
const withJev = graded.filter((r) => typeof r.jevPlay === "number" && typeof r.prior === "number");
console.log("\nPlay probability (Brier, lower is better)");
console.log(`  ${pad("players", 22)}${pad("n", 6)}${pad("played", 8)}${pad("jev", 8)}${pad("prior", 8)}used`);
const brierRow = (label, list) =>
  console.log(`  ${pad(label, 22)}${pad(list.length, 6)}${pad(list.filter((r) => r.played).length, 8)}${pad(fmt(list.length ? brier(list, "jevPlay") : NaN), 8)}${pad(fmt(list.length ? brier(list, "prior") : NaN), 8)}${fmt(list.length ? brier(list, "pPlay") : NaN)}`);
brierRow("all judged", withJev);
brierRow("Jev number used", withJev.filter((r) => r.pPlaySource === "jev"));
brierRow("near 0.5, prior kept", withJev.filter((r) => r.pPlaySource !== "jev"));

// Role level against the outcome: actual DK points over projection, players who played and had a projection.
console.log("\nRole level vs outcome (played, with a projection)");
console.log(`  ${pad("role", 10)}${pad("n", 6)}${pad("proj", 9)}${pad("actual", 9)}actual/proj`);
for (const role of ["limited", "usual", "bigger"]) {
  const list = graded.filter((r) => r.role === role && r.played && typeof r.proj === "number" && r.proj > 0);
  const proj = list.reduce((a, r) => a + r.proj, 0);
  const actual = list.reduce((a, r) => a + r.dk, 0);
  console.log(`  ${pad(role, 10)}${pad(list.length, 6)}${pad(list.length ? fmt(proj / list.length, 1) : "-", 9)}${pad(list.length ? fmt(actual / list.length, 1) : "-", 9)}${proj ? fmt(actual / proj, 2) : "-"}`);
}
