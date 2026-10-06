export type Division = "NFL";
export type Coverage = "Full" | "Standard" | "Limited";
export type GameStatus = "upcoming" | "live" | "final";
/** Watch radar lenses. Rookie = first-year player ranked against his draft slot. Breakout = year 2 or 3 player whose usage or efficiency jumped.
 *  Matchup = the player a unit edge puts on the spot in this game. Watch = a starter worth knowing. */
export type ProspectTier = "Rookie" | "Breakout" | "Matchup" | "Watch";

export interface Team {
  id: string;
  name: string;
  short: string;
  abbr: string;
  record: string;
  conference: string;
  color: string;
  logo?: string;
  /** Poll rank (unused in the NFL; kept so shared components compile). */
  rank?: number;
  rankPoll?: string;
  /** nflverse code (LA, WAS); abbr is the ESPN abbreviation (LAR, WSH). */
  code?: string;
  div?: string;
  /** Division standing line, "2nd AFC West" with the record. */
  standing?: string;
  seed?: number;
}

export interface WeatherInput {
  windMph: number;
  gustMph: number;
  windDir: string;
  crosswind: boolean;
  /** Field axis bearing 0..180 from OpenStreetMap (stadiums.json), when known. */
  fieldBearing?: number;
  fieldBearingConfidence?: "high" | "medium" | "low";
  /** Wind against the field axis. Undefined when the bearing or wind direction is unknown. */
  windComponent?: "crosswind" | "down the field" | "quartering";
  precipChance: number;
  precipWindow?: string;
  tempF: number;
  feelsLikeF: number;
  humidity: number;
  stormRisk: "none" | "watch" | "warning";
  roof: "open" | "fixed" | "retractable-unknown" | "retractable-closed";
  surface: "grass" | "turf";
  elevationFt: number;
  asOf: string;
}

export interface Market {
  spread?: { team: string; line: number; open: number };
  total?: { line: number; open: number };
  moneyline?: { home: number; away: number };
  books?: number;
  asOf: string;
}

export interface Prospect {
  id: string;
  name: string;
  team: string;
  jersey: number;
  pos: string;
  cls: string;
  ht: string;
  wt: number;
  draftYear: number;
  eligibilityConfidence: "High" | "Medium" | "Low";
  tier: ProspectTier;
  projected: string;
  sourceCount: number;
  projectionConfidence: "High" | "Medium" | "Low";
  traits: string[];
  weakness?: string;
  watchFor: string;
  stat?: string;
  /** Present when the entry comes from the scouting radar. */
  radar?: import("./radar").RadarPlayer;
  /** This game's box-score lines for the player, when the game has started. */
  lines?: { category: string; headline: string }[];
  /** Official injury report status for the week (nflverse injuries file). */
  injury?: { status: string | null; practice: string | null; injury: string | null; week: number };
  /** Why this player is on the game's radar, one line ("WR1 against the No. 31 pass defense by EPA"). */
  lensNote?: string;
  /** nflverse headshot URL, the fallback when the ESPN id is missing. */
  headshot?: string;
}

export interface Matchup {
  a: string;
  b: string;
  why: string;
  evidence: string;
  /** Unit matchups from tendencies carry which side has the edge. */
  edge?: "offense" | "defense" | "even";
  strength?: "dominant" | "clear" | "real" | "slight" | "even";
  watch?: string;
}

export interface BoxLeader {
  id: string;
  name: string;
  category: string;
  headline: string;
}

export interface BoxSummary {
  teams: { team: string; abbr: string; points: number | null; leaders: BoxLeader[] }[];
  /** "nflverse" is the settled weekly stats file; "espn" is the in-game box used until nflverse publishes. */
  source?: "nflverse" | "espn";
}

export interface StyleMetric {
  key: string;
  label: string;
  value: string;
  rank?: number;
  of?: number;
  pct?: number;
}

export interface OffenseProfile {
  label: string;
  sample: "full" | "small" | "unavailable";
  /** Live: ranked metrics from advanced season stats. */
  summary?: string;
  metrics?: StyleMetric[];
  /** Sample-data fields (hand-written prototype). */
  passRate?: number;
  neutralPassRate?: number;
  secondsPerPlay?: number;
  structure?: string;
  runGame?: string;
  passGame?: string;
  successRate?: number;
  explosiveRate?: number;
  pressureAllowed?: number;
}

