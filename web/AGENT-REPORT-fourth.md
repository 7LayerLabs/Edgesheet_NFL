# AGENT-REPORT-fourth: fourth-down decisions (nfl4th, rebuilt in JavaScript)

## What it is

Every fourth down scored three ways: win probability (WP) if they go for it, kick a field goal, or punt. The best option is the model's call; the cost of the call made is the best WP minus the WP of what they did, in percentage points. Under 1.5 points between the top two options is a toss-up.

## Files (all new; no existing file edited)

- `src/lib/fourth-core.mjs` + `fourth-core.d.mts`: the pure math, shared by the scripts and the app (same pattern as odds-core and dst-core). WP model features, `wp()`, `options()`, `stateOf()` (a play-by-play row to a game state), `callOf()`.
- `scripts/fourth-fit.mjs`: fits the model from nflverse play-by-play 2018 to 2025 (regular season) and writes `data/generated/fourth-model.json` (6 KB). Downloads missing `play_by_play_<year>.csv.gz` to data/cache (2018 to 2022 were added today; 2023 to 2025 came from the coverage helper). Streams one season at a time; about 25 seconds.
- `scripts/backtest-fourth.mjs`: consistency checks, writes `data/backtest/fourth.json` (6 KB). About 25 seconds.
- `src/lib/fourth.ts`: `fourthDownsFor(espnGameId)`, `teamFourthSummary(team, season)`, `fourthMethodNote()`, `fourthModel()`. Reads `data/cache/play_by_play_<season>.csv` once per file change (memoized on mtime), keeps only fourth downs; about 0.6 s the first time for the 2026 file.
- `src/components/FourthDowns.tsx`: server component `<FourthDowns gameId={game.id} />`. Each team's fourth downs: the situation in words, the call and its result, the model's call, WP for each option with the conversion and make chances, a tag (cost 3+ points in red, a clear right call in green, toss-up, model agrees, small cost in yellow), and a method line. Renders nothing before nflverse posts the game's play-by-play.

## How the model works

1. **Win probability.** A logistic model per time segment (first half, third quarter, fourth quarter to 6:00, 6:00 to 2:00, last 2:00), 28 coefficients each, distilled from nflfastR's own `vegas_wp` (the published WP that already knows the pregame spread). Inputs: score, score by time left, one-score and two-score flags, lead or deficit buckets crossed with field position, time and timeouts, the spread fading with time, field position, down and distance, home, timeouts.
2. **Going for it.** Conversion chance by yards to go (logistic on log yards, goal-to-go, 4th and 1) from 5,628 fourth-down runs and passes; the average gain on a conversion by yards to go from third and fourth down conversions (about 22,800).
3. **Field goals.** Make chance by distance (logistic on distance and distance squared), 8,141 kicks; scored from 63 yards in.
4. **Punts.** The other team's average start by 5-yard band of the punt spot, 16,600 punts; scored from your own side of the opponent's 30 (yardline 30 or further back).
5. Assumptions (in the file header and the page note): after a score the other team starts at its own 30; a go play uses 6 seconds, a kick 5, a punt 8; overtime not modeled; penalties, kneels, and garbage time (every option under 2% or over 98%) left out.

## How good it is

- **WP against nflfastR, held out:** fit on 2018 to 2024, scored on 2025 (38,112 plays): off by 2.0 points of WP on average. By segment: first half 2.6, third quarter 1.5, fourth quarter to 6:00 1.0, 6:00 to 2:00 1.3, last 2:00 2.8.
- **WP calibration on 2025 (model vs how often the team actually won):** 0-10% bucket 3.6% vs 5.4%; 20-30% 24.9% vs 28.0%; 40-50% 44.9% vs 45.8%; 50-60% 55.0% vs 54.1%; 70-80% 74.9% vs 71.7%; 90-100% 96.1% vs 95.7%. Same shape as nflfastR's own numbers on that season.
- **Conversion chance, held out 2025:** 4th and 1 predicted 68% vs 66% actual (349 tries); 4th and 3 52% vs 52% (98); 4th and 4-5 44% vs 58% (118, the widest miss); 8-10 yards 31% vs 25% (64).
- **Field goals, held out 2025:** 30-39 yards 93% vs 93% (298); 45-49 76% vs 83% (150, kickers were better in 2025); 50-54 67% vs 72% (150).
- **Sanity spots:** 4th and 1 at the opponent 40, tied in the 2nd: go by 3.7 points. 4th and 10 at your 25 in the 1st: punt by 3.0. 4th and goal at the 2 down 4 with 0:30: go by 32 points. Trailing by 3 at your own 23 with 1:45 and 2 timeouts: 27% WP. Favored by 7 at kickoff: 77%.

## Backtest verdicts (data/backtest/fourth.json)

- **The league trend shows up:** teams went for it on 62% of fourth downs the model called a clear go (3+ points) in 2018 and 77% in 2025 (65 to 72% in between). When the model said kick or punt by 3+, teams went anyway 0.2 to 1.6% of the time. Overall agreement with the model: 90 to 92% a season.
- **Costly calls and losing go together:** teams that gave up more fourth-down WP than their opponent won less than the pregame line expected. 1 to 3 points more: 35% of 720 games vs 44% expected. 3 to 6: 36% of 430 vs 46%. 6+: 32% of 227 vs 43%. Labeled as association, not proof: a team that falls behind also faces more hard fourth downs.
- **This test is in sample.** The WP part was fit on these same seasons; the out-of-sample checks are the 2025 holdout numbers above.

## Known gaps

- The WP model is a distillation, about 2 points off nflfastR on average and nearly 3 in the last two minutes and the first half (no "who gets the second-half kickoff" input). Close calls under about 3 points should be read loosely; that is why toss-ups are flagged under 1.5.
- The go branch uses the average gain on a conversion (not a distribution), and a failed try gives the ball back at the line of scrimmage.
- Kickoff start after a score is fixed at the 30 (the 2024 and 2025 kickoff rules move it around a little).
- No weather, kicker, or matchup inputs (the page says so). No overtime.
- Neutral-site games are treated as home for the home team.
- `play_by_play_2026.csv` must be refreshed by the main ingest for new weeks to appear.

## To wire in

1. Game page: `import { FourthDowns } from "@/components/FourthDowns";` and inside a fold shown once a game has started (Live / Box score area, or its own "Fourth downs" fold): `<FourthDowns gameId={game.id} />`. A fold summary can use `fourthDownsFor(game.id)` from `@/lib/fourth` (for example "3 costly calls" or "12 fourth downs, model agreed on 11").
2. package.json scripts:
   - `"fourth:fit": "node scripts/fourth-fit.mjs",`
   - `"backtest:fourth": "node scripts/backtest-fourth.mjs",`
3. `data/generated/` is gitignored, so `fourth-model.json` is not committed: run `npm run fourth:fit` after a fresh clone (or add it to the ingest chain, about 25 seconds; it only needs refitting once a season). Without it the component renders nothing.

## Ideas

- A season "Fourth-down report card" on the standings page or each team: decisions, how often they agreed with the model, total WP given up, worst call (`teamFourthSummary` already returns it).
- A live "go or kick?" line on the live panel when a team faces fourth down (the state is in ESPN's live feed; the model scores it in microseconds).
- Grade coaches over seasons with the 2018 to 2025 files (the backtest already computes per-game costs).
