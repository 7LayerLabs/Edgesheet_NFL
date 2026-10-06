/**
 * Plain definitions for the analytics and usage terms the site shows, for the "i" tips (src/components/InfoTip.tsx).
 * Client-safe: no server imports. Definitions only; where "good" is measured, the page computes it (stat-glossary.ts)
 * or shows the rank next to the number.
 */
export const TERMS = {
  // Team style (game page), by metric key. Ranks are among the 32 teams; No. 1 is the best at it for that side.
  passRate: "Share of plays that were passes (dropbacks, sacks and scrambles included). A style, not a quality: not ranked.",
  earlyPass: "Pass rate on first and second down, where the call is most a choice. A style, not a quality: not ranked.",
  sr: "Success rate: share of plays that added expected points (EPA above zero, nflverse's definition). On defense, the share it allowed.",
  ex: "Explosiveness: how much a successful play is worth on average, in expected points. Big gains push it up.",
  rushSr: "Success rate on runs only (see success rate).",
  passEx: "Explosiveness on passes only: the average expected points of a successful pass.",
  ly: "Run game EPA: expected points added per carry, from nflverse play-by-play.",
  pdSr: "Passing-downs success: success rate on second and 8+, and third or fourth and 5+ (the long-yardage downs where the defense knows a pass is coming).",
  pressure: "Pressure rate: share of dropbacks with a sack or a quarterback hit. On offense lower is better (pressure allowed); on defense higher is better.",
  blitz: "Blitz rate: share of charted dropbacks with five or more pass rushers or a blitzer sent (FTN charting). A style: not ranked.",
  playAction: "Play-action rate: share of charted dropbacks with a run fake (FTN charting). A style: not ranked.",
  rzTd: "Red zone TD rate: share of trips inside the 20 that ended in a touchdown.",

  // Matchups (game page).
  matchups:
    "Success rate is the share of plays that added expected points (EPA above zero). EPA, expected points added, is how much a play changed the offense's expected points given down, distance, and field position. Passing downs are second and 8+ and third or fourth and 5+. The gap is how far apart the two units sit in percentile points among the 32 teams.",

  // Matchups: DraftKings points allowed.
  dvp: "DraftKings points that quarterbacks, backs, receivers, and tight ends scored against this defense, per game, this season and over its last four games. No. 1 allowed the most, so a low number is a soft matchup for that position. Our projection uses a quarter of this (backtests showed more weight hurt).",

  // Answer strip.
  model:
    "The margin starts from team Elo ratings (home field included), then adds 40% of the unit matchup edges and the injury points under Who's playing. The total comes from each offense's EPA per play against the other defense and both teams' pace, with a weather tilt when the forecast is flagged. Win chance treats the margin as the middle of a 13.5-point spread of outcomes.",
  edge: "The gap is how far the model's margin or total sits from the betting line, in points. A side gap of 2 or more counts as a gap and 4 or more as a big gap; for totals, 2.5 and 5. It names where the model disagrees with the market, not a pick.",

  // Trends (game page) and Week by week (player page).
  trendMetrics:
    "Snaps: his share of the offense's snaps that game. Targets: passes thrown his way, and his share of the team's targets. Carries: runs, and his share of the team's carries. Air yards: his share of how far the team's passes traveled past the line of scrimmage, caught or not (a high share means the downfield looks). DK points: DraftKings Classic scoring. A week is marked when his snap share moves 15 points, or his target or carry share 8 points, against his earlier games this season; the reason under it comes from the data (a teammate out or back, he left early, a blowout, and so on).",
  playCalling:
    "Pass rate: share of the team's plays that were passes. Against expected: how far that ran above or below what the down, distance, field position, score, and clock usually call for (nflverse's expected pass model). +5 or more reads pass-heavy, -5 or less run-heavy.",

  // Player page meters.
  production: "Production: a weighted score of his season numbers for the position (for a receiver: yards and catches per game, touchdowns, EPA, target share), as a percentile among NFL players at his position. 100 = the most productive. A minimum volume applies.",
  snapShare: "Snap share: his share of his unit's snaps (offense or defense) in the games he played, as a 0 to 100 score.",
  draftSlot: "Draft slot score: where he was picked on a 0 to 100 scale (pick 1 = 100, pick 32 = 75, pick 100 = 55, undrafted = 8).",
  size: "Size: whether his height and weight meet rough NFL norms for the position.",
  vsSlot: "His production percentile minus his draft slot score (pick 1 = 100, pick 32 = 75, pick 100 = 55, undrafted = 8). Plus means his production ranks higher than where he was drafted; +10 or more reads as above his slot, -10 or less below it.",
  watchScore: "Watch Score (0 to 100): half his production percentile, 30% his snap share percentile, 20% context (a breakout, production against his draft slot, or the starter's spot on the depth chart). How worth watching he is, not a grade of the player.",

  // Who's playing (game page).
  vacated:
    "Work left open: the share of the team's carries, targets, air yards, and snaps he had in his games this season. Without him: the games the team played without him (this season after his first game, last season between his first and last game for the team) and the teammates whose targets rose in them (carries plus targets when a back sits), against the games they played together. Two or three games is a hint, not a pattern.",

  // Game page read.
  whoToWatch:
    "Key matchup: the player the biggest unit edge runs through. Top player: the other team's best skill player by DraftKings points a game. Then up to three storylines (revenge game, birth city or state, college state) or role changes (a starter out and who took his work the last times he sat).",

  // Splits (player page and the game page's Splits section).
  splits:
    "Since 2019, regular season. Each situation's average against every other game, with the games count: at home against on the road, division games against the rest, primetime (kickoff 7 PM ET or later), and a short week (4 or fewer days of rest). For players, DraftKings points against his own average in his other games that season; for teams, points against the closing implied team total; for defenses, DraftKings points a game. The note under it says whether such splits carried over in our 2019-2025 test.",

  // Player page history.
  vsOpponent:
    "Every game he played against this week's opponent since 2019, with his DraftKings points and the difference from his own average in his other games that season (so a big season does not make every game look good).",
  storyGames:
    "Every game since 2019 with a storyline: against a team he played for in the four seasons before (or the team that drafted him), and road games in his birth city, his college's state, or his birth state. Each shows DraftKings points against his own average in his other games that season.",

  // DraftKings value (DFS page and the game's DraftKings panel).
  ourPrice:
    "Our price: rank every player at his position on the slate by our simulated median, and he gets the DraftKings salary at the same rank (the best median gets the highest salary, and so on). It uses DraftKings' own price scale, so the gap only says DK ranks him differently than we do. Gap: ours minus DK's; plus means cheap by our numbers.",
  valuePicks:
    "Safest values: $300 or more cheap by our price, 75% or better to play, sorted by the lowest bust chance (under 2x salary per $1,000): cash games. Upside values: the same, sorted by the highest boom chance (5x): tournaments. Not locks: every player busts in some simulations. Picks are saved before kickoff and graded after the games against every player at the same position within $500 of the salary.",

  // Beat feed.
  sleepers:
    "Backs, receivers, tight ends, and quarterbacks with 2 or more posts or headlines about them in the last 3 days who play under 60% of the offense's snaps, or who took on the most work the last times a missing teammate sat. Jev reads their posts: 'moving up' means the beat reports a promotion, a starting job, or a bigger role; players whose buzz is mostly injury news are left out. Buzz is a lead to check, not a projection.",

  // DraftKings (game page panel and the DFS page).
  dfs: "Proj: our average DraftKings points, blended with last season and the matchup. Floor, median, and ceiling: the 10th, 50th, and 90th percentiles of 10,000 simulations of the slate. Boom: share of simulations at 5x his salary per $1,000 or more; bust: under 2x. Value: points per $1,000 of salary (the DFS page uses the simulated median, the game page's panel the projection).",
} as const;

export type TermKey = keyof typeof TERMS;
