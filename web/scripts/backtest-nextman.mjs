/**
 * Backtest the next-man-up bump in src/lib/dfs.ts (and the simulator's NEXT_MAN_UP in dfs-slate.ts).
 *
 *   node scripts/backtest-nextman.mjs                 # seasons 2022..2025
 *
 * The live rule: a back, receiver, or tight end averaging 6+ DK points who is out for a game he did not miss the
 * week before (a new absence) hands half his average to the next man up: one teammate at RB and TE, split across
 * three at WR. A second straight absence adds nothing, because the backup's average already carries one game of
 * the bigger role.
 *
 * Here, walk-forward on the nflverse weekly files (regular season): a player is absent in a team game when he has no
 * stat line in it after 2+ games with lines this season averaging 6+ DK points. (No line also covers a healthy
 * scratch or a zero-stat game; at 6+ points a game those are rare.) The next man up is the teammate at the same
 * position with the most work a game so far (carries plus targets for backs, targets for receivers and tight ends),
 * three at WR, among players with a line in the week before. Depth charts by week are not in this test.
 *
 * Graded on the takers' DK points that week:
 *   share    projection = his average so far + k x (absent player's average / takers), k on a grid
 *   capture  (takers' points that week - their averages) / the absent player's average: how much of the work moved
 * for new absences and for repeat absences (second straight game out). Writes data/backtest/nextman.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache");
const OUT = path.join(root, "data", "backtest");
const SEASONS = (process.env.SEASONS ?? "2022,2023,2024,2025").split(",").map(Number);
const POS = new Set(["RB", "WR", "TE"]);
const KS = [0, 0.25, 0.5, 0.75, 1];

const dk = (r) => {
  const n = (k) => num(r[k]) ?? 0;
  const py = n("passing_yards"), ry = n("rushing_yards"), rcy = n("receiving_yards");
  return py * 0.04 + n("passing_tds") * 4 - n("passing_interceptions") + (py >= 300 ? 3 : 0) +
    ry * 0.1 + n("rushing_tds") * 6 + (ry >= 100 ? 3 : 0) +
    n("receptions") + rcy * 0.1 + n("receiving_tds") * 6 + (rcy >= 100 ? 3 : 0) -
    n("fumbles_lost_total") + n("special_teams_tds") * 6;
};

const cells = { fresh: new Map(), repeat: new Map() };
/** The live shares after this test (src/lib/dfs.ts NEXT_MAN_UP_SHARE). */
const FIT = { RB: 0.25, TE: 0.2, WR: 0 };
const fitCells = { fresh: new Map(), repeat: new Map() };
const capture = { fresh: { RB: [], WR: [], TE: [] }, repeat: { RB: [], WR: [], TE: [] } };
const samples = [];

