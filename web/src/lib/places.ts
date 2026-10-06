/**
 * Where a game was played, by the schedule row's stadium id: city, state (US postal code, or the country abroad), and
 * whether it was in the US. For the storyline history and backtests (hometown, home state, college state).
 *
 * Each stadium id maps to the team that plays home games there in the latest season it appears (data/nfl-teams.json
 * holds each team's stadium city), so the 49ers' 2020 home games in Glendale land in Arizona. Three 2019-only stadiums
 * are listed by hand. International games are recognized by the stadium name (nfl-teams.json neutralVenues), which wins
 * over the id: nflverse files a few London games under the home team's stadium id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { genSchedule, scheduleStamp, type GenGame } from "./generated";
import { memoSync } from "./memo";
import { teamByShort } from "./nfl";

export interface Place {
  city: string;
  state: string; // US postal code, or the country abroad
  us: boolean;
}

/** Stadiums used only before the teams moved (2019): the Raiders in Oakland, the Chargers in Carson, the Rams at the Coliseum. */
const HISTORIC: Record<string, Place> = {
  OAK00: { city: "Oakland", state: "CA", us: true },
  LAX97: { city: "Carson", state: "CA", us: true },
  LAX99: { city: "Los Angeles", state: "CA", us: true },
};

interface Neutral {
  match: string;
  city: string;
  state: string;
}
const neutrals = (): Neutral[] =>
  memoSync("places:neutral", 86400, () => (JSON.parse(readFileSync(path.join(process.cwd(), "data", "nfl-teams.json"), "utf8")) as { neutralVenues: Neutral[] }).neutralVenues);

const US_STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

/** Stadium id -> the home team in the latest season the id hosts a non-neutral game. */
function stadiumTeams(): Map<string, string> {
  return memoSync(`places:stadiums:${scheduleStamp()}`, 3600, () => {
    const m = new Map<string, { season: number; team: string }>();
    for (const g of genSchedule()) {
      if (!g.stadiumId || g.neutral) continue;
      const cur = m.get(g.stadiumId);
      if (!cur || g.season >= cur.season) m.set(g.stadiumId, { season: g.season, team: g.home });
    }
    return new Map([...m].map(([id, x]) => [id, x.team]));
  });
}

/** Where a scheduled game was played, or undefined when the stadium is unknown. */
export function placeOf(g: Pick<GenGame, "stadium" | "stadiumId">): Place | undefined {
  const name = (g.stadium ?? "").toLowerCase();
  const abroad = name ? neutrals().find((v) => name.includes(v.match.toLowerCase())) : undefined;
  if (abroad) return { city: abroad.city, state: abroad.state, us: US_STATES.has(abroad.state) };
  if (!g.stadiumId) return undefined;
  if (HISTORIC[g.stadiumId]) return HISTORIC[g.stadiumId];
  const team = stadiumTeams().get(g.stadiumId);
  const s = team ? teamByShort(team)?.stadium : undefined;
  return s ? { city: s.city, state: s.state, us: US_STATES.has(s.state) } : undefined;
}
