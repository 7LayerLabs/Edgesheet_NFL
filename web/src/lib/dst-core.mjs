/**
 * DraftKings DST (team defense) scoring and projection, shared by scripts/build-dfs-sim.mjs (the backtest), scripts/ingest.mjs
 * (team rates for the live app), and src/lib/dst.ts. Plain JavaScript so Node scripts and Next both import it.
 *
 * Scoring (DraftKings Classic): sack 1, interception 2, fumble recovery 2, defensive or return TD 6, safety 2, and points
 * allowed 0: 10, 1-6: 7, 7-13: 4, 14-20: 1, 21-27: 0, 28-34: -1, 35+: -4. Blocked kicks are not in the weekly player file and
 * are left out (about 0.1 a game).
 *
 * Projection: sacks and takeaways are half the defense's own rate and half the opponent's rate allowed (sacks taken,
 * giveaways), each blended with last season at 3 games; TDs are half the defense's rate and half the league's; points
 * allowed is the expected tier score when the opponent scores Normal(market implied total, 9.5). Backtest 2022 to 2025
 * (1,918 team-weeks): MAE 4.05 against 4.27 for the defense's season average.
 */

export const DST = { sd: 9.5, tdLeague: 0.16, safetyLeague: 0.035, rateWeight: 0.5, priorGames: 3 };

/** DraftKings points-allowed tiers. */
export const paPoints = (pa) => (pa <= 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4);

function erf(x) {
  // Abramowitz and Stegun 7.1.26.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Expected points-allowed score when the opponent scores Normal(implied, sd), floored at 0. */
export function expectedPa(implied, sd = DST.sd) {
  const cdf = (x) => 0.5 * (1 + erf((x - implied) / (sd * Math.SQRT2)));
  let e = 0;
  let prev = 0;
  for (let s = 0; s <= 70; s++) {
    const upTo = s === 70 ? 1 : cdf(s + 0.5);
    e += (upTo - prev) * paPoints(s);
    prev = upTo;
  }
  return e;
}

/** DST points for one game from its counts. */
export const dstPoints = (w, oppScore) => w.sk + 2 * w.to + 6 * w.td + 2 * w.saf + paPoints(oppScore);

/**
 * Per team-week counts from nflverse weekly player rows (stats_player_week): the team's defense (sacks, takeaways, TDs,
 * safeties) and its offense's giveaways and sacks taken. Rows need team, week, and the numeric fields named below.
 * @returns {Map<string, {week:number, team:string, opp:string, sk:number, to:number, td:number, saf:number, give:number, sks:number}>}
 */
export function teamWeeks(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.week}|${r.team}`;
    const e = m.get(k) ?? m.set(k, { week: r.week, team: r.team, opp: r.opp, sk: 0, to: 0, td: 0, saf: 0, give: 0, sks: 0 }).get(k);
    e.sk += r.sk; e.to += r.int + r.fr; e.td += r.dtd + r.sttd; e.saf += r.saf; e.give += r.give; e.sks += r.sks;
  }
  return m;
}

/** Season totals per team from team-weeks: games, counts, and DK DST points (needs the opponent's score per week). */
export function seasonRates(weeks, oppScoreOf) {
  const out = new Map();
  for (const w of weeks) {
    const score = oppScoreOf(w);
    const e = out.get(w.team) ?? out.set(w.team, { g: 0, sk: 0, to: 0, td: 0, saf: 0, give: 0, sks: 0, dst: 0 }).get(w.team);
    e.g++; e.sk += w.sk; e.to += w.to; e.td += w.td; e.saf += w.saf; e.give += w.give; e.sks += w.sks;
    if (score !== undefined) e.dst += dstPoints(w, score);
  }
  return out;
}

/** Per-game rate for one count, this season blended with last season at `priorGames` games. */
export function blendRate(now, prev, k, priorGames = DST.priorGames) {
  if (!now?.g) return prev?.g ? prev[k] / prev.g : undefined;
  return prev?.g ? (now[k] + (priorGames * prev[k]) / prev.g) / (now.g + priorGames) : now[k] / now.g;
}

/**
 * DST projection. `team` and `opp` are { now, prev } season totals (seasonRates rows); oppImplied is the opponent's
 * market implied team total. Returns the projection and its parts.
 */
export function projectDst(team, opp, oppImplied) {
  const W = DST.rateWeight;
  const sk = W * (blendRate(team.now, team.prev, "sk") ?? 2.4) + (1 - W) * (blendRate(opp.now, opp.prev, "sks") ?? 2.4);
  const to = W * (blendRate(team.now, team.prev, "to") ?? 1.3) + (1 - W) * (blendRate(opp.now, opp.prev, "give") ?? 1.3);
  const td = 0.5 * (blendRate(team.now, team.prev, "td") ?? DST.tdLeague) + 0.5 * DST.tdLeague;
  const pa = expectedPa(oppImplied);
  return { proj: sk + 2 * to + 6 * td + 2 * DST.safetyLeague + pa, sacks: sk, takeaways: to, tds: td, paPoints: pa };
}
