# AGENT-REPORT-seed: NFL tiebreakers and playoff odds (2026-10-06)

The idea of nflverse's nflseedR (R), rebuilt in TypeScript: real standings with the NFL's tiebreaking procedures, and playoff odds from our Elo playing out the rest of the season.

## What was built

- `src/lib/seed.ts`
  - `standingsFrom(season, teams, games)` (pure) and `standingsWithTiebreaks(season, games?, finals?)` (reads the schedule, folds in ESPN finals, memoized 5 min per schedule stamp). Per team: W-L-T, pct, PF/PA, division and conference records, division rank, conference seed 1 to 16, in-playoffs flag, and plain-words notes: `divNote` ("Won the NFC South on head-to-head over the Falcons."), `seedNote` ("Took the No. 7 seed on strength of victory over the Saints and Seahawks."), `note` (both).
  - Division ties: head-to-head (record among all tied clubs when 3+), division record, common games, conference record, strength of victory, strength of schedule, points scored and allowed ranking in the conference, then in the league, net points in common games, net points. Wild card ties and seeding division winners: all but the top club per division drop out first; head-to-head if they met (a sweep, either way, when 3+), conference record, common games (minimum four), SOV, SOS, the two points rankings, net points in conference games, net points. Any step that separates some clubs restarts the rest at step one of the two-club or three-club list; after a club wins a place the others restart. Ties count half a win. Division winners seed 1 to 4, then 3 wild cards (2 in 2019).
  - The league's last two steps (net touchdowns, then a coin toss) are not in our data. A tie that survives net points goes to a fixed stand-in (a hash of season and team), and the note says so in words.
  - `simulateSeason(season, { runs = 10000, seed = 7, finals })`: replays every finished game since 2019 with the same Elo as `scripts/lib/elo.mjs` (start 1500, a third regressed each season, K 20, 48 home field, the margin multiplier, ties half), then plays the remaining regular-season games `runs` times. Each winner is drawn from the Elo win chance; each score is a real decisive final drawn from past regular seasons (so the points tiebreak steps and the Elo margin multiplier see real margins); ratings update after every simulated game. Simulated ties are not drawn. Seeded RNG (mulberry32), memoized 1 hour per schedule stamp and finals. Returns per team: playoff %, division %, bye % (1 seed; 1 and 2 in 2019), average seed, Elo now. In-season runs resolve tiebreaks fully through seed 7; seeds 8 to 16 inside a run are ordered by record then the stand-in, so the average seed is approximate below 7.
- `scripts/backtest-seed.mts`: rebuilds 2019 to 2025 from regular-season finals and checks against the bracket (the schedule has no seed column): the field (wild card teams plus bye teams), the byes (1 seed; 1 and 2 in 2019), every wild card pair adds to 9 with the lower seed at home, and in the divisional round the 1 seed hosts the lowest seed left. Writes `data/backtest/seed.json` with the per-season counts, mismatches, and the tiebreak notes that decided playoff places.
- `src/app/standings/page.tsx`: division order and seeds from `standingsWithTiebreaks`; streak still from `nfl.ts standings()`; new columns Playoffs, Div win, Bye (the last two hidden on phones, PF-PA moved to large screens); a "Tiebreak:" line under a team for every division-place tie and for seed ties through the first team out (seed 8 with 7 playoff teams), so early-season rows are not buried in notes; method lines for both. Odds read "over 99%" and "under 1%" at the ends (10,000 runs never prove a clinch) and "Yes"/"No" once no games remain.

## Validation

`npx tsx scripts/backtest-seed.mts`

| Season | Field | Seeds |
| --- | --- | --- |
| 2019 | 12/12 | 12/12 |
| 2020 | 14/14 | 14/14 |
| 2021 | 14/14 | 14/14 |
| 2022 | 14/14 | 14/14 |
| 2023 | 14/14 | 14/14 |
| 2024 | 14/14 | 14/14 |
| 2025 | 14/14 | 14/14 |
| All | 96/96 | 96/96 |

Ties actually exercised along the way: head-to-head (2019 KC over NE for No. 2), a head-to-head sweep (2019 SF No. 1 over NO and GB), conference record (2021 GB No. 1 over TB), common games (2020 CHI No. 7 over ARI; 2023 TB won the NFC South), strength of victory (2023 GB No. 7 over NO and SEA; 2024 LAR won the NFC West), a three-way division tie (2025 CAR over ATL and TB), division drop-out before a wild card tie (2020 BAL No. 5, 2025 LAR No. 5). The 2022 BUF-CIN no-contest is handled by win percentage.

Simulation check, 2026 through week 4 (64 played, 208 left): 10,000 runs in about 3 s on this PC; across teams the playoff shares sum to 14.00, division to 8.00, byes to 2.00.

## How to verify

1. `npx tsx scripts/backtest-seed.mts` (or the npm script below): 96/96.
2. After the orchestrator builds and restarts: open `/standings`. Every division sorted with tiebreak lines; Playoffs, Div win, Bye columns; the method line names the remaining games count.

## npm script to add (package.json, scripts)

```
"backtest:seed": "tsx scripts/backtest-seed.mts",
```

## Known gaps

- Net touchdowns and the coin toss: not in the schedule file; a fixed stand-in decides and says so. Nothing in 2019 to 2025 reached it.
- Mid-season tiebreaks use games played so far (strength of schedule on four games is thin); that is how the standings read today, not a projection.
- The simulation is Elo only: no injuries, no QB adjustment, no unit edges (the availability model could shift a team's rating per game later). Ties are never simulated.
- Average seed below 7 inside a simulation is ordered by record, not the full chain.
- Clinch and elimination are not computed exactly (that needs a search over remaining outcomes); the page says "over 99%" rather than "clinched".

## Ideas worth Derek's time

- Playoff odds swing on the game page: run the simulation with the game forced each way (home wins, away wins) and show "a win puts the Bears at 71% to make the playoffs, a loss 44%". A real stakes number for the Watch Score's stakes term and for Storylines, where it now says only "division game".
- Draft order: the same ordering run in reverse for non-playoff teams (with strength of schedule first) gives the projected draft order, useful for the rookie and draft pages.
- Tiebreak scenarios late in the season: list, for each bubble team, which result next week changes its seed.