for (const season of SEASONS) {
  const rows = [];
  await readCsv(path.join(CACHE, `stats_player_week_${season}.csv`), (r) => {
    if (r.season_type !== "REG") return;
    rows.push({ id: r.player_id, name: r.player_display_name, pos: r.position, team: r.team, week: Number(r.week), pts: dk(r), tgt: num(r.targets) ?? 0, car: num(r.carries) ?? 0 });
  });
  // Team weeks actually played (any stat line for the team).
  const teamWeeks = new Map();
  for (const r of rows) (teamWeeks.get(r.team) ?? teamWeeks.set(r.team, new Set()).get(r.team)).add(r.week);
  const byKey = new Map(rows.map((r) => [`${r.id}|${r.week}`, r]));

  for (const [team, wset] of teamWeeks) {
    const weeks = [...wset].sort((a, b) => a - b);
    const teamRows = rows.filter((r) => r.team === team && POS.has(r.pos));
    const ids = [...new Set(teamRows.map((r) => r.id))];
    for (let i = 2; i < weeks.length; i++) {
      const w = weeks[i];
      const prevW = weeks[i - 1];
      const before = teamRows.filter((r) => r.week < w);
      const stats = new Map();
      for (const r of before) {
        const s = stats.get(r.id) ?? stats.set(r.id, { pos: r.pos, name: r.name, n: 0, pts: 0, work: 0 }).get(r.id);
        s.n++;
        s.pts += r.pts;
        s.work += r.pos === "RB" ? r.car + r.tgt : r.tgt;
      }
      for (const id of ids) {
        const s = stats.get(id);
        if (!s || s.n < 2 || s.pts / s.n < 6) continue;
        if (byKey.get(`${id}|${w}`)) continue; // he played this week
        // He has left the team for good (no later line for this team) is still an absence for this game.
        const playedPrev = Boolean(byKey.get(`${id}|${prevW}`));
        const prev2 = weeks[i - 2];
        const missedPrevOnly = !playedPrev && Boolean(byKey.get(`${id}|${prev2}`));
        const kind = playedPrev ? "fresh" : missedPrevOnly ? "repeat" : undefined;
        if (!kind) continue;
        const absentAvg = s.pts / s.n;
        const candidates = [...stats.entries()]
          .filter(([qid, q]) => qid !== id && q.pos === s.pos && byKey.get(`${qid}|${prevW}`) && q.n >= 1)
          .sort((a, b) => b[1].work / b[1].n - a[1].work / a[1].n);
        // The absent player's usual top-work teammate is the starter beside him, not his backup: skip teammates
        // who out-worked him (at RB and TE the next man up sits behind him).
        const behind = s.pos === "WR" ? candidates : candidates.filter(([, q]) => q.work / q.n <= s.work / s.n);
        const takers = (s.pos === "WR" ? behind.slice(0, 3) : behind.slice(0, 1)).map(([qid, q]) => ({ qid, q }));
        if (!takers.length) continue;
        let gained = 0;
        for (const { qid, q } of takers) {
          const actual = byKey.get(`${qid}|${w}`)?.pts ?? 0;
          const avg = q.pts / q.n;
          gained += actual - avg;
          // The fitted live rule: a share by position, all to one taker at RB and TE, none at WR.
          const fit = FIT[s.pos] ? (s.pos === "WR" ? 0 : FIT[s.pos] * absentAvg) : 0;
          const fc = fitCells[kind].get(s.pos) ?? fitCells[kind].set(s.pos, { ae: 0, ae0: 0, n: 0, bias: 0 }).get(s.pos);
          fc.ae += Math.abs(avg + fit - actual);
          fc.ae0 += Math.abs(avg - actual);
          fc.bias += avg + fit - actual;
          fc.n++;
          for (const k of KS) {
            const proj = avg + (k * absentAvg) / takers.length;
            const c = cells[kind].get(k) ?? cells[kind].set(k, { ae: 0, n: 0, bias: 0 }).get(k);
            c.ae += Math.abs(proj - actual);
            c.bias += proj - actual;
            c.n++;
          }
        }
        capture[kind][s.pos].push(gained / absentAvg);
        if (kind === "fresh" && samples.length < 12 && absentAvg >= 14) samples.push({ season, week: w, team, out: s.name, pos: s.pos, outAvg: Math.round(absentAvg * 10) / 10, takers: takers.map(({ q, qid }) => `${q.name} ${Math.round((q.pts / q.n) * 10) / 10} -> ${Math.round((byKey.get(`${qid}|${w}`)?.pts ?? 0) * 10) / 10}`).join(", ") });
      }
    }
  }
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const table = (kind) => KS.map((k) => {
  const c = cells[kind].get(k);
  return { kind, k, takerGames: c?.n ?? 0, mae: c ? r3(c.ae / c.n) : null, bias: c ? r3(c.bias / c.n) : null };
});
const cap = (kind) => Object.entries(capture[kind]).map(([pos, xs]) => ({ kind, pos, absences: xs.length, meanCapture: xs.length ? r3(mean(xs)) : null, medianCapture: xs.length ? r3(median(xs)) : null }));
const fitTable = ["fresh", "repeat"].flatMap((kind) => [...fitCells[kind].entries()].map(([pos, c]) => ({ kind, pos, takerGames: c.n, maeNoBump: r3(c.ae0 / c.n), maeFit: r3(c.ae / c.n), biasFit: r3(c.bias / c.n) })));
const out = { builtAt: new Date().toISOString(), seasons: SEASONS, fresh: table("fresh"), repeat: table("repeat"), capture: [...cap("fresh"), ...cap("repeat")], fit: { shares: FIT, byPos: fitTable }, samples };
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "nextman.json"), JSON.stringify(out, null, 2));
console.log("New absences: taker projection = his average + k x (absent average / takers)");
console.table(out.fresh);
console.log("Repeat absences (second straight game out)");
console.table(out.repeat);
console.log("Share of the absent player's average the takers actually gained, beyond their own averages");
console.table(out.capture);
console.log("Fitted shares (RB 0.25, TE 0.2, WR 0) against no bump, by position");
console.table(fitTable);
