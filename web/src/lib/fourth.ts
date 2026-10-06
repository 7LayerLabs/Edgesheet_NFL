/**
 * Fourth-down decisions for this season's games. Server-only.
 *
 * The model (data/generated/fourth-model.json, fit by scripts/fourth-fit.mjs; the math is in fourth-core.mjs) scores
 * every fourth down in nflverse's play-by-play (data/cache/play_by_play_<season>.csv, refreshed by the ingest) three
 * ways: win probability if they go for it, kick a field goal, or punt. The call made is compared with the best one;
 * the gap is its cost in points of win probability. Under 1.5 points between the top two options is a toss-up.
 *
 * The play-by-play file is read once per change (memoized on its modified time) and only fourth downs are kept.
 * Plays that are not a decision are left out: penalties that wipe out the snap, kneels and spikes, overtime (not
 * modeled), and garbage time (every option under 2% or over 98% win probability).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";
import { genSchedule } from "./generated";
import { nflTeams } from "./nfl";
import { callOf, options, stateOf, type FourthModel, type FourthOptions } from "./fourth-core.mjs";

const MODEL = path.join(process.cwd(), "data", "generated", "fourth-model.json");
const pbpFile = (season: number) => path.join(process.cwd(), "data", "cache", `play_by_play_${season}.csv`);
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

export type FourthCall = "go" | "kick" | "punt";
const CALL_WORD: Record<FourthCall, string> = { go: "go for it", kick: "kick the field goal", punt: "punt" };

export interface FourthDown {
  playId: string;
  gameId: string; // nflverse game id
  team: string; // nickname, the team with the ball
  opp: string;
  qtr: number;
  clock: string; // "6:12"
  situation: string; // "4th and 2 at the Cowboys 38, up 3, 6:12 left in the 3rd"
  call: FourthCall;
  callWord: string;
  modelCall: FourthCall;
  modelWord: string;
  wp: { go: number; kick?: number; punt?: number }; // percent, one decimal
  pConvert: number; // percent
  pMake?: number; // percent
  cost: number; // points of win probability given up by the call made (0 when it was the best)
  tossUp: boolean;
  agree: boolean; // the call made was the model's call, or the top two were a toss-up
  result: string; // "converted", "failed", "made 44 yards", "missed 51 yards", "punted 47 yards"
  desc: string;
}

/** The fitted model, or undefined before scripts/fourth-fit.mjs has run. */
export function fourthModel(): FourthModel | undefined {
  return memoSync(`fourth:model:${mtime(MODEL)}`, 3600, () => {
    if (!existsSync(MODEL)) return undefined;
    try {
      return JSON.parse(readFileSync(MODEL, "utf8")) as FourthModel;
    } catch {
      return undefined;
    }
  });
}

const KEEP = ["play_id", "game_id", "home_team", "away_team", "season_type", "posteam", "defteam", "yardline_100", "game_seconds_remaining", "qtr", "down", "ydstogo", "time", "desc", "play_type", "yards_gained", "score_differential", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "spread_line", "fourth_down_converted", "fourth_down_failed", "field_goal_result", "kick_distance", "penalty"];

/** Rows of a CSV text where `want(row)` holds, with only the KEEP columns. Handles quotes, doubled quotes, newlines in quotes. */
function parseFourthRows(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let header: string[] | null = null;
  let idx: [string, number][] = [];
  let downAt = -1;
  let field = "";
  let rec: string[] = [];
  let q = false;
  const emit = () => {
    rec.push(field);
    field = "";
    if (!header) {
      header = rec;
      idx = header.map((h, i) => [h, i] as [string, number]).filter(([h]) => KEEP.includes(h));
      downAt = header.indexOf("down");
    } else if (rec[downAt] === "4") {
      const o: Record<string, string> = {};
      for (const [h, i] of idx) o[h] = rec[i] ?? "";
      out.push(o);
    }
    rec = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      rec.push(field);
      field = "";
    } else if (c === "\n") emit();
    else if (c !== "\r") field += c;
  }
  if (field || rec.length) emit();
  return out;
}

const nick = (code: string) => nflTeams().find((t) => t.code === code || t.abbr === code)?.short ?? code;
const ORD = ["", "1st", "2nd", "3rd", "4th"];

function situationOf(r: Record<string, string>, team: string, opp: string): string {
  const yl = Number(r.yardline_100);
  const togo = Number(r.ydstogo);
  const sd = Number(r.score_differential);
  const spot = yl === 50 ? "midfield" : yl > 50 ? `the ${team} ${100 - yl}` : `the ${opp} ${yl}`;
  const dist = togo >= yl ? "goal" : String(togo);
  const score = sd > 0 ? `up ${sd}` : sd < 0 ? `down ${-sd}` : "tied";
  const clock = (r.time || "").replace(/^0(\d)/, "$1");
  return `4th and ${dist} at ${spot}, ${score}, ${clock} left in the ${ORD[Number(r.qtr)] ?? `${r.qtr}th`}`;
}

