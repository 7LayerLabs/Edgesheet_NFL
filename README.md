# EdgeSheet NFL

Pick any NFL game and know why it is worth watching: who to watch (rookies against their draft slot, year 2 and 3 breakouts, the players a unit edge puts on the spot), how the teams play from play-by-play, what the model projects next to FPI and the market, and whether the call played out.

Built by cloning the college EdgeSheet and swapping the data layer to nflverse. Same look, same sheet, same accountability.

## Run it

```
cd web
cp .env.local.example .env.local      # keys are optional; the data layer needs none
npm install
npm run ingest                         # ~10 s after the first download: schedule, rosters, stats, play-by-play, injuries, draft picks
npm run dev                            # http://localhost:3100
```

`npm run build` runs the ingest first (prebuild). Re-run `REFRESH=1 npm run ingest` on Tuesday mornings once nflverse posts the week.

## Data

| Source | What | Where it lands |
| --- | --- | --- |
| nflverse `schedules/games.csv` | every game since 2019, scores, closing spread and total, rest days, roof, ESPN id | `data/generated/schedule.json` |
| nflverse rosters, weekly player stats (this season and last), snap counts, depth charts, injuries, draft picks | the Watch radar | `players.json`, `gamelogs.json`, `injuries.json`, `draft.json` |
| nflverse play-by-play plus FTN charting | team tendencies (success, EPA, explosiveness, pressure, blitz, play action), situational splits | `teams.json`, `situational.json` |
| our Elo from results | consensus and projection | `elo.json` |
| ESPN public JSON | live scores, box scores, broadcasts, FPI | fetched at request time, cached |
| The Odds API | current lines, movement, closing line value, props on demand | `data/odds/` |
| National Weather Service | kickoff forecasts for US venues | fetched at request time |

Raw CSVs are cached in `data/cache/` (ignored). Only digests go in `data/generated/` (also ignored; the prebuild regenerates them).

## Pages

| Route | What it is |
| --- | --- |
| `/` | The week's slate by day (Thursday, Sunday, Monday, Saturday late season): lines, networks, weather flags, Watch Score, who to watch. |
| `/game/[id]` | The game report: why watch, unit matchups with ranks inside the 32, projection with FPI and Elo consensus, the three radar lenses, injury report, team style, conditions, market, storylines, beat feed, live panel, postgame grades. |
| `/radar` | The Watch radar: Rookies, Breakouts, Watch; by position and team. |
| `/rookies` | The rookie class ranked by production against the draft slot, last year's class in year two, and a link to the college app's incoming forecast board. |
| `/standings` | Division standings from the schedule file. |
| `/history` | The record: every locked call graded after the final. |
| `/backtest` | Elo replayed on 2022 to 2025 against the closing line. |
| `/sheet` | The one-page Sunday sheet (PNG for Telegram). |

See `web/AGENT-REPORT-nfl.md` for what is done, what is not, and how to run it under PM2.
