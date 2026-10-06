/**
 * Play-by-play to per-player and per-team weekly tallies, for the Leaders page (scripts/ingest-leaders.mjs) and the
 * efficiency backtest (scripts/backtest-efficiency.mjs). One function so both read every stat the same way.
 *
 * Plays counted: regular season, run or pass plays (including sacks and scrambles), no two-point tries, kneels, spikes,
 * aborted snaps, or plays wiped out by penalty. Definitions (nflfastR's public models through nflverse):
 *   success      EPA greater than zero (TruMedia and others use their own models; numbers differ)
 *   rushing      designed runs only; scrambles count as the quarterback's dropbacks
 *   explosive    a run of 10+ yards, a pass play of 20+
 *   stuffed      a run for zero or fewer yards
 *   short yardage  third or fourth down with 2 or fewer to go, on a run; converted = first down or touchdown
 *   negative     a play that loses yards, a sack, an interception, or a lost fumble
 *   dropback     pass attempts, sacks, and scrambles (qb_dropback)
 *   CPOE         nflfastR completion percentage over expected, on attempts with a model value
 *   YAC over expected  yards after catch minus nflfastR's expected YAC, on catches with a model value
 *   PROE         nflfastR pass rate over expected (pass_oe), averaged over plays that have it
 */
import { streamCsv } from "./csv-stream.mjs";

const COLS = ["season_type", "week", "posteam", "defteam", "play_type", "down", "ydstogo", "yardline_100", "qb_dropback", "qb_scramble", "qb_kneel", "qb_spike", "two_point_attempt", "aborted_play", "epa", "success", "rusher_player_id", "receiver_player_id", "passer_player_id", "rusher_player_name", "receiver_player_name", "passer_player_name", "rushing_yards", "receiving_yards", "passing_yards", "yards_gained", "air_yards", "yards_after_catch", "xyac_mean_yardage", "cpoe", "complete_pass", "pass_touchdown", "rush_touchdown", "interception", "sack", "fumble_lost", "first_down", "pass_oe", "qb_hit", "touchdown"];

const n = (v) => {
  if (v === undefined || v === "" || v === "NA") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};
const add = (o, k, v = 1) => {
  o[k] = (o[k] ?? 0) + v;
};

/**
 * @returns { players: Map<gsis, Map<week, {rush, rec, pass}>>, teams: Map<code, Map<week, {off, def}>>, teamOf: Map<gsis, code> }
 */