function resultOf(r: Record<string, string>, call: FourthCall): string {
  if (call === "go") return r.fourth_down_converted === "1" ? "converted" : r.fourth_down_failed === "1" ? "failed" : "no result recorded";
  if (call === "kick") return `${r.field_goal_result === "made" ? "made" : r.field_goal_result === "blocked" ? "blocked" : "missed"}${r.kick_distance ? ` from ${r.kick_distance} yards` : ""}`;
  return r.kick_distance ? `punted ${r.kick_distance} yards` : "punted";
}

/** Every scored fourth down of a season, keyed by nflverse game id. Memoized on the play-by-play file and the model. */
function seasonFourths(season: number): Map<string, FourthDown[]> {
  const f = pbpFile(season);
  return memoSync(`fourth:season:${season}:${mtime(f)}:${mtime(MODEL)}`, 3600, () => {
    const out = new Map<string, FourthDown[]>();
    const model = fourthModel();
    if (!model || !existsSync(f)) return out;
    for (const r of parseFourthRows(readFileSync(f, "utf8"))) {
      if (r.season_type !== "REG" && r.season_type !== "POST") continue;
      if (r.penalty === "1" || Number(r.qtr) > 4) continue;
      const call = callOf(r.play_type);
      const st = stateOf(r);
      if (!call || !st || st.gsr <= 0) continue;
      const o: FourthOptions = options(model, st);
      const wps = [o.go.wp, o.kick?.wp, o.punt?.wp].filter((x): x is number => x !== undefined);
      if (Math.max(...wps) < 0.02 || Math.min(...wps) > 0.98) continue;
      const chosen = o[call];
      if (!chosen) continue; // a punt from inside their 30 or a kick past 63 yards: not an option the model scores
      const best = o[o.best]!;
      const cost = r1((best.wp - chosen.wp) * 100);
      const team = nick(r.posteam);
      const opp = nick(r.defteam);
      const row: FourthDown = {
        playId: r.play_id,
        gameId: r.game_id,
        team,
        opp,
        qtr: Number(r.qtr),
        clock: (r.time || "").replace(/^0(\d)/, "$1"),
        situation: situationOf(r, team, opp),
        call,
        callWord: CALL_WORD[call],
        modelCall: o.best,
        modelWord: CALL_WORD[o.best],
        wp: { go: r1(o.go.wp * 100), kick: o.kick ? r1(o.kick.wp * 100) : undefined, punt: o.punt ? r1(o.punt.wp * 100) : undefined },
        pConvert: Math.round(o.go.pConvert * 100),
        pMake: o.kick ? Math.round(o.kick.pMake * 100) : undefined,
        cost,
        tossUp: o.tossUp,
        agree: call === o.best || o.tossUp || cost < 1.5,
        result: resultOf(r, call),
        desc: r.desc,
      };
      const list = out.get(r.game_id) ?? out.set(r.game_id, []).get(r.game_id)!;
      list.push(row);
    }
    return out;
  });
}

/** Fourth downs for one game (the app's ESPN game id), in game order. Empty when there is no play-by-play yet. */
export function fourthDownsFor(gameId: string): FourthDown[] {
  const g = genSchedule().find((x) => x.id === gameId);
  if (!g) return [];
  return seasonFourths(g.season).get(g.gid) ?? [];
}

export interface FourthSummary {
  team: string;
  season: number;
  decisions: number;
  agreed: number;
  disagreed: number; // calls the model would not make, toss-ups excluded
  wentForIt: number;
  modelSaidGo: number;
  givenUp: number; // total points of win probability given up by the calls made
  worst?: FourthDown;
}

/** A team's fourth downs this season against the model. */
export function teamFourthSummary(team: string, season: number): FourthSummary {
  const all = [...seasonFourths(season).values()].flat().filter((d) => d.team === team);
  const worst = [...all].sort((a, b) => b.cost - a.cost)[0];
  return {
    team,
    season,
    decisions: all.length,
    agreed: all.filter((d) => d.agree).length,
    disagreed: all.filter((d) => !d.agree).length,
    wentForIt: all.filter((d) => d.call === "go").length,
    modelSaidGo: all.filter((d) => d.modelCall === "go" && !d.tossUp).length,
    givenUp: r1(all.reduce((a, d) => a + d.cost, 0)),
    worst: worst && worst.cost >= 1.5 ? worst : undefined,
  };
}

/** One line on what the model is and how it was checked, for the page footnote. */
export function fourthMethodNote(): string | undefined {
  const m = fourthModel() as (FourthModel & { wp: { holdout?: { maeVsNflfastr?: number; season?: number } } }) | undefined;
  if (!m) return undefined;
  const h = m.wp.holdout;
  return `Win probability from a model fit to nflfastR's own numbers on ${m.seasons[0]}-${m.seasons[m.seasons.length - 1]} (off by ${h?.maeVsNflfastr !== undefined ? `${(h.maeVsNflfastr * 100).toFixed(1)} points` : "a little"} on average in ${h?.season ?? "a held-out season"}), conversion and field goal chances from ${m.go.attempts.toLocaleString("en-US")} fourth-down tries and ${m.fg.attempts.toLocaleString("en-US")} kicks. A model, not a verdict: it does not know the injuries, the matchup, or the wind.`;
}
