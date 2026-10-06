/**
 * NFL standings with the league's tiebreaking procedures, and playoff odds from an Elo simulation of the rest of the
 * season. The idea follows nflverse's nflseedR (R); this is our own TypeScript, no R. Server-only for the wrappers;
 * the core (`standingsFrom`) is pure and is what scripts/backtest-seed.mts checks against 2019-2025.
 *
 * Division ties, two clubs: head-to-head, division record, record in common games, conference record, strength of
 * victory, strength of schedule, combined ranking among conference teams in points scored and allowed, the same among
 * all teams, net points in common games, net points in all games. Three or more clubs: the same list, with head-to-head
 * meaning the record in games among all the tied clubs.
 * Wild card ties (and seeding division winners), two clubs: head-to-head if they met, conference record, common games
 * (at least four), strength of victory, strength of schedule, the two points rankings, net points in conference games,
 * net points in all games. Three or more clubs: a head-to-head sweep (one club beat each of the others, or lost to each
 * of the others) instead of head-to-head, then the same list. Before any wild card comparison, all but the highest-
 * ranked club from each division drop out.
 * At any step that separates some of the tied clubs from the rest, the clubs still tied start over at step one of the
 * two-club or the three-club list, whichever fits how many remain. Once one club wins a place, the others start over.
 * The league's last two steps (net touchdowns, then a coin toss) are not in our data: a tie that survives net points is
 * settled by a fixed stand-in (a hash of the season and the team), and the note says so. Ties count as half a win.
 *
 * Seeding: division winners take seeds 1 to 4, then the wild cards (three a conference from 2020, two in 2019).
 */
import { genSchedule, scheduleStamp } from "./generated";
import { memoSync } from "./memo";
import { nflTeams, type Finals } from "./nfl";

export interface SeedTeam {
  short: string;
  conf: string;
  div: string;
}

/** A finished regular-season game, real or simulated. */
export interface SeedGame {
  home: string;
  away: string;
  hs: number;
  as: number;
}

export interface Record3 {
  w: number;
  l: number;
  t: number;
}

export interface SeedRow {
  team: string;
  conf: string;
  div: string;
  w: number;
  l: number;
  t: number;
  games: number;
  pct: number;
  pf: number;
  pa: number;
  div3: Record3;
  conf3: Record3;
  divRank: number;
  /** Conference order, 1 to 16: division winners 1 to 4, then everyone else. */
  seed: number;
  inPlayoffs: boolean;
  /** How a tie for this team's division place was settled, in plain words. Undefined when no tie. */
  divNote?: string;
  /** How a tie for this team's conference seed was settled. */
  seedNote?: string;
  /** Both notes in one line. */
  note?: string;
}

export const playoffTeamsFor = (season: number) => (season >= 2020 ? 7 : 6);

/* ------------------------------------------------------------------ state */

interface G {
  h: number;
  a: number;
  hs: number;
  as: number;
}

interface State {
  season: number;
  salt: string;
  teams: SeedTeam[];
  games: G[];
  byTeam: number[][];
  w: number[];
  l: number[];
  t: number[];
  pf: number[];
  pa: number[];
  conf: number[];
  div: number[];
  divRank: number[];
}

function buildState(season: number, teams: SeedTeam[], games: SeedGame[], salt = ""): State {
  const idx = new Map(teams.map((t, i) => [t.short, i]));
  const confs = [...new Set(teams.map((t) => t.conf))].sort();
  const divs = [...new Set(teams.map((t) => `${t.conf} ${t.div}`))].sort();
  const n = teams.length;
  const st: State = {
    season,
    salt,
    teams,
    games: [],
    byTeam: teams.map(() => []),
    w: new Array(n).fill(0),
    l: new Array(n).fill(0),
    t: new Array(n).fill(0),
    pf: new Array(n).fill(0),
    pa: new Array(n).fill(0),
    conf: teams.map((t) => confs.indexOf(t.conf)),
    div: teams.map((t) => divs.indexOf(`${t.conf} ${t.div}`)),
    divRank: new Array(n).fill(0),
  };
  for (const g of games) {
    const h = idx.get(g.home);
    const a = idx.get(g.away);
    if (h === undefined || a === undefined) continue;
    addGame(st, { h, a, hs: g.hs, as: g.as });
  }
  return st;
}