export async function aggregatePbp(file) {
  const players = new Map();
  const teams = new Map();
  const teamOf = new Map(); // gsis -> the last team he had the ball for
  const nameOf = new Map(); // gsis -> short name as play-by-play writes it ("J.Cook")
  const slot = (map, id, wk) => {
    const m = map.get(id) ?? map.set(id, new Map()).get(id);
    return m.get(wk) ?? m.set(wk, {}).get(wk);
  };
  await streamCsv(
    file,
    (r) => {
      if (r.season_type !== "REG") return;
      if (r.play_type !== "run" && r.play_type !== "pass") return;
      if (r.two_point_attempt === "1" || r.qb_kneel === "1" || r.qb_spike === "1" || r.aborted_play === "1") return;
      const epa = n(r.epa);
      if (epa === undefined) return;
      const wk = Number(r.week);
      const succ = n(r.success) ?? (epa > 0 ? 1 : 0);
      const yds = n(r.yards_gained) ?? 0;
      const dropback = r.qb_dropback === "1";
      const scramble = r.qb_scramble === "1";
      const sack = r.sack === "1";
      const negative = yds < 0 || sack || r.interception === "1" || r.fumble_lost === "1" ? 1 : 0;
      const explosive = (dropback ? yds >= 20 : yds >= 10) ? 1 : 0;

      // Teams: offense and defense, the same play from both sides.
      for (const [code, side] of [[r.posteam, "off"], [r.defteam, "def"]]) {
        if (!code) continue;
        const t = slot(teams, code, wk);
        const o = (t[side] ??= {});
        add(o, "plays");
        add(o, "epa", epa);
        add(o, "succ", succ);
        add(o, "expl", explosive);
        add(o, "neg", negative);
        if (dropback) {
          add(o, "db");
          add(o, "dbEpa", epa);
          if (sack) add(o, "sk");
          if (r.qb_hit === "1" || sack) add(o, "hitSk");
        } else {
          add(o, "rush");
          add(o, "rushEpa", epa);
          add(o, "rushSucc", succ);
        }
        const down = Number(r.down);
        if (down === 1 || down === 2) {
          add(o, "early");
          add(o, "earlyEpa", epa);
        }
        const poe = n(r.pass_oe);
        if (poe !== undefined) {
          add(o, "poeN");
          add(o, "poe", poe);
        }
      }

      for (const [id, nm] of [[r.rusher_player_id, r.rusher_player_name], [r.receiver_player_id, r.receiver_player_name], [r.passer_player_id, r.passer_player_name]]) {
        if (!id) continue;
        if (r.posteam) teamOf.set(id, r.posteam);
        if (nm) nameOf.set(id, nm);
      }

      // Rushing: designed runs only.
      if (r.play_type === "run" && !scramble && r.rusher_player_id) {
        const p = (slot(players, r.rusher_player_id, wk).rush ??= {});
        const ry = n(r.rushing_yards) ?? yds;
        add(p, "att");
        add(p, "yds", ry);
        add(p, "epa", epa);
        add(p, "succ", succ);
        add(p, "td", r.rush_touchdown === "1" ? 1 : 0);
        add(p, "expl", ry >= 10 ? 1 : 0);
        add(p, "stuff", ry <= 0 ? 1 : 0);
        add(p, "fd", r.first_down === "1" ? 1 : 0);
        const down = Number(r.down);
        if ((down === 3 || down === 4) && Number(r.ydstogo) <= 2) {
          add(p, "syAtt");
          add(p, "syConv", r.first_down === "1" || r.rush_touchdown === "1" ? 1 : 0);
        }
        if (Number(r.yardline_100) <= 10) add(p, "inside10");
      }

      // Receiving: targets.
      if (r.play_type === "pass" && r.receiver_player_id && !sack) {
        const p = (slot(players, r.receiver_player_id, wk).rec ??= {});
        const caught = r.complete_pass === "1";
        add(p, "tgt");
        add(p, "rec", caught ? 1 : 0);
        add(p, "yds", n(r.receiving_yards) ?? 0);
        add(p, "epa", epa);
        add(p, "succ", succ);
        add(p, "td", caught && r.pass_touchdown === "1" ? 1 : 0);
        add(p, "fd", r.first_down === "1" ? 1 : 0);
        const air = n(r.air_yards);
        if (air !== undefined) {
          add(p, "airN");
          add(p, "air", air);
          if (air >= 20) add(p, "deep");
        }
        if (caught) {
          const yac = n(r.yards_after_catch);
          const xyac = n(r.xyac_mean_yardage);
          if (yac !== undefined && xyac !== undefined) {
            add(p, "yacN");
            add(p, "yac", yac);
            add(p, "xyac", xyac);
          }
        }
        if (Number(r.yardline_100) <= 20) add(p, "rz");
      }

      // Passing: dropbacks, credited to the passer (scrambles to the scrambler).
      if (dropback) {
        const id = r.passer_player_id || (scramble ? r.rusher_player_id : "");
        if (id) {
          const p = (slot(players, id, wk).pass ??= {});
          add(p, "db");
          add(p, "epa", epa);
          add(p, "succ", succ);
          add(p, "expl", explosive);
          add(p, "neg", negative);
          if (sack) add(p, "sk");
          if (scramble) {
            add(p, "scr");
            add(p, "scrEpa", epa);
          }
          if (r.play_type === "pass" && !sack) {
            add(p, "att");
            add(p, "cmp", r.complete_pass === "1" ? 1 : 0);
            add(p, "yds", n(r.passing_yards) ?? 0);
            add(p, "td", r.pass_touchdown === "1" ? 1 : 0);
            add(p, "int", r.interception === "1" ? 1 : 0);
            const air = n(r.air_yards);
            if (air !== undefined) {
              add(p, "airN");
              add(p, "air", air);
            }
            const c = n(r.cpoe);
            if (c !== undefined) {
              add(p, "cpoeN");
              add(p, "cpoe", c);
            }
          }
        }
      }
    },
    COLS,
  );
  return { players, teams, teamOf, nameOf };
}

/** Sum a player's or team's weekly tallies, optionally only weeks before `beforeWeek`. */
export function sumWeeks(weeks, beforeWeek = Infinity) {
  const out = {};
  for (const [wk, w] of weeks) {
    if (wk >= beforeWeek) continue;
    for (const [part, tallies] of Object.entries(w)) {
      const o = (out[part] ??= { games: 0 });
      o.games++;
      for (const [k, v] of Object.entries(tallies)) o[k] = (o[k] ?? 0) + v;
    }
  }
  return out;
}
