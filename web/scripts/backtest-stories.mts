/**
 * Storyline backtest: do players beat their own average in hometown, home-state, college-state, and revenge games?
 * Run: npx tsx scripts/backtest-stories.mts   (writes data/backtest/stories.json)
 *
 * RULES, written before the first run (2026-10-05) and not changed after seeing results:
 *   Population: QB/RB/WR/TE regular-season games 2019-2025 (nflverse weekly player stats) of player-seasons with 5+ games.
 *   Measure: residual = his DraftKings points (dkPoints, Classic scoring) minus his average in his OTHER regular-season
 *     games that season (4+ other games required).
 *   Groups:
 *     hometown        road or neutral US game in his birth city (ESPN birthplace city and state = the stadium's)
 *     hometown-first  his first such game in our data (the "first time back home" case)
 *     home-state      road or neutral US game in his birth state, not his birth city
 *     college-state   road or neutral US game in the state of his last college's stadium (ESPN), not his birth city
 *     revenge         a game against a team he played a regular-season game for in the four seasons before, or the
 *                     team that drafted him (no stint needed); 2022-2025 only, so the four seasons before are in the data
 *     revenge-first   his first game against that team after leaving it
 *   Baselines: place groups against all other road and neutral games in the population; revenge groups against all
 *     non-revenge games 2022-2025 (home and away, as revenge games are both).
 *   PASS (all three): 50+ games; the group's mean residual is 1.5+ DK above its baseline's; the 95% bootstrap interval of
 *     that difference (2,000 resamples, seed 7) is above zero. The beat-his-average rate (residual > 0) is reported for
 *     the group and the baseline (DK points skew right, so most games sit under a player's average; the comparison is
 *     the gap, not 50%), next to the "80 to 90% of the time" claim.
 *   Where a game was played: src/lib/places.ts (stadium id; three 2019-only stadiums by hand; international games out).
 *   Birthplace and college: ESPN athlete records (src/lib/storylines.ts bios, cached in data/espn), mapped from nflverse
 *     gsis ids through the nflverse players file (espn_id).
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { readCsv } from "./lib/csv.mjs";
import { dkPoints } from "../src/lib/dfs";
import { placeOf } from "../src/lib/places";
import { bios } from "../src/lib/storylines";
import type { StatLine } from "../src/lib/generated";

const CACHE = path.join(process.cwd(), "data", "cache");
const FIRST = 2019;
const LAST = 2025;
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
// nflverse team codes that moved: one identity per franchise.
const CANON: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };
const canon = (c: string) => CANON[c] ?? c;
const num = (v: string | undefined) => (v === undefined || v === "" || v === "NA" ? 0 : Number(v) || 0);

type Row = Record<string, string>;
interface G { gid: string; season: number; week: number; pid: string; team: string; opp: string; ha: "home" | "away" | "neutral"; dk: number; stadium: string; stadiumId: string; resid?: number }

// ---------------------------------------------------------------- games and lines
const games = new Map<string, Row>();
for (const r of (await readCsv(path.join(CACHE, "games.csv"))) as Row[]) if (Number(r.season) >= 2018 && Number(r.season) <= LAST && r.game_type === "REG") games.set(r.game_id, r);

const lines: G[] = [];
const stints = new Map<string, Map<number, Set<string>>>(); // pid -> season -> teams
for (let y = 2018; y <= LAST; y++) {
  const f = path.join(CACHE, `stats_player_week_${y}.csv`);
  if (!existsSync(f)) throw new Error(`missing ${f}`);
  for (const r of (await readCsv(f)) as Row[]) {
    if (r.season_type !== "REG" || !r.player_id) continue;
    const team = canon(r.team);
    const s = (stints.get(r.player_id) ?? stints.set(r.player_id, new Map()).get(r.player_id)!);
    (s.get(y) ?? s.set(y, new Set()).get(y)!).add(team);
    if (y < FIRST || !SKILL.has(r.position)) continue;
    const g = games.get(r.game_id);
    if (!g) continue;
    const home = canon(g.home_team);
    const away = canon(g.away_team);
    const opp = canon(r.opponent_team);
    const ha = g.location === "Neutral" ? "neutral" : team === home || opp === away ? "home" : "away";
    const st: StatLine = {
      py: num(r.passing_yards), ptd: num(r.passing_tds), pint: num(r.passing_interceptions), ry: num(r.rushing_yards), rtd: num(r.rushing_tds),
      rec: num(r.receptions), rcy: num(r.receiving_yards), rctd: num(r.receiving_tds), fl: num(r.fumbles_lost_total), sttd: num(r.special_teams_tds),
    };
    lines.push({ gid: r.game_id, season: y, week: Number(r.week), pid: r.player_id, team, opp, ha, dk: dkPoints(st), stadium: g.stadium ?? "", stadiumId: g.stadium_id ?? "" });
  }
}

// Residuals: his average in his other games that season (4+), player-seasons with 5+ games.
const bySeason = new Map<string, G[]>();
for (const l of lines) (bySeason.get(`${l.pid}|${l.season}`) ?? bySeason.set(`${l.pid}|${l.season}`, []).get(`${l.pid}|${l.season}`)!).push(l);
for (const gs of bySeason.values()) {
  if (gs.length < 5) continue;
  const total = gs.reduce((t, x) => t + x.dk, 0);
  for (const x of gs) x.resid = x.dk - (total - x.dk) / (gs.length - 1);
}
const pop = lines.filter((l) => l.resid !== undefined);
console.log(`population: ${pop.length} games, ${new Set(pop.map((l) => l.pid)).size} players, ${FIRST}-${LAST}`);

// ---------------------------------------------------------------- birthplaces and colleges
const espnOf = new Map<string, string>();
for (const r of (await readCsv(path.join(CACHE, "players.csv"))) as Row[]) if (r.gsis_id && r.espn_id && /^\d+$/.test(r.espn_id)) espnOf.set(r.gsis_id, r.espn_id);
const pids = [...new Set(pop.map((l) => l.pid))];
const espnIds = pids.map((p) => espnOf.get(p)).filter((x): x is string => Boolean(x));
console.log(`ESPN ids for ${espnIds.length} of ${pids.length} players; fetching missing bios (cached after)...`);
const bio = await bios(espnIds, Infinity);
console.log(`bios: ${bio.size}`);

// ---------------------------------------------------------------- groups
const draftTeam = new Map<string, { team: string; season: number }>();
for (const r of (await readCsv(path.join(CACHE, "draft_picks.csv"))) as Row[]) if (r.gsis_id) draftTeam.set(r.gsis_id, { team: canon(r.team), season: Number(r.season) });

const groups: Record<string, G[]> = { hometown: [], "hometown-first": [], "home-state": [], "college-state": [], revenge: [], "revenge-first": [] };
const placeBase: G[] = [];
const revengeBase: G[] = [];
const seenHome = new Set<string>();
const seenRevenge = new Set<string>();
for (const l of [...pop].sort((a, b) => a.season - b.season || a.week - b.week)) {
  // Place stories: road or neutral, in the US.
  if (l.ha !== "home") {
    const place = placeOf({ stadium: l.stadium, stadiumId: l.stadiumId });
    const b = espnOf.get(l.pid) ? bio.get(espnOf.get(l.pid)!) : undefined;
    let tagged = false;
    if (place?.us && b) {
      const born = b.born;
      const city = Boolean(born?.city && born.state === place.state && born.city.toLowerCase() === place.city.toLowerCase());
      if (city) {
        groups.hometown.push(l);
        if (!seenHome.has(l.pid)) groups["hometown-first"].push(l);
        seenHome.add(l.pid);
        tagged = true;
      } else {
        if (born?.state === place.state) { groups["home-state"].push(l); tagged = true; }
        if (b.college?.state === place.state) { groups["college-state"].push(l); tagged = true; }
      }
    }
    if (!tagged && place?.us) placeBase.push(l);
  }
  // Revenge: 2022 on.
  if (l.season >= 2022) {
    const s = stints.get(l.pid);
    const before = [1, 2, 3, 4].some((k) => s?.get(l.season - k)?.has(l.opp));
    const d = draftTeam.get(l.pid);
    const drafted = !before && d?.team === l.opp && d.season < l.season && !(s?.get(l.season)?.has(l.opp));
    if ((before || drafted) && l.opp !== l.team) {
      groups.revenge.push(l);
      const key = `${l.pid}|${l.opp}`;
      if (!seenRevenge.has(key)) groups["revenge-first"].push(l);
      seenRevenge.add(key);
    } else revengeBase.push(l);
  }
}

// ---------------------------------------------------------------- stats
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
function compare(group: G[], base: G[]) {
  const g = group.map((x) => x.resid!);
  const b = base.map((x) => x.resid!);
  const diff = mean(g) - mean(b);
  const rand = mulberry32(7);
  const ds: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sg = 0;
    for (let k = 0; k < g.length; k++) sg += g[Math.floor(rand() * g.length)];
    let sb = 0;
    const nb = Math.min(b.length, 4000); // a 4,000-game resample of the baseline is plenty for its mean
    for (let k = 0; k < nb; k++) sb += b[Math.floor(rand() * b.length)];
    ds.push(sg / g.length - sb / nb);
  }
  ds.sort((x, y) => x - y);
  const ci: [number, number] = [ds[Math.floor(0.025 * ds.length)], ds[Math.floor(0.975 * ds.length)]];
  const beat = g.filter((x) => x > 0).length / g.length;
  const baseBeat = b.filter((x) => x > 0).length / b.length;
  const pass = g.length >= 50 && diff >= 1.5 && ci[0] > 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: g.length, mean: r2(mean(g)), base: r2(mean(b)), baseN: b.length, diff: r2(diff), ci: [r2(ci[0]), r2(ci[1])], beat: r2(beat), baseBeat: r2(baseBeat), pass };
}

const results: Record<string, ReturnType<typeof compare>> = {};
for (const [k, gs] of Object.entries(groups)) if (gs.length) results[k] = compare(gs, k.startsWith("revenge") ? revengeBase : placeBase);

console.log("\ngroup            n     mean    base    diff   95% CI           beat   base beat  pass");
for (const [k, r] of Object.entries(results)) {
  console.log(`${k.padEnd(15)} ${String(r.n).padStart(5)}  ${r.mean.toFixed(2).padStart(6)}  ${r.base.toFixed(2).padStart(6)}  ${r.diff.toFixed(2).padStart(6)}   [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}]`.padEnd(70) + `${Math.round(r.beat * 100)}%`.padStart(5) + `${Math.round(r.baseBeat * 100)}%`.padStart(10) + `  ${r.pass ? "PASS" : "no"}`);
}

const examples = Object.fromEntries(Object.entries(groups).map(([k, gs]) => [k, gs.slice(-5).map((x) => ({ pid: x.pid, season: x.season, week: x.week, opp: x.opp, dk: Math.round(x.dk * 10) / 10, resid: Math.round(x.resid! * 10) / 10 }))]));
mkdirSync(path.join(process.cwd(), "data", "backtest"), { recursive: true });
writeFileSync(
  path.join(process.cwd(), "data", "backtest", "stories.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), seasons: [FIRST, LAST], revengeSeasons: [2022, LAST], population: { games: pop.length, players: new Set(pop.map((l) => l.pid)).size, withBio: bio.size }, rule: "pass = 50+ games, mean residual 1.5+ DK over the baseline, 95% bootstrap interval of the difference above zero", results, examples }, null, 1),
);
console.log("\nwrote data/backtest/stories.json");
