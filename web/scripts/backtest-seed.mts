/**
 * Check src/lib/seed.ts against real playoff fields, 2019 to 2025.
 *
 *   npx tsx scripts/backtest-seed.mts          (npm run backtest:seed)
 *
 * For each season: standings from the regular-season finals in data/generated/schedule.json, then the seeds compared
 * with what the postseason games say. The schedule has no seed column, so the seeds are read from the bracket:
 *   field     every team in a wild card game, plus the bye teams (in the divisional round, not the wild card round)
 *   byes      the 1 seed (seeds 1 and 2 in 2019, with six teams a conference)
 *   pairs     wild card games are 2 v 7, 3 v 6, 4 v 5 (3 v 6, 4 v 5 in 2019): our seeds for each pair must add to 9,
 *             the lower seed at home
 *   one seed  in the divisional round the 1 seed hosts the lowest seed left, which also orders 1 and 2 in 2019
 * A seed counts as matched when every check that touches it passes. Writes data/backtest/seed.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { genSchedule } from "../src/lib/generated";
import { nflTeams } from "../src/lib/nfl";
import { playoffTeamsFor, standingsFrom, type SeedGame } from "../src/lib/seed";

const teams = nflTeams().map((t) => ({ short: t.short, conf: t.conf, div: t.div }));
const confOf = new Map(teams.map((t) => [t.short, t.conf]));
const sched = genSchedule();
const out: unknown[] = [];
let allField = 0;
let allFieldN = 0;
let allSeeds = 0;
let allSeedsN = 0;

for (let season = 2019; season <= 2025; season++) {
  const games: SeedGame[] = sched.filter((g) => g.season === season && g.type === "REG" && g.played && g.hs != null && g.as != null).map((g) => ({ home: g.home, away: g.away, hs: g.hs!, as: g.as! }));
  const rows = standingsFrom(season, teams, games);
  const seed = new Map(rows.map((r) => [r.team, r.seed]));
  const P = playoffTeamsFor(season);
  const post = sched.filter((g) => g.season === season && g.type === "POST");
  const wc = post.filter((g) => g.round === "WC");
  const div = post.filter((g) => g.round === "DIV");
  const inWc = new Set(wc.flatMap((g) => [g.home, g.away]));
  const byes = [...new Set(div.flatMap((g) => [g.home, g.away]))].filter((t) => !inWc.has(t));
  const field = new Set([...inWc, ...byes]);
  const mismatches: string[] = [];
  const bad = new Set<string>();

  // Field.
  const ours = new Set(rows.filter((r) => r.inPlayoffs).map((r) => r.team));
  const fieldHits = [...field].filter((t) => ours.has(t)).length;
  for (const t of field) if (!ours.has(t)) { mismatches.push(`${t} made the playoffs; we have them No. ${seed.get(t)}.`); bad.add(t); }
  for (const t of ours) if (!field.has(t)) mismatches.push(`${t} are in our field at No. ${seed.get(t)} but missed the playoffs.`);

  // Byes.
  for (const conf of ["AFC", "NFC"]) {
    const confByes = byes.filter((t) => confOf.get(t) === conf);
    const want = season >= 2020 ? [1] : [1, 2];
    const got = confByes.map((t) => seed.get(t) ?? 0).sort((a, b) => a - b);
    if (got.join() !== want.join()) {
      mismatches.push(`${conf} bye ${confByes.join(" and ")}: we have seeds ${got.join(" and ")}, the bracket says ${want.join(" and ")}.`);
      confByes.forEach((t) => bad.add(t));
    }
  }
  // Wild card pairs.
  for (const g of wc) {
    const h = seed.get(g.home) ?? 0;
    const a = seed.get(g.away) ?? 0;
    if (h + a !== 9 || h >= a) {
      mismatches.push(`Wild card ${g.away} at ${g.home}: we have No. ${a} at No. ${h}; the pair must be 2 v 7, 3 v 6, or 4 v 5 with the lower seed at home.`);
      bad.add(g.home);
      bad.add(g.away);
    }
  }
  // The 1 seed hosts the lowest seed left in the divisional round.
  for (const conf of ["AFC", "NFC"]) {
    const games = div.filter((g) => confOf.get(g.home) === conf);
    const one = games.find((g) => seed.get(g.home) === 1);
    const lowest = Math.max(...games.map((g) => seed.get(g.away) ?? 0));
    if (!one || (seed.get(one.away) ?? 0) !== lowest) {
      mismatches.push(`${conf} divisional round: our 1 seed ${one ? one.home : "did not host"}${one ? ` hosted No. ${seed.get(one.away)}` : ""}, the lowest seed left is No. ${lowest}.`);
      for (const g of games) bad.add(g.home);
    }
  }
  const seedHits = [...field].filter((t) => ours.has(t) && !bad.has(t)).length;
  allField += fieldHits;
  allFieldN += field.size;
  allSeeds += seedHits;
  allSeedsN += field.size;
  // Tiebreak notes that decided a playoff place, for the record.
  const notes = rows.filter((r) => r.note && (r.inPlayoffs || field.has(r.team))).map((r) => `${r.team}: ${r.note}`);
  out.push({ season, playoffTeams: P * 2, fieldMatched: fieldHits, seedsMatched: seedHits, mismatches, tiebreakNotes: notes });
  console.log(`${season}: field ${fieldHits}/${field.size}, seeds ${seedHits}/${field.size}${mismatches.length ? `\n  ${mismatches.join("\n  ")}` : ""}`);
}
console.log(`All seasons: field ${allField}/${allFieldN}, seeds ${allSeeds}/${allSeedsN}`);
const dir = path.join(process.cwd(), "data", "backtest");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "seed.json"), JSON.stringify({ builtAt: new Date().toISOString(), field: `${allField}/${allFieldN}`, seeds: `${allSeeds}/${allSeedsN}`, seasons: out }, null, 2));
