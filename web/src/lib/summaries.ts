/**
 * One-line summaries for the collapsible sections on the game page. Every
 * sentence is derived from the data already on the Game object; nothing is
 * invented. When the input is missing the sentence says so.
 */
import type { Game, Prospect } from "./types";
import { evaluateWeather } from "./weather";
import { spreadText } from "./format";
import { scoutScore } from "./score";

const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;

export function whyWatchSummary(g: Game): string {
  const r = g.whyWatchReasons;
  if (!r.length) return g.whyWatch;
  return r[0].replace(/\.$/, "");
}

export function decidedSummary(g: Game): string {
  const edges = g.matchups.filter((m) => m.edge && m.edge !== "even");
  const strong = g.matchups.filter((m) => m.strength === "dominant" || m.strength === "clear");
  const parts: string[] = [];
  if (g.matchups.length) parts.push(`${n(edges.length, "edge")} across ${g.matchups.length} matchups${strong.length ? `, ${strong.length} clear` : ""}`);
  else parts.push("Unit matchups not charted yet");
  const p = g.projection;
  if (p) {
    const w = p.winner === g.home.abbr ? g.home.short : g.away.short;
    parts.push(`model ${w} by ${p.margin.toFixed(1)} at ${Math.round(p.winProb * 100)}%`);
  }
  return parts.join("; ");
}

export function radarSummary(g: Game): string {
  const ps = g.prospects;
  if (!ps.length) return "Nobody on either roster clears the radar";
  const eligible = ps.filter((p) => p.tier === "Rookie" || p.tier === "Breakout" || p.tier === "Matchup");
  const top = [...ps].sort((a, b) => (b.radar?.score ?? 0) - (a.radar?.score ?? 0))[0];
  const lead = top ? `, led by ${top.name} (${top.pos}${top.projected ? `, ${top.projected.replace(" (forecast)", "")}` : ""})` : "";
  return `${n(eligible.length, "rookie, breakout, or matchup name")}, ${n(ps.length - eligible.length, "watch name")}${lead}`;
}

export function eyeSummary(g: Game): string {
  const k = g.keepAnEyeOn;
  if (!k.length) return "No sleepers or risers flagged";
  return `${n(k.length, "name")}: ${k.slice(0, 3).map((x) => x.name).join(", ")}${k.length > 3 ? ` and ${k.length - 3} more` : ""}`;
}

export function styleSummary(g: Game): string {
  const ao = g.offense[g.away.abbr];
  const ho = g.offense[g.home.abbr];
  const ad = g.defense[g.away.abbr];
  const hd = g.defense[g.home.abbr];
  if (!ao || ao.sample === "unavailable") return "Tendencies not charted yet";
  const short = (s?: string) => (s ?? "unmeasured").replace(/\.$/, "");
  return `${g.away.abbr}: ${short(ao.label)} O, ${short(ad?.label)} D. ${g.home.abbr}: ${short(ho?.label)} O, ${short(hd?.label)} D`;
}

export function conditionsSummary(g: Game): string {
  const w = g.weather;
  if (!w) return g.climate ? "No forecast yet; venue baseline on file" : "No forecast available";
  const flags = evaluateWeather(w);
  const top = flags.find((f) => f.level === "elevated") ?? flags.find((f) => f.level === "flag");
  if (w.roof === "fixed" || w.roof === "retractable-closed") return `Indoors, ${w.roof === "fixed" ? "fixed roof" : "roof closed"}`;
  const wind = w.windMph > 0 ? `wind ${w.windDir} ${w.windMph}` : "calm";
  const rain = w.precipChance >= 30 ? `, rain ${w.precipChance}%` : "";
  return `${w.tempF} and ${wind}${rain}, ${top ? top.title.toLowerCase() : "no flag"}`;
}

export function marketSummary(g: Game): string {
  const m = g.market;
  if (!m.spread) return "No widely available line";
  const parts = [spreadText(m.spread.team, m.spread.line)];
  if (m.total) parts.push(`total ${m.total.line}`);
  const p = g.projection;
  if (p?.modelSide && p.sideGap !== undefined) parts.push(p.sideGap >= 2 ? `model leans ${p.modelSide} by ${p.sideGap.toFixed(1)}` : "model on the number");
  if (p?.totalLean && p.totalLean !== "none" && p.totalGap !== undefined) parts.push(`${p.totalLean} by ${Math.abs(p.totalGap).toFixed(1)}`);
  return parts.join(", ");
}

export function storylinesSummary(g: Game): string {
  if (!g.storylines.length) return "Nothing on file beyond the schedule";
  return `${n(g.storylines.length, "storyline")}: ${g.storylines[0].replace(/\.$/, "").slice(0, 90)}${g.storylines[0].length > 90 ? "..." : ""}`;
}

export function feedSummary(g: Game): string {
  return `Posts and headlines about ${g.away.short} and ${g.home.short}, tagged to radar names`;
}

export function scoreSummary(g: Game): string {
  const s = scoutScore(g.scoreComponents);
  const missing = Object.values(g.scoreComponents).filter((v) => v === null).length;
  return `${s} of 100 across ${7 - missing} of 7 inputs${missing ? `, ${n(missing, "input")} not ingested` : ""}`;
}

export function reportSummary(headline?: string, oneLine?: string): string {
  if (!headline) return "No report written yet";
  return oneLine ?? headline;
}

export function liveSummary(g: Game): string {
  const l = g.live;
  const s = g.score;
  if (!s) return "Waiting on the feed";
  const sit = l?.possession ? `, ${l.possession} ball${l.downDistance ? ` ${l.downDistance}` : ""}` : "";
  return `${g.away.abbr} ${s.away}, ${g.home.abbr} ${s.home}, ${s.clock}${sit}`;
}

export function showedSummary(g: Game): string {
  if (!g.box) return g.status === "final" ? "Box score not published yet" : "Opens at kickoff";
  const post = g.archive?.postgame;
  const leaders = g.box.teams.flatMap((t) => t.leaders.slice(0, 1).map((l) => `${l.name} ${l.headline}`));
  if (post) {
    const pros = post.prospects.filter((p) => p.verdict !== "unmeasured");
    const showed = pros.filter((p) => p.verdict === "showed up").length;
    return `${showed} of ${pros.length} radar names showed up${leaders.length ? `; ${leaders.join(", ")}` : ""}`;
  }
  return leaders.length ? leaders.join(", ") : "Box leaders only";
}

/** Shared by the grade card and the scorecard: the pregame call in one sentence. */
export function pregameCallSentence(g: Game): string | undefined {
  const pre = g.archive?.pregame.projection ?? (g.projection ? { winner: g.projection.winner, margin: g.projection.margin, winProb: g.projection.winProb } : undefined);
  if (!pre) return undefined;
  const w = pre.winner === g.home.abbr ? g.home.short : g.away.short;
  return `We said ${w} by ${pre.margin.toFixed(1)} at ${Math.round(pre.winProb * 100)}%`;
}

export function topProspects(ps: Prospect[], k = 3): Prospect[] {
  return [...ps].sort((a, b) => (b.radar?.score ?? 0) - (a.radar?.score ?? 0)).slice(0, k);
}
