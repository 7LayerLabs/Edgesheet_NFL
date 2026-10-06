/**
 * One season of coverage, from nflverse pbp_participation (FTN charting: man or zone, the coverage shell, pass rushers,
 * pressure, offensive personnel) joined to play-by-play (who was targeted, yards, touchdowns, EPA) on game id and play id.
 * Regular season only. Shared by scripts/ingest-coverage.mjs and scripts/backtest-coverage.mjs.
 *
 * Dropbacks are play-by-play `pass` plays (attempts, sacks, scrambles); targets are pass attempts with a receiver, sacks
 * out. A play counts toward man or zone only when the charting names one (it does on pass plays, not runs).
 *
 * The parsed season is cached in data/cache/coverage_agg_<season>.json (the cache folder is gitignored), keyed on the
 * two source files' sizes and times, so the backtest does not re-read 150 MB per season.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { streamCsv } from "./csv-stream.mjs";

const num = (v) => {
  if (v === "" || v === undefined || v === null || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** "1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR" to "11" (backs including fullbacks, then tight ends). */
export function personnelGroup(s) {
  if (!s) return undefined;
  const count = (pos) => Number((new RegExp(`(\\d+) ${pos}\\b`).exec(s) ?? [])[1] ?? 0);
  const rb = count("RB") + count("FB");
  const te = count("TE");
  const wr = count("WR");
  if (rb + te + wr !== 5) return "other"; // jumbo or odd packages (extra linemen) do not get a two-digit name
  return `${rb}${te}`;
}

/** Bump when the cached aggregate shape changes. */
const VERSION = 2;
const MAN = "MAN_COVERAGE";
/** Safety shells: one deep safety (Cover 1, Cover 3) or two (Cover 2, 4, 6, 2-man). Cover 0, Cover 9, combination and blown plays are neither. */
export const ONE_HIGH = ["COVER_1", "COVER_3"];
export const TWO_HIGH = ["COVER_2", "COVER_4", "COVER_6", "2_MAN"];
const highOf = (cov) => (ONE_HIGH.includes(cov) ? "high1" : TWO_HIGH.includes(cov) ? "high2" : undefined);
const ZONE = "ZONE_COVERAGE";

export async function aggregateSeason(season, cacheDir) {
  const part = path.join(cacheDir, `pbp_participation_${season}.csv`);
  const pbp = [path.join(cacheDir, `play_by_play_${season}.csv.gz`), path.join(cacheDir, `play_by_play_${season}.csv`)].find((f) => existsSync(f));
  if (!existsSync(part) || !pbp) return undefined;
  const stamp = `v${VERSION}|` + [part, pbp].map((f) => `${statSync(f).size}:${Math.round(statSync(f).mtimeMs)}`).join("|");
  const cacheFile = path.join(cacheDir, `coverage_agg_${season}.json`);
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c.stamp === stamp) return c;
    } catch {
      /* rebuild */
    }
  }

  // Participation: one small record per play.
  const plays = new Map();
  await streamCsv(
    part,
    (r) => {
      const key = `${r.nflverse_game_id}|${r.play_id}`;
      const mz = r.defense_man_zone_type === MAN ? "man" : r.defense_man_zone_type === ZONE ? "zone" : undefined;
      plays.set(key, {
        mz,
        cov: r.defense_coverage_type || undefined,
        rushers: num(r.number_of_pass_rushers),
        pressure: r.was_pressure === "TRUE" ? 1 : r.was_pressure === "FALSE" ? 0 : undefined,
        pers: personnelGroup(r.offense_personnel),
      });
    },
    ["nflverse_game_id", "play_id", "defense_man_zone_type", "defense_coverage_type", "number_of_pass_rushers", "was_pressure", "offense_personnel"],
  );

  const blankSide = () => ({ n: 0, epa: 0 });
  const teams = {};
  const team = (code) =>
    (teams[code] ??= {
      def: { dropbacks: 0, charted: 0, man: 0, zone: 0, shells: {}, rushKnown: 0, rush5: 0, pressKnown: 0, press: 0, vsMan: blankSide(), vsZone: blankSide() },
      off: { plays: 0, personnel: {}, vsMan: blankSide(), vsZone: blankSide(), vsHigh1: blankSide(), vsHigh2: blankSide() },
    });
  const receivers = {};
  const blankRec = () => ({ tgt: 0, catches: 0, yards: 0, td: 0, epa: 0 });
  const recv = (id, name) => (receivers[id] ??= { name, teams: {}, targets: 0, catches: 0, yards: 0, td: 0, epa: 0, man: blankRec(), zone: blankRec(), high1: blankRec(), high2: blankRec() });

  await streamCsv(
    pbp,
    (r) => {
      if (r.season_type !== "REG" || !r.posteam || !r.defteam) return;
      const isPass = r.pass === "1";
      const isRun = r.rush === "1";
      if (!isPass && !isRun) return;
      const p = plays.get(`${r.game_id}|${r.play_id}`);
      const epa = num(r.epa) ?? 0;
      const off = team(r.posteam).off;
      if (p?.pers) {
        off.plays++;
        off.personnel[p.pers] = (off.personnel[p.pers] ?? 0) + 1;
      }
      if (!isPass) return;
      const def = team(r.defteam).def;
      def.dropbacks++;
      if (p?.rushers != null) {
        def.rushKnown++;
        if (p.rushers >= 5) def.rush5++;
      }
      if (p?.pressure != null) {
        def.pressKnown++;
        def.press += p.pressure;
      }
      if (p?.mz) {
        def.charted++;
        def[p.mz]++;
        if (p.cov) def.shells[p.cov] = (def.shells[p.cov] ?? 0) + 1;
        const side = p.mz === "man" ? "vsMan" : "vsZone";
        def[side].n++;
        def[side].epa += epa;
        off[side].n++;
        off[side].epa += epa;
        const hi = highOf(p.cov);
        if (hi) {
          const k = hi === "high1" ? "vsHigh1" : "vsHigh2";
          off[k].n++;
          off[k].epa += epa;
        }
      }
      // Targets: pass attempts with a receiver, sacks out.
      if (r.pass_attempt === "1" && r.sack !== "1" && r.receiver_player_id) {
        const rc = recv(r.receiver_player_id, r.receiver_player_name);
        const yards = r.complete_pass === "1" ? num(r.receiving_yards) ?? num(r.yards_gained) ?? 0 : 0;
        const td = r.pass_touchdown === "1" ? 1 : 0;
        const caught = r.complete_pass === "1" ? 1 : 0;
        rc.teams[r.posteam] = (rc.teams[r.posteam] ?? 0) + 1;
        rc.targets++;
        rc.catches += caught;
        rc.yards += yards;
        rc.td += td;
        rc.epa += epa;
        const add = (s) => {
          s.tgt++;
          s.catches += caught;
          s.yards += yards;
          s.td += td;
          s.epa += epa;
        };
        if (p?.mz) add(rc[p.mz]);
        const hi = highOf(p?.cov);
        if (hi) add(rc[hi]);
      }
    },
    ["game_id", "play_id", "season_type", "posteam", "defteam", "pass", "rush", "pass_attempt", "sack", "complete_pass", "receiver_player_id", "receiver_player_name", "receiving_yards", "yards_gained", "pass_touchdown", "epa"],
  );
  plays.clear();
  const out = { season, stamp, teams, receivers };
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}
