/**
 * Fourth-down decision model, the pure part shared by scripts/fourth-fit.mjs, scripts/backtest-fourth.mjs, and
 * src/lib/fourth.ts. No I/O. Everything is from the possession team's side unless a name says otherwise.
 *
 * The idea is nflverse's nfl4th, rebuilt without R:
 *   1. Win probability (WP) of a game state, from a compact logistic model distilled from nflfastR's vegas_wp: five
 *      time segments (first half, third quarter, fourth quarter to 6:00, 6:00 to 2:00, last 2:00), each with its own
 *      28 coefficients on score, score times time left, one-score and two-score flags (and lead or deficit buckets
 *      crossed with field position, time, and timeouts, which matter most late), the pregame spread fading with time,
 *      field position, down and distance, home, and timeouts. Fit in scripts/fourth-fit.mjs.
 *   2. Three options, each scored as the WP after the play:
 *      go     P(convert) x WP(first down at the expected spot, or a touchdown when the gain reaches the goal line)
 *             + P(fail) x (1 - WP of the opponent's first down at the spot)
 *      kick   P(make) x (1 - WP of the opponent after a kickoff, us 3 points better)
 *             + P(miss) x (1 - WP of the opponent's first down at the spot of the kick or their 20)
 *      punt   1 - WP of the opponent's first down at the average start after a punt from this spot
 *      Conversion, make, gain, and punt numbers are empirical (2018 to 2025 regular seasons), stored in the model file.
 *   3. The best option wins; the cost of a call is the best WP minus the WP of the call made, in percentage points.
 *      Under 1.5 points between the top two is a toss-up.
 * Assumptions, said here so the page can say them too: after a score the opponent starts at its own 30 (yardline 70);
 * a go-for-it play uses 6 seconds, a kick 5, a punt 8; overtime is not modeled.
 */

/** Game seconds remaining at each segment's start (exclusive end at the next). */
export const SEGMENTS = [
  { name: "first half", hi: 3600, lo: 1800 },
  { name: "third quarter", hi: 1800, lo: 900 },
  { name: "fourth quarter to 6:00", hi: 900, lo: 360 },
  { name: "6:00 to 2:00", hi: 360, lo: 120 },
  { name: "last 2:00", hi: 120, lo: 0 },
];

export const FEATURES = ["intercept", "score/7", "score x time left in segment", "one-score lead (capped at 8)", "up 9+", "down 9+", "spread/7 x time left in game", "field position", "field position x time left in segment", "2nd down", "3rd down", "4th down", "yards to go/10", "home", "own timeouts/3", "their timeouts/3", "time left in segment", "up 1-3", "up 4-8", "down 1-3", "down 4-8", "field position when ahead", "field position when behind", "time left x one-score lead", "time left x one-score deficit", "their timeouts x one-score lead", "own timeouts x one-score deficit", "score x field position"];

export const AFTER_SCORE_YL = 70;
export const SECONDS = { go: 6, kick: 5, punt: 8 };

export function segmentOf(gsr) {
  for (let i = 0; i < SEGMENTS.length; i++) if (gsr > SEGMENTS[i].lo || i === SEGMENTS.length - 1) return i;
  return SEGMENTS.length - 1;
}

