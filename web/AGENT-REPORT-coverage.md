# AGENT-REPORT-coverage: coverage tendencies and receiver-vs-coverage splits, 2026-10-06

## What it is

nflverse `pbp_participation` (FTN charting: man or zone, the coverage shell, pass rushers, pressure, offensive personnel on every play) joined to nflverse play-by-play (who was targeted, yards, touchdowns, EPA) on game id and play id, regular season. nflverse posts participation after a season ends, so during 2026 this is the **2025 season**, labeled that way everywhere.

## Files (all new)

- `scripts/lib/csv-stream.mjs`: streaming CSV reader (chunks, inflates `.gz`, copies only the columns asked for). Keeps a 100 MB play-by-play season in a small memory budget.
- `scripts/lib/coverage-agg.mjs`: one season's aggregation (teams on defense and offense, receivers), cached in `data/cache/coverage_agg_<season>.json` keyed on source file size and time plus a version.
- `scripts/ingest-coverage.mjs`: downloads what is missing (participation CSV about 50 MB, play-by-play `.csv.gz` about 19 MB), picks the latest season with charting, writes `data/generated/coverage.json` (159 KB: 32 teams, 330 receivers with 10+ targets).
- `scripts/backtest-coverage.mjs`: season-to-season carry-over tests, writes `data/backtest/coverage.json`.
- `src/lib/coverage.ts`: server-only reader. `coverageFile()`, `teamCoverage(nickname)`, `receiverVsCoverage(espnId)`, `coverageMatchup(offense, defense)` (sentences plus the offense's top 3 targets on today's roster), `coverageNote()` (the carry-over verdict, built from the backtest file).
- `src/components/CoveragePanel.tsx`: server component, props `{ away, home }` nicknames. Two cards (each defense against the other offense): two-deep rate, man rate, 5+ rushers, pressure, each with its rank, top shells, and the offense's top 3 targets' man/zone yards per target with counts. "Coverage, 2025 season" header and the verdict line. Renders nothing without the data file.

Nothing existing was edited.

## Data

- Coverage charting exists for 2023, 2024, 2025 (about 21,000 to 22,000 charted regular-season pass plays each; 2016-2022 files carry no man/zone). Downloaded to `data/cache`: participation 2023-2025 (about 50 MB each), play-by-play 2023-2025 `.csv.gz` (about 19 MB each).
- The man/zone label is a fixed function of the shell (Cover 0, Cover 1, 2-man are man; the rest zone). The shells themselves drift: Cover 1 was 37% of charted plays in 2024 and 23% in 2025 while Cover 3 went 17% to 27%, so the league man rate reads 42% (2023), 49% (2024), 32% (2025). One-deep against two-deep safeties is steady (38%, 37%, 43%).

## Carry-over results (2023-2024 and 2024-2025 pairs)

| Test | Pairs | r | 95% interval | Verdict |
| --- | --- | --- | --- | --- |
| Defense two-deep-safety rate | 64 | 0.49 | 0.28 to 0.66 | carries over |
| Receiver man-minus-zone yards per target (20+ targets each side, both seasons) | 153 | 0.19 | 0.03 to 0.33 | carries over, weakly |
| Receiver man-minus-zone EPA per target | 153 | 0.08 | -0.08 to 0.23 | does not |
| Receiver two-deep-minus-one-deep yards per target | 150 | -0.09 | -0.25 to 0.07 | does not |
| Defense man rate | 64 | 0.01 | -0.24 to 0.26 | does not |
| Defense EPA allowed against man | 64 | 0.07 | -0.18 to 0.31 | does not |
| Defense man-minus-zone EPA allowed | 64 | -0.33 | -0.53 to -0.09 | reverses (regresses) |
| Offense man-minus-zone EPA | 64 | -0.14 | -0.37 to 0.11 | does not |

So the panel leads with the two-deep rate, shows receiver man/zone yards splits as a weak signal, and calls man rates and EPA splits last season's context.

## How to verify

```
node scripts/ingest-coverage.mjs        # about 5 s with the cache filled; prints teams, receivers, file size
node scripts/backtest-coverage.mjs      # prints the table above
```
Spot check (2025): Cowboys two-deep 44% (No. 14), man 26% (No. 24); CeeDee Lamb 7.1 yards a target against zone (67 targets), 12.0 against man (50). `npx tsc --noEmit` shows no errors in these files.

## To wire in

1. Game page, inside the Matchups fold: `import { CoveragePanel } from "@/components/CoveragePanel";` then `<CoveragePanel away={game.away.short} home={game.home.short} />`.
2. package.json scripts:
   ```
   "coverage": "node scripts/ingest-coverage.mjs",
   "backtest:coverage": "node scripts/backtest-coverage.mjs",
   ```
3. Optional: run `node scripts/ingest-coverage.mjs` from the main ingest (or prebuild) so a fresh clone gets `data/generated/coverage.json`; otherwise the panel just hides. It only needs re-running once a year (after nflverse posts the finished season) or when players.json changes teams a lot (the panel reads today's team from players.json at request time either way).

## Known gaps

- Last season only, by nature of the source; trades and coordinator changes are not reflected in the defense numbers.
- Targets are joined by game and play id; plays missing from participation (rare) count toward overall targets but not man or zone.
- Receivers are matched to the app by gsis id through players.json; a player no longer on any roster keeps his gsis or ESPN id from the 2025 roster file and simply never shows (the panel lists today's roster).
- Nothing here feeds a projection or a lean. None of the coverage reads were tested as a predictor of next-game points, only for season-to-season stability.

## Ideas

- The two-deep rate carries over: a "Shell matchup" line (an offense's EPA against two-deep looks next to the defense's two-deep rate) would be the honest version of the man/zone idea, once an in-season source exists.
- FTN's 2026 weekly charting (`ftn_charting_2026.csv`, already in the main ingest) has no coverage shell, but it does have blitz and play action; the in-season pressure and blitz picture can come from there.
- Route data (`route` in participation, about 42% of plays) could give each receiver's route tree from last season.