function addGame(st: State, g: G) {
  const k = st.games.push(g) - 1;
  st.byTeam[g.h].push(k);
  st.byTeam[g.a].push(k);
  st.pf[g.h] += g.hs;
  st.pa[g.h] += g.as;
  st.pf[g.a] += g.as;
  st.pa[g.a] += g.hs;
  if (g.hs > g.as) {
    st.w[g.h]++;
    st.l[g.a]++;
  } else if (g.hs < g.as) {
    st.w[g.a]++;
    st.l[g.h]++;
  } else {
    st.t[g.h]++;
    st.t[g.a]++;
  }
}

const pctOf = (r: Record3) => {
  const n = r.w + r.l + r.t;
  return n ? (r.w + r.t / 2) / n : 0;
};
const teamPct = (st: State, i: number) => pctOf({ w: st.w[i], l: st.l[i], t: st.t[i] });

/** Team i's record and net points in its games against opponents that pass `keep`. */
function recordVs(st: State, i: number, keep: (opp: number) => boolean): Record3 & { n: number; net: number } {
  const r = { w: 0, l: 0, t: 0, n: 0, net: 0 };
  for (const k of st.byTeam[i]) {
    const g = st.games[k];
    const home = g.h === i;
    const opp = home ? g.a : g.h;
    if (!keep(opp)) continue;
    const mine = home ? g.hs : g.as;
    const theirs = home ? g.as : g.hs;
    r.n++;
    r.net += mine - theirs;
    if (mine > theirs) r.w++;
    else if (mine < theirs) r.l++;
    else r.t++;
  }
  return r;
}

/** Combined record of the opponents team i beat (victory) or played (schedule), one entry per game. */
function strength(st: State, i: number, wonOnly: boolean): number {
  let w = 0;
  let n = 0;
  for (const k of st.byTeam[i]) {
    const g = st.games[k];
    const home = g.h === i;
    const opp = home ? g.a : g.h;
    if (wonOnly && !(home ? g.hs > g.as : g.as > g.hs)) continue;
    w += st.w[opp] + st.t[opp] / 2;
    n += st.w[opp] + st.l[opp] + st.t[opp];
  }
  return n ? w / n : 0;
}

/** Combined rank in points scored and points allowed among `pool` (lower is better), competition ranking. */
function pointsRank(st: State, i: number, pool: number[]): number {
  const better = (arr: number[], v: number, higher: boolean) => pool.filter((j) => (higher ? arr[j] > v : arr[j] < v)).length + 1;
  return better(st.pf, st.pf[i], true) + better(st.pa, st.pa[i], false);
}