/** Feature row for a state: { sd, gsr, yl, down, togo, toPos, toDef, home, spread }. */
export function features(st) {
  const gsr = Math.max(0, Math.min(3600, st.gsr));
  const seg = SEGMENTS[segmentOf(gsr)];
  const tseg = (gsr - seg.lo) / (seg.hi - seg.lo);
  const rem = gsr / 3600;
  const sd = Math.max(-50, Math.min(50, st.sd));
  const s = sd / 7;
  const fp = (50 - st.yl) / 50;
  return [
    1,
    s,
    s * tseg,
    (Math.sign(sd) * Math.min(Math.abs(sd), 8)) / 8,
    sd >= 9 ? 1 : 0,
    sd <= -9 ? 1 : 0,
    ((st.spread ?? 0) / 7) * rem,
    fp,
    fp * tseg,
    st.down === 2 ? 1 : 0,
    st.down === 3 ? 1 : 0,
    st.down === 4 ? 1 : 0,
    Math.min(st.togo ?? 10, 20) / 10,
    st.home ?? 0.5,
    (st.toPos ?? 3) / 3,
    (st.toDef ?? 3) / 3,
    tseg,
    sd >= 1 && sd <= 3 ? 1 : 0,
    sd >= 4 && sd <= 8 ? 1 : 0,
    sd <= -1 && sd >= -3 ? 1 : 0,
    sd <= -4 && sd >= -8 ? 1 : 0,
    sd > 0 ? fp : 0,
    sd < 0 ? fp : 0,
    sd >= 1 && sd <= 8 ? tseg : 0,
    sd <= -1 && sd >= -8 ? tseg : 0,
    sd >= 1 && sd <= 8 ? (st.toDef ?? 3) / 3 : 0,
    sd <= -1 && sd >= -8 ? (st.toPos ?? 3) / 3 : 0,
    s * fp,
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Win probability for the possession team. After the clock runs out the score decides. */
export function wp(model, st) {
  if (st.gsr <= 0) return st.sd > 0 ? 1 : st.sd < 0 ? 0 : 0.5;
  const w = model.wp.segments[segmentOf(st.gsr)];
  const x = features(st);
  let z = 0;
  for (let i = 0; i < x.length; i++) z += w[i] * x[i];
  return sigmoid(z);
}

/** The same state from the other team's side, first and 10 (or goal) at `yl` from its own perspective. */
function oppFirstDown(st, yl, sdForUs, seconds) {
  return {
    sd: -sdForUs,
    gsr: st.gsr - seconds,
    yl: Math.max(1, Math.min(99, yl)),
    down: 1,
    togo: Math.min(10, Math.max(1, Math.round(yl))),
    toPos: st.toDef,
    toDef: st.toPos,
    home: st.home === 0.5 ? 0.5 : 1 - (st.home ?? 0.5),
    spread: -(st.spread ?? 0),
  };
}

export function convProb(model, togo, yl) {
  const c = model.go.coef;
  const goal = togo >= yl ? 1 : 0;
  const z = c[0] + c[1] * Math.log(Math.max(1, togo)) + c[2] * goal + c[3] * (togo <= 1 ? 1 : 0);
  return sigmoid(z);
}

export function gainIfConverted(model, togo) {
  const t = model.go.gain;
  const row = t.find((r) => togo >= r.lo && togo <= r.hi) ?? t[t.length - 1];
  return Math.max(togo, row.mean);
}

export function fgProb(model, dist) {
  if (dist > model.fg.maxDistance) return 0;
  const c = model.fg.coef;
  const d = dist / 10;
  return sigmoid(c[0] + c[1] * d + c[2] * d * d);
}

export function puntOppYl(model, yl) {
  const t = model.punt.table;
  const row = t.find((r) => yl >= r.lo && yl <= r.hi);
  if (row) return row.oppYl;
  return yl < t[0].lo ? 80 : t[t.length - 1].oppYl;
}

/**
 * WP after each option for a fourth down. `st` is the state before the snap. Returns WP (0..1) for go, kick (when the
 * kick is 63 yards or shorter), and punt (from your own side of the 30 or further back, i.e. yl >= 30), plus the pieces.
 */
export function options(model, st) {
  const out = {};
  const yl = st.yl;
  const pc = convProb(model, st.togo, yl);
  // Go: success is a first down at the expected gain, or a touchdown when the gain reaches the goal line.
  const gain = gainIfConverted(model, st.togo);
  const td = gain >= yl;
  const winIfConvert = td
    ? 1 - wp(model, oppFirstDown(st, AFTER_SCORE_YL, st.sd + 7, SECONDS.go))
    : wp(model, { ...st, gsr: st.gsr - SECONDS.go, yl: yl - gain, down: 1, togo: Math.min(10, yl - gain) });
  const winIfFail = 1 - wp(model, oppFirstDown(st, 100 - yl, st.sd, SECONDS.go));
  out.go = { wp: pc * winIfConvert + (1 - pc) * winIfFail, pConvert: pc, gain: Math.round(gain * 10) / 10, touchdown: td };
  const dist = yl + 17;
  if (dist <= 63) {
    const pm = fgProb(model, dist);
    const winIfMake = 1 - wp(model, oppFirstDown(st, AFTER_SCORE_YL, st.sd + 3, SECONDS.kick));
    const winIfMiss = 1 - wp(model, oppFirstDown(st, Math.min(80, 93 - yl), st.sd, SECONDS.kick));
    out.kick = { wp: pm * winIfMake + (1 - pm) * winIfMiss, pMake: pm, distance: dist };
  }
  if (yl >= 30) {
    const oppYl = puntOppYl(model, yl);
    out.punt = { wp: 1 - wp(model, oppFirstDown(st, oppYl, st.sd, SECONDS.punt)), oppYl };
  }
  const ranked = Object.entries(out).sort((a, b) => b[1].wp - a[1].wp);
  const best = ranked[0][0];
  const margin = ranked.length > 1 ? (ranked[0][1].wp - ranked[1][1].wp) * 100 : 100;
  return { ...out, best, margin: Math.round(margin * 10) / 10, tossUp: margin < 1.5 };
}

/** The call made from a play row's play_type: go (run or pass), kick (field goal), punt; undefined for others. */
export function callOf(playType) {
  if (playType === "run" || playType === "pass") return "go";
  if (playType === "field_goal") return "kick";
  if (playType === "punt") return "punt";
  return undefined;
}

/** State from an nflverse play-by-play row (strings), possession side. Undefined when the row is not usable. */
export function stateOf(r) {
  const n = (k) => (r[k] === "" || r[k] === "NA" || r[k] === undefined ? NaN : Number(r[k]));
  const gsr = n("game_seconds_remaining");
  const yl = n("yardline_100");
  const down = n("down");
  const togo = n("ydstogo");
  const sd = n("score_differential");
  if (![gsr, yl, down, togo, sd].every(Number.isFinite)) return undefined;
  const spreadLine = n("spread_line");
  const home = r.posteam === r.home_team ? 1 : 0;
  const spread = Number.isFinite(spreadLine) ? (home ? spreadLine : -spreadLine) : 0;
  return {
    sd,
    gsr,
    yl,
    down,
    togo,
    toPos: Number.isFinite(n("posteam_timeouts_remaining")) ? n("posteam_timeouts_remaining") : 3,
    toDef: Number.isFinite(n("defteam_timeouts_remaining")) ? n("defteam_timeouts_remaining") : 3,
    home,
    spread,
  };
}
