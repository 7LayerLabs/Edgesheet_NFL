import { absentWords } from "./availability";
import { evaluateWeather } from "./weather";
import type { Game } from "./types";

/**
 * The notes that move the call, in plain words: a quarterback change or a questionable starter, absences that are news
 * (he played the last game, or his status is uncertain; a player out for weeks is already in the numbers), a weather
 * flag, a neutral field.
 */
export function keyNotes(game: Game): string[] {
  const out: string[] = [];
  if (game.status === "final") {
    const post = game.archive?.postgame;
    if (post?.spreadResult) out.push(`Market: ${post.spreadResult}${post.totalResult ? `, total went ${post.totalResult}` : ""}`);
    return out;
  }
  const a = game.availability;
  for (const [team, av] of a ? ([[game.away, a.away], [game.home, a.home]] as const) : []) {
    if (av.qb && (av.qb.uncertain || Math.abs(av.qb.pts) >= 1.5)) out.push(`${team.short}: ${av.qb.expected} at QB${av.qb.uncertain ? ", questionable" : ""} (${av.qb.pts > 0 ? "+" : ""}${av.qb.pts})`);
    const news = av.items.filter((i) => i.kind === "out" && i.pts <= -0.3 && (i.fresh || i.absence < 0.85)).slice(0, 2);
    for (const i of news) out.push(`${team.short}: ${i.name} ${absentWords(i.status)} (${i.pts} pts)`);
  }
  const flag = game.weather ? evaluateWeather(game.weather).find((f) => f.level !== "note") : undefined;
  if (flag) out.push(flag.title);
  const neutral = game.storylines.find((s) => s.startsWith("Neutral site"));
  if (neutral) out.push(neutral.replace(/\.$/, ""));
  return out.slice(0, 4);
}
