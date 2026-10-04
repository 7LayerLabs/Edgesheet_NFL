/**
 * Offline check of the report validator with fake model output. No key needed.
 *   npx tsx scripts/test-report-validation.ts
 * Builds the packet from a real archived game if the schedule digest is present, otherwise a stub.
 */
import { buildPacket, validateReport, type Report } from "../src/lib/report";
import type { Game } from "../src/lib/types";

const game: Game = {
  id: "401858249",
  division: "NFL",
  home: { id: "228", name: "Clemson Tigers", short: "Clemson", abbr: "CLEM", record: "3-1", conference: "ACC", color: "#f66733" },
  away: { id: "2390", name: "Miami Hurricanes", short: "Miami", abbr: "MIA", record: "4-0", conference: "ACC", color: "#005030", rank: 4, rankPoll: "AP Top 25" },
  kickoff: "2026-10-03T23:30:00.000Z",
  venue: "Memorial Stadium",
  city: "Clemson, SC",
  network: "ABC",
  status: "upcoming",
  coverage: "Full",
  whyWatch: "No. 4 Miami visits Clemson (3-1).",
  whyWatchReasons: ["No. 4 Miami visits Clemson (3-1).", "One-score game by the market: CLEM -2.5.", "Miami offensive line against clemson front: advantage offense. Miami No. 4 of 138 in line yards (3.89), Clemson No. 135 (3.46)."],
  market: { spread: { team: "CLEM", line: -2.5, open: -3 }, total: { line: 48.5, open: 47 }, books: 6, asOf: "2026-10-03T20:00:00.000Z" },
  prospects: [
    { id: "4567", name: "Rueben Bain Jr.", team: "MIA", jersey: 4, pos: "DL", cls: "Jr", ht: "6-3", wt: 275, draftYear: 2027, eligibilityConfidence: "High", tier: "Rookie", projected: "Round 1 range (forecast)", sourceCount: 0, projectionConfidence: "High", traits: ["5 sacks", "9 TFL"], watchFor: "Get-off on first and second down.", stat: "5 sacks, 9 TFL in 4 games" },
  ],
  matchups: [{ a: "Miami offensive line", b: "Clemson front", why: "Miami is No. 4 of 138 in line yards per carry (3.89). Clemson ranks No. 135 at the line of scrimmage (3.46). This is not a lean. It is a mismatch, and a prominent one.", evidence: "line yards 3.89 vs 3.46, gap 61 percentile points", edge: "offense", strength: "dominant", watch: "Yards before contact on Miami's first ten carries." }],
  keepAnEyeOn: [{ name: "Tyler Smith", team: "CLEM", note: "WR, Fr. 212 rec yds. Eligible in 2029." }],
  storylines: ["ACC conference game."],
  offense: { CLEM: { label: "Balanced, slow", sample: "full", summary: "Pass rate 52%.", metrics: [{ key: "sr", label: "Success rate", value: "41%", rank: 77, of: 138 }] }, MIA: { label: "Run first", sample: "full", metrics: [{ key: "ly", label: "Line yards", value: "3.89", rank: 4, of: 138 }] } },
  defense: { CLEM: { label: "Soft front", sample: "full", metrics: [] }, MIA: { label: "Run erasing", sample: "full", metrics: [{ key: "rushSr", label: "Rush success", value: "26%", rank: 1, of: 138 }] } },
  pressurePoint: "Miami offensive line vs Clemson front. The line of scrimmage belongs to Miami.",
  scoreComponents: { competitive: 60, directMatchups: 50, watchDensity: 40, stakes: 50, availability: 100 },
  projection: { winner: "MIA", winProb: 0.58, margin: 3.2, total: 49, home: 23, away: 26, shape: "Miami controls the line and the clock.", basis: ["Elo gap 85"], confidence: "high", modelTotal: 51, totalLean: "over", totalGap: 2.5, totalNote: "Model 51 against a posted 48.5." },
  reportAsOf: "2026-10-03T20:26:54.596Z",
  source: "live",
};

const packet = buildPacket(game);
console.log(`packet: ${packet.facts.length} facts, ${packet.numbers.length} distinct numbers, names: ${packet.names.join(", ")}`);

const good: Report = {
  headline: "Miami owns the line of scrimmage",
  openingParagraph: "This is not a lean. It is a mismatch, and a prominent one. Miami is No. 4 of 138 in line yards per carry at 3.89, and Clemson sits No. 135 at 3.46. The market calls it a one-score game at CLEM -2.5 with a total of 48.5, but the model has Miami by 3.2 with a 58% chance to win. The pressure point is simple: watch yards before contact on Miami's first ten carries.",
  sections: [
    { title: "The front", paragraphs: ["Rueben Bain Jr. is the name scouts came for. The Miami DL has 5 sacks and 9 TFL in 4 games, and he is in the Round 1 range on the forecast. His get-off on first and second down is the thing to watch, because Miami ranks No. 1 of 138 in rush success allowed at 26%."], factIds: ["R1", "M1", "SA2.1"] },
    { title: "The number", paragraphs: ["The model total is 51 against a posted 48.5, a lean to the over of 2.5 points. That is a model, not a pick. Clemson's offense runs a 41% success rate, No. 77 of 138, which is the reason the margin stays inside a field goal. Keep an eye on Tyler Smith, a freshman WR with 212 receiving yards who is not eligible until 2029."], factIds: ["J4", "SH1.1", "E1"] },
  ],
  oneLineForCard: "Miami's line against Clemson's front is the mismatch of the day.",
};
// Pad to the word floor with a third section of packet-safe prose.
good.sections.push({ title: "What to watch", paragraphs: ["Miami controls the line and the clock in the projected shape, with a projected score of Miami 26, Clemson 23. The Elo gap of 85 is the basis. Clemson is balanced and slow on offense with a pass rate of 52%, so the game is decided on early downs. If Miami's first ten carries gain yards before contact, the second-level runs and play-action follow, and the one-score line gets tested early. It is an ACC conference game on ABC, and both the model and the market agree the margin is small. The evidence points one way at the line of scrimmage, and that is where the report starts and ends."], factIds: ["J2", "SH1", "T1", "G1"] });

const invented: Report = JSON.parse(JSON.stringify(good));
invented.sections[0].paragraphs[0] += " Cade Klubnik threw for 312 yards last week and Antonio Williams had 7 catches, so expect 34 points from Clemson.";

for (const [label, r] of [["good report", good], ["invented names and numbers", invented]] as const) {
  const v = validateReport(r, packet);
  console.log(`\n${label}: ${v.length ? "REJECTED" : "accepted"}`);
  for (const x of v) console.log(`  - ${x}`);
}
const okGood = validateReport(good, packet).length === 0;
const okBad = validateReport(invented, packet).some((x) => x.includes("Klubnik") || x.includes("Williams")) && validateReport(invented, packet).some((x) => x.includes("312"));
console.log(`\nresult: ${okGood && okBad ? "PASS" : "FAIL"}`);
process.exit(okGood && okBad ? 0 : 1);