export interface DefenseProfile {
  label: string;
  sample: "full" | "small" | "unavailable";
  summary?: string;
  metrics?: StyleMetric[];
  front?: string;
  coverage?: string;
  blitzRate?: number;
  pressureRate?: number;
  stuffRate?: number;
  explosivesAllowed?: number;
}

/** Each component is 0 to 100. null means the input is not available yet;
 *  the score renormalizes over the components it can actually see. */
export interface ScoreComponents {
  competitive: number | null;
  directMatchups: number | null;
  watchDensity: number | null;
  stakes: number | null;
  availability: number | null;
}

export interface Game {
  id: string;
  division: Division;
  home: Team;
  away: Team;
  kickoff: string;
  venue: string;
  city: string;
  network: string;
  status: GameStatus;
  score?: { home: number; away: number; clock: string };
  /** ESPN live overlay (Division I only): clock, situation, win probability. Present once the game has kicked off. */
  live?: {
    period: number;
    clock: string;
    possession?: string;
    down?: number;
    distance?: number;
    yardLine?: number;
    downDistance?: string;
    lastPlay?: string;
    homeWinProb?: number;
    awayWinProb?: number;
    swing?: number;
    swingMinutes?: number;
    closeness?: number;
    broadcast?: string;
    asOf: string;
  };
  /** ESPN drives, scoring plays, win probability series, box players (game page only). */
  liveDetail?: import("./espn").LiveSummary;
  coverage: Coverage;
  whyWatch: string;
  whyWatchReasons: string[];
  /** The game page's "why watch": only what its answer strip and Who to watch do not already say (stakes, a line move, weather). */
  whyWatchRead?: string[];
  styleLine?: string;
  weather?: WeatherInput;
  market: Market;
  prospects: Prospect[];
  matchups: Matchup[];
  keepAnEyeOn: { name: string; team: string; note: string }[];
  storylines: string[];
  offense: Record<string, OffenseProfile>;
  defense: Record<string, DefenseProfile>;
  pressurePoint: string;
  scoreComponents: ScoreComponents;
  gaps?: string[];
  /** Box score leaders once the game has started (game page only). */
  box?: BoxSummary;
  /** Stats-as-of for radar and tendencies (ingest time). */
  statsAsOf?: string;
  /** Predicted outcome from Elo, unit edges, and the market. */
  projection?: import("./projection").Projection;
  /** Outside projection systems (SP+, FPI, SRS, Elo, CFBD pregame) next to our model. Division I only. */
  consensus?: import("./consensus").Consensus;
  /** Accountability archive entry, when one exists. */
  archive?: import("./archive").ArchiveEntry;
  /** Play-by-play situational splits and game cues (FBS and FCS, once scripts/ingest-plays.mjs has run). */
  situations?: { home: import("./situational").TeamSituations; away: import("./situational").TeamSituations; cues: import("./situational").SituationCue[] };
  /** Five-year weather baseline for this venue, week, and kickoff hour (climate.json). Division I only. */
  climate?: import("./climate").ClimateBaseline;
  excitement?: number | null;
  /** Line movement, closing line, and props from The Odds API (game page only). */
  odds?: import("./odds").GameOdds;
  reportAsOf: string;
  /** "live" = nflverse plus ESPN, "sample" = hand-written prototype data */
  source: "live" | "sample";
  week?: number;
  weekLabel?: string;
  divGame?: boolean;
  /** Days since each team's last game (nflverse away_rest/home_rest). */
  rest?: { home: number | null; away: number | null };
  /** Official injury report for both teams, Out/Doubtful/Questionable only, latest week. */
  injuryReport?: { team: string; id: string; name: string; pos: string; status: string; practice: string | null; injury: string | null; week: number }[];
  /**
   * The read's three names (game page only): the player the biggest matchup runs through, the other team's top skill
   * player, and the best storyline (revenge game, homecoming, college ties), else a role change, else the next top player.
   */
  whoToWatch?: { id: string; name: string; pos: string; team: string; label?: string; reason: string; detail?: string }[];
  /** Storylines (revenge, homecoming, college ties) for players outside QB, RB, WR: a footnote under Who to watch, not a slot. */
  storyNotes?: { id: string; name: string; pos: string; team: string; label: string; text: string }[];
  /** Who is actually playing, priced in points (src/lib/availability.ts): ESPN injuries, the official report, roster moves. */
  availability?: import("./availability").GameAvailability;
  /** Standings context: "Winner takes first in the AFC North" and the like. */
  stakes?: string[];
}