function coin(st: State, i: number): number {
  const s = `${st.season}:${st.salt}:${st.teams[i].short}`;
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ steps */

interface Step {
  key: string;
  words: string;
  /** Scores for each club in `group`, higher is better, or undefined when the step does not apply. */
  score: (st: State, group: number[]) => number[] | undefined;
}

const inGroup = (group: number[]) => {
  const s = new Set(group);
  return (j: number) => s.has(j);
};

const H2H_TWO: Step = {
  key: "h2h",
  words: "head-to-head",
  score: (st, g) => {
    const r = g.map((i) => recordVs(st, i, (j) => j !== i && g.includes(j)));
    return r.every((x) => x.n > 0) ? r.map(pctOf) : undefined;
  },
};
const H2H_MULTI: Step = {
  key: "h2h",
  words: "head-to-head record among the tied teams",
  score: (st, g) => {
    const keep = inGroup(g);
    const r = g.map((i) => recordVs(st, i, (j) => j !== i && keep(j)));
    return r.every((x) => x.n > 0) ? r.map(pctOf) : undefined;
  },
};
const H2H_SWEEP: Step = {
  key: "sweep",
  words: "a head-to-head sweep",
  score: (st, g) => {
    const vs = (i: number, j: number) => recordVs(st, i, (o) => o === j);
    const swept = g.filter((i) => g.every((j) => j === i || (() => { const r = vs(i, j); return r.n > 0 && r.l === 0 && r.t === 0; })()));
    if (swept.length === 1) return g.map((i) => (i === swept[0] ? 1 : 0));
    const lost = g.filter((i) => g.every((j) => j === i || (() => { const r = vs(i, j); return r.n > 0 && r.w === 0 && r.t === 0; })()));
    if (lost.length && lost.length < g.length) return g.map((i) => (lost.includes(i) ? 0 : 1));
    return undefined;
  },
};
const DIV_REC: Step = { key: "div", words: "division record", score: (st, g) => g.map((i) => pctOf(recordVs(st, i, (j) => st.div[j] === st.div[i]))) };
const CONF_REC: Step = { key: "conf", words: "conference record", score: (st, g) => g.map((i) => pctOf(recordVs(st, i, (j) => st.conf[j] === st.conf[i]))) };

function commonOpps(st: State, g: number[]): Set<number> {
  const keep = inGroup(g);
  const sets = g.map((i) => new Set(st.byTeam[i].map((k) => (st.games[k].h === i ? st.games[k].a : st.games[k].h)).filter((o) => !keep(o))));
  return new Set([...sets[0]].filter((o) => sets.every((s) => s.has(o))));
}
const common = (min: number): Step => ({
  key: "common",
  words: "record in common games",
  score: (st, g) => {
    const opps = commonOpps(st, g);
    const r = g.map((i) => recordVs(st, i, (j) => opps.has(j)));
    return r.every((x) => x.n >= min) ? r.map(pctOf) : undefined;
  },
});
const SOV: Step = { key: "sov", words: "strength of victory", score: (st, g) => g.map((i) => strength(st, i, true)) };
const SOS: Step = { key: "sos", words: "strength of schedule", score: (st, g) => g.map((i) => strength(st, i, false)) };
const RANK_CONF: Step = {
  key: "rankConf",
  words: "points scored and allowed ranking within the conference",
  score: (st, g) => g.map((i) => -pointsRank(st, i, st.teams.map((_, j) => j).filter((j) => st.conf[j] === st.conf[i]))),
};
const RANK_ALL: Step = { key: "rankAll", words: "points scored and allowed ranking in the league", score: (st, g) => g.map((i) => -pointsRank(st, i, st.teams.map((_, j) => j))) };
const NET_COMMON: Step = {
  key: "netCommon",
  words: "net points in common games",
  score: (st, g) => {
    const opps = commonOpps(st, g);
    return g.map((i) => recordVs(st, i, (j) => opps.has(j)).net);
  },
};
const NET_CONF: Step = { key: "netConf", words: "net points in conference games", score: (st, g) => g.map((i) => recordVs(st, i, (j) => st.conf[j] === st.conf[i]).net) };
const NET_ALL: Step = { key: "netAll", words: "net points", score: (st, g) => g.map((i) => st.pf[i] - st.pa[i]) };
const COIN: Step = {
  key: "coin",
  words: "a fixed stand-in for the league's last steps (net touchdowns and a coin toss are not in our data)",
  score: (st, g) => g.map((i) => coin(st, i)),
};

const DIV_TWO = [H2H_TWO, DIV_REC, common(1), CONF_REC, SOV, SOS, RANK_CONF, RANK_ALL, NET_COMMON, NET_ALL, COIN];
const DIV_MULTI = [H2H_MULTI, DIV_REC, common(1), CONF_REC, SOV, SOS, RANK_CONF, RANK_ALL, NET_COMMON, NET_ALL, COIN];
const WC_TWO = [H2H_TWO, CONF_REC, common(4), SOV, SOS, RANK_CONF, RANK_ALL, NET_CONF, NET_ALL, COIN];
const WC_MULTI = [H2H_SWEEP, CONF_REC, common(4), SOV, SOS, RANK_CONF, RANK_ALL, NET_CONF, NET_ALL, COIN];

/** The single club that wins a tie, and the step that separated it from the last clubs still level with it. */
function breakTie(st: State, group: number[], kind: "div" | "wc"): { winner: number; step: Step } {
  let g = group;
  let last: Step = COIN;
  restart: while (g.length > 1) {
    const steps = kind === "div" ? (g.length === 2 ? DIV_TWO : DIV_MULTI) : g.length === 2 ? WC_TWO : WC_MULTI;
    for (const step of steps) {
      const sc = step.score(st, g);
      if (!sc) continue;
      const best = Math.max(...sc);
      const keep = g.filter((_, k) => Math.abs(sc[k] - best) < 1e-9);
      if (keep.length < g.length) {
        last = step;
        g = keep;
        continue restart;
      }
    }
    // Every step tied (cannot happen past the stand-in); keep the first.
    return { winner: g[0], step: last };
  }
  return { winner: g[0], step: last };
}

/* --------------------------------------------------------------- ordering */

const nameList = (names: string[]) => (names.length <= 1 ? names.join("") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`);
const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
const samePct = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Order `pool` best first: by win percentage, ties broken with `pick` (which returns the winner and the reason words). */
function orderPool(st: State, pool: number[], pick: (group: number[]) => { winner: number; words: string }, depth = pool.length): { order: number[]; notes: Map<number, { words: string; over: number[] }> } {
  const order: number[] = [];
  const notes = new Map<number, { words: string; over: number[] }>();
  let left = [...pool];
  while (left.length) {
    if (order.length >= depth) {
      order.push(...left.sort((a, b) => teamPct(st, b) - teamPct(st, a) || coin(st, b) - coin(st, a)));
      break;
    }
    const top = Math.max(...left.map((i) => teamPct(st, i)));
    const group = left.filter((i) => samePct(teamPct(st, i), top));
    let winner = group[0];
    if (group.length > 1) {
      const r = pick(group);
      winner = r.winner;
      notes.set(winner, { words: r.words, over: group.filter((i) => i !== winner) });
    }
    order.push(winner);
    left = left.filter((i) => i !== winner);
  }
  return { order, notes };
}

interface Ordered {
  st: State;
  /** Conference order per conference index: team indexes, seed 1 first. */
  confOrder: number[][];
  divNotes: Map<number, string>;
  seedNotes: Map<number, string>;
}

function orderSeason(st: State, depth = 16): Ordered {
  const n = st.teams.length;
  const divNotes = new Map<number, string>();
  const seedNotes = new Map<number, string>();
  const short = (i: number) => st.teams[i].short;
  // Divisions.
  const divs = [...new Set(st.div)];
  const winnersByConf = new Map<number, number[]>();
  for (const d of divs) {
    const pool = [...Array(n).keys()].filter((i) => st.div[i] === d);
    const { order, notes: dn } = orderPool(st, pool, (g) => {
      const r = breakTie(st, g, "div");
      return { winner: r.winner, words: r.step.words };
    });
    order.forEach((i, k) => (st.divRank[i] = k + 1));
    for (const [i, x] of dn) {
      const t = st.teams[i];
      const rank = st.divRank[i];
      divNotes.set(i, rank === 1 ? `Won the ${t.conf} ${t.div} on ${x.words} over the ${nameList(x.over.map(short))}.` : `Finished ${ordinal(rank)} in the ${t.conf} ${t.div} on ${x.words}, ahead of the ${nameList(x.over.map(short))}.`);
    }
    const c = st.conf[order[0]];
    winnersByConf.set(c, [...(winnersByConf.get(c) ?? []), order[0]]);
  }
  // Conferences: division winners seeded first, then everyone else; wild card procedure for ties.
  const confs = [...new Set(st.conf)].sort();
  const confOrder: number[][] = [];
  const playoffs = playoffTeamsFor(st.season);
  for (const c of confs) {
    const winners = winnersByConf.get(c) ?? [];
    const wcPick = (g: number[]) => {
      // All but the highest-ranked club from each division drop out first.
      const byDiv = new Map<number, number>();
      for (const i of g) {
        const cur = byDiv.get(st.div[i]);
        if (cur === undefined || st.divRank[i] < st.divRank[cur]) byDiv.set(st.div[i], i);
      }
      const g2 = [...byDiv.values()];
      if (g2.length === 1) return { winner: g2[0], words: "a better division finish" };
      const r = breakTie(st, g2, "wc");
      return { winner: r.winner, words: r.step.words };
    };
    const top = orderPool(st, winners, wcPick);
    const rest = orderPool(
      st,
      [...Array(n).keys()].filter((i) => st.conf[i] === c && !winners.includes(i)),
      wcPick,
      Math.max(0, depth - winners.length),
    );
    const order = [...top.order, ...rest.order];
    confOrder[c] = order;
    for (const [i, x] of [...top.notes, ...rest.notes]) {
      const seed = order.indexOf(i) + 1;
      const over = nameList(x.over.map(short));
      const line = seed <= playoffs ? `Took the No. ${seed} seed on ${x.words} over the ${over}.` : `Ranked No. ${seed} in the ${st.teams[i].conf} on ${x.words}, ahead of the ${over}.`;
      seedNotes.set(i, line);
    }
  }
  return { st, confOrder, divNotes, seedNotes };
}

/** Standings for one set of finished regular-season games: records, division places, seeds, and the tiebreak notes. */
export function standingsFrom(season: number, teams: SeedTeam[], games: SeedGame[]): SeedRow[] {
  const st = buildState(season, teams, games);
  const { confOrder, divNotes, seedNotes } = orderSeason(st);
  const playoffs = playoffTeamsFor(season);
  const seedOf = new Map<number, number>();
  for (const order of confOrder) order?.forEach((i, k) => seedOf.set(i, k + 1));
  return teams.map((t, i) => {
    const div3 = recordVs(st, i, (j) => st.div[j] === st.div[i]);
    const conf3 = recordVs(st, i, (j) => st.conf[j] === st.conf[i]);
    const seed = seedOf.get(i) ?? 0;
    return {
      team: t.short,
      conf: t.conf,
      div: t.div,
      w: st.w[i],
      l: st.l[i],
      t: st.t[i],
      games: st.w[i] + st.l[i] + st.t[i],
      pct: teamPct(st, i),
      pf: st.pf[i],
      pa: st.pa[i],
      div3: { w: div3.w, l: div3.l, t: div3.t },
      conf3: { w: conf3.w, l: conf3.l, t: conf3.t },
      divRank: st.divRank[i],
      seed,
      inPlayoffs: seed > 0 && seed <= playoffs,
      divNote: divNotes.get(i),
      seedNote: seedNotes.get(i),
      note: [divNotes.get(i), seedNotes.get(i)].filter(Boolean).join(" ") || undefined,
    };
  });
}

/* --------------------------------------------------------------- the app */

const seedTeams = (): SeedTeam[] => nflTeams().map((t) => ({ short: t.short, conf: t.conf, div: t.div }));

/** Finished regular-season games for a season from the schedule, with ESPN finals folded in. */
export function seasonGames(season: number, finals: Finals = {}): SeedGame[] {
  return genSchedule()
    .filter((g) => g.season === season && g.type === "REG")
    .map((g) => (g.played && g.hs != null && g.as != null ? { home: g.home, away: g.away, hs: g.hs, as: g.as } : finals[g.id] ? { home: g.home, away: g.away, hs: finals[g.id].home, as: finals[g.id].away } : undefined))
    .filter((g): g is SeedGame => Boolean(g));
}

export function standingsWithTiebreaks(season: number, games?: SeedGame[], finals: Finals = {}): SeedRow[] {
  const key = `seed:standings:${season}:${scheduleStamp()}:${Object.keys(finals).sort().join(",")}:${games ? games.length : "sched"}`;
  return memoSync(key, 300, () => standingsFrom(season, seedTeams(), games ?? seasonGames(season, finals)));
}

/* ------------------------------------------------------------- simulation */

// Same constants and update as scripts/lib/elo.mjs (computeElo): start 1500, a third regressed each new season, K 20,
// 48 points of home field, the margin multiplier with a winner's Elo edge, ties as half a win.
const ELO = { start: 1500, k: 20, home: 48, regress: 1 / 3 };
const eloWin = (h: number, a: number, neutral: boolean) => 1 / (1 + Math.pow(10, (a - h - (neutral ? 0 : ELO.home)) / 400));
function eloDelta(h: number, a: number, neutral: boolean, hs: number, as: number): number {
  const exp = eloWin(h, a, neutral);
  const actual = hs > as ? 1 : hs < as ? 0 : 0.5;
  const margin = Math.abs(hs - as);
  const hf = neutral ? 0 : ELO.home;
  const winnerDiff = hs > as ? h + hf - a : hs < as ? a - h - hf : 0;
  const mult = Math.log(Math.max(margin, 1) + 1) * (2.2 / (0.001 * winnerDiff + 2.2));
  return ELO.k * mult * (actual - exp);
}

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

export interface TeamOdds {
  team: string;
  playoffs: number; // 0..1
  division: number;
  bye: number; // the 1 seed (seeds 1 and 2 in 2019)
  avgSeed: number; // mean conference seed, 1 to 16
  elo: number; // rating going into the rest of the season
}

export interface SeasonSim {
  season: number;
  runs: number;
  remaining: number;
  played: number;
  teams: TeamOdds[];
}

/**
 * Play the rest of the regular season `runs` times with our Elo: each game's winner drawn from the Elo win chance
 * (home field as computeElo, none at a neutral site), its score a real final drawn from past regular seasons (so the
 * points-based tiebreak steps and the Elo margin multiplier see real-looking margins), ratings updated after every
 * simulated game the way computeElo does. Simulated ties are not drawn. Seeded, so the same inputs give the same odds.
 */
export function simulateSeason(season: number, opts: { runs?: number; seed?: number; finals?: Finals } = {}): SeasonSim {
  const runs = opts.runs ?? 10000;
  const finals = opts.finals ?? {};
  const key = `seed:sim:${season}:${scheduleStamp()}:${Object.keys(finals).sort().join(",")}:${runs}:${opts.seed ?? 7}`;
  return memoSync(key, 3600, () => runSim(season, runs, opts.seed ?? 7, finals));
}

function runSim(season: number, runs: number, seedNum: number, finals: Finals): SeasonSim {
  const teams = seedTeams();
  const idx = new Map(teams.map((t, i) => [t.short, i]));
  const sched = genSchedule();
  const scoreOf = (g: (typeof sched)[number]) => (g.played && g.hs != null && g.as != null ? { hs: g.hs, as: g.as } : finals[g.id] ? { hs: finals[g.id].home, as: finals[g.id].away } : undefined);

  // Current Elo: replay every finished game through this season, as computeElo does.
  const rating = new Map<string, number>();
  let cur: number | null = null;
  for (const g of [...sched].filter((x) => x.season <= season).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id))) {
    if (g.season !== cur) {
      if (cur !== null) for (const [t, r] of rating) rating.set(t, ELO.start + (1 - ELO.regress) * (r - ELO.start));
      cur = g.season;
    }
    const s = scoreOf(g);
    if (!s) continue;
    const h = rating.get(g.home) ?? ELO.start;
    const a = rating.get(g.away) ?? ELO.start;
    const d = eloDelta(h, a, g.neutral, s.hs, s.as);
    rating.set(g.home, h + d);
    rating.set(g.away, a - d);
  }
  // A season with no finished game yet starts from last season's regressed ratings.
  if (cur !== season) for (const [t, r] of rating) rating.set(t, ELO.start + (1 - ELO.regress) * (r - ELO.start));

  const reg = sched.filter((g) => g.season === season && g.type === "REG");
  const played: SeedGame[] = [];
  const remaining: { h: number; a: number; neutral: boolean }[] = [];
  for (const g of [...reg].sort((a, b) => a.kickoff.localeCompare(b.kickoff))) {
    const s = scoreOf(g);
    if (s) played.push({ home: g.home, away: g.away, hs: s.hs, as: s.as });
    else if (idx.has(g.home) && idx.has(g.away)) remaining.push({ h: idx.get(g.home)!, a: idx.get(g.away)!, neutral: g.neutral });
  }
  // Real finals to draw simulated scores from: decisive regular-season games before this season.
  const pairs = sched.filter((g) => g.type === "REG" && g.season < season && g.played && g.hs != null && g.as != null && g.hs !== g.as).map((g) => [Math.max(g.hs!, g.as!), Math.min(g.hs!, g.as!)] as const);
  if (!pairs.length) pairs.push([24, 17]);

  const n = teams.length;
  const tally = teams.map(() => ({ playoffs: 0, division: 0, bye: 0, seedSum: 0 }));
  const base = buildState(season, teams, played);
  const start = teams.map((t) => rating.get(t.short) ?? ELO.start);
  const rng = mulberry32(seedNum);
  const playoffs = playoffTeamsFor(season);
  const byes = season >= 2020 ? 1 : 2;

  for (let run = 0; run < runs; run++) {
    const st: State = { ...base, salt: String(run), games: [...base.games], byTeam: base.byTeam.map((x) => [...x]), w: [...base.w], l: [...base.l], t: [...base.t], pf: [...base.pf], pa: [...base.pa], divRank: new Array(n).fill(0) };
    const r = [...start];
    for (const g of remaining) {
      const homeWins = rng() < eloWin(r[g.h], r[g.a], g.neutral);
      const [hi, lo] = pairs[Math.floor(rng() * pairs.length)];
      const hs = homeWins ? hi : lo;
      const as = homeWins ? lo : hi;
      const d = eloDelta(r[g.h], r[g.a], g.neutral, hs, as);
      r[g.h] += d;
      r[g.a] -= d;
      addGame(st, { h: g.h, a: g.a, hs, as });
    }
    const { confOrder } = orderSeason(st, remaining.length ? playoffs : 16);
    for (const order of confOrder) {
      if (!order) continue;
      order.forEach((i, k) => {
        const seed = k + 1;
        const x = tally[i];
        x.seedSum += seed;
        if (seed <= playoffs) x.playoffs++;
        if (seed <= byes) x.bye++;
      });
    }
    for (let i = 0; i < n; i++) if (st.divRank[i] === 1) tally[i].division++;
  }
  return {
    season,
    runs,
    remaining: remaining.length,
    played: played.length,
    teams: teams.map((t, i) => ({
      team: t.short,
      playoffs: tally[i].playoffs / runs,
      division: tally[i].division / runs,
      bye: tally[i].bye / runs,
      avgSeed: Math.round((tally[i].seedSum / runs) * 10) / 10,
      elo: Math.round(start[i]),
    })),
  };
}
