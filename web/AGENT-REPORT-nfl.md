# AGENT-REPORT-nfl: EdgeSheet NFL build, 2026-10-03

Repo: `C:\Users\derek\OneDrive\Desktop\ASTRA_TESTING\edgesheet-nfl` (cloned from EdgeSheet_NCAAF, origin removed, one local commit). Port 3100.

Base: the GitHub clone was behind the live college tree, so the college working tree's newer uncommitted layer (sheet, render, jev, watchguide, grades, weights, adjusted, summaries, gate, changelog) was copied in read-only before the swap. The college repo was not touched.

## What works (verified against the dev server on 3100 and a production build)

- `npm run ingest` (7 s after the first download): schedule 2019 to now, rosters (this season and last), weekly player stats (both seasons), play-by-play with FTN charting, snap counts, depth charts (latest snapshot), official injuries (latest week per team), draft picks (last five classes). Writes `schedule.json`, `teams.json`, `players.json`, `gamelogs.json`, `situational.json`, `draft.json`, `injuries.json`, `elo.json`, `meta.json` to `data/generated/`. Raw CSVs cached in `data/cache/` (ignored). `REFRESH=1` re-downloads.
- Slate for the current week with real nflverse lines, ESPN broadcasts, NWS weather flags, Watch Score, who to watch. Thursday / Sunday / Monday day strip works (grouped by ET date). Live overlay from ESPN once a game kicks off (same code as college, NFL path).
- Game page: why watch, four unit matchups with ranks inside the 32 (rush success, pass explosiveness, run game EPA, passing-downs success), situational cues from play-by-play, projection (our Elo plus unit edges), consensus table with ESPN FPI, our Elo, the EPA model, and the market, Watch radar by lens (Matchup, Rookie, Breakout, Watch), official injury report section with the week, team style with pressure, blitz, play-action, early-down pass rate, red zone TD rate, conditions, market with Odds API movement, storylines (division stakes, short week, bye, starting QBs, radar players Out), beat feed (r/nfl, team subreddits, Bluesky, Google News), live panel, postgame grades.
- Watch radar (`/radar`): Rookies (119), Breakouts (84), Watch (540) with position and team filters. Rookie class page (`/rookies`): this year ranked by production against the draft slot ("drafted No. 175, producing like pick No. 1"), last year's class in year two, Incoming tab linking to the college forecast board.
- Standings (`/standings`) from the schedule results with seed lines.
- Record (`/history`) locks and grades games unchanged; box scores come from nflverse weekly stats when posted, else ESPN's final box (`src/lib/boxscore.ts`).
- Backtest (`npm run backtest`, `/backtest`): Elo replayed 2022 to 2025 against the nflverse closing line. Elo picks the winner 64.2% (market 67.5%), margin MAE 9.9 (market 9.5), Elo side covers 49.6% overall and 52.8% on 4-point leans (199 games). Calibration buckets line up (56% / 68% / 72% / 83%). Grid fit prefers home 30, 27 per point (MAE 9.93 vs 9.9); live constants unchanged.
- Sunday sheet renders to PNG through headless Chrome (`node scripts/send-sheet.mjs 2026-10-04 --dry` wrote `data/sheets/2026-10-04.png`). The Telegram send works once the bot token and chat id exist.
- Odds matcher dry run matched 27 of 29 listed games (two week-5 games had no book yet). No real snapshot was taken; the credit pool was not spent.
- `npx tsc --noEmit` clean. `npm run build` clean (exit 0, all routes dynamic) on 2026-10-03 at 10:10 PM ET.

## What is not done yet

1. Telegram: no bot yet. Derek creates it (steps below). Until then the bot process waits and the Send buttons report the missing key.
2. Odds API cron not started (PM2 commands below). The slate shows the nflverse schedule line as both open and current until the first snapshot lands; the gap note says so.
3. Watch guides and written reports were not generated (cost); `npm run guides -- --limit 5` and the Write report button work as in college. The watch-guide system prompt was reworded for the NFL; the report system prompt only lightly.
4. Climate baselines and field bearings (college `ingest-climate` / `ingest-stadiums`) were dropped; the Conditions section says "No weather baseline on file". Porting them needs an Open-Meteo pull for the 30 stadiums in `data/nfl-teams.json`.
5. Props: on demand only, untested with NFL market keys (`player_pass_yds` etc. are the same keys on The Odds API, so it should work).
6. The EPA model total and the unit-edge blend are not in the backtest (needs a season of play-by-play per year). The 2026 total leans on the sheet look aggressive (model totals 36 to 54 against posted 41 to 52); `AVG_PPG` 22.8 and the pace term should be checked after a few graded weeks.
7. Snap counts join by normalized name plus team (nflverse has no gsis id in that file). Players with duplicate names on one team would merge.
8. 392 of 1,985 tracked players have no ESPN id in the nflverse roster (mostly rookies and practice squad); their headshot falls back to the nfl.com `headshot_url`, and ESPN box lines will not join to them by id. The in-game box still shows them as ESPN rows.
9. Standings use win pct, division record, point differential only; the NFL tiebreak chain is not applied (the page says so).
10. The `/board` (Derek's grades) page lost the forecast band column; it shows above/below slot instead.
11. Sheet "Forecast" column header still reads FORECAST on the PNG (shows tier). Cosmetic, in `src/app/sheet/page.tsx`.

## Exact next steps for tomorrow's agent

1. `cd web && npm install && npm run ingest` (fast; CSVs are cached). Check `data/generated/meta.json` says week 4 or 5.
2. Start PM2 (below), then open `http://localhost:3100/?date=2026-10-04` and a game page during the Sunday window to confirm the ESPN live overlay and the postgame grading (`/history`). After nflverse posts week 4 stats (Mon/Tue), run `REFRESH=1 npm run ingest` and confirm the box source flips to nflverse.
3. Create the Telegram bot, fill `.env.local`, restart `nfl-telegram`, run `npm run sheet:send` on Sunday morning (or let the bot's 8 AM slate go first).
4. Generate guides for Sunday: `npm run guides -- --date 2026-10-04 --limit 6`.
5. Review total leans after week 4 grades; tune `AVG_PPG` in `src/lib/projection.ts` and `consensus.ts` if the model total runs hot.
6. Port climate baselines (Open-Meteo archive per stadium in `data/nfl-teams.json`) into `data/generated/climate.json` with the existing `src/lib/climate.ts` shape.
7. Fix the sheet column header (item 11) and consider showing the injury status on the sheet's radar table.

## PM2 commands (not started by this agent)

```
cd C:\Users\derek\OneDrive\Desktop\ASTRA_TESTING\edgesheet-nfl\web
npm run build
pm2 start npm --name nfl -- run start                 # next start -p 3100
pm2 start scripts/telegram-bot.mjs --name nfl-telegram --time
pm2 start scripts/odds-snapshot.mjs --name nfl-odds --no-autorestart --cron "0 */6 * * 4,5,6,0,1"   # every 6 hours Thu to Mon
pm2 save
```

Weekly: `REFRESH=1 npm run ingest && pm2 restart nfl` on Tuesday after nflverse posts the week (the site picks up new digests by mtime without a restart, but the restart clears the memo).

Sunday sheet (optional cron, 8 AM ET): `pm2 start scripts/send-sheet.mjs --name nfl-sheet --no-autorestart --cron "0 8 * * 0"`.

Odds budget: NFL 20 calls a week at 3 credits (about 260 a month) plus college every 4 hours Wed to Sat; keep props on demand. `npm run odds:dry` costs nothing.

## Telegram setup

1. In Telegram, open @BotFather, `/newbot`, name it (for example EdgeSheet NFL), copy the token. Do not reuse the college bot's token.
2. Put the token in `web/.env.local` as `TELEGRAM_BOT_TOKEN`.
3. Send the new bot any message from Derek's account, then run `npm run telegram:chat-id` and put the printed id in `TELEGRAM_CHAT_ID`.
4. `pm2 restart nfl-telegram` (or start it). The bot answers `/slate`, `/leans`, `/record`, `/radar <team>`, `/game <team>`, `/help`, posts the morning slate at 8 AM ET on game days, kickoff reminders for followed teams, and postgame grades.
5. `npm run sheet:send` sends the Sunday sheet PNG.

## Files touched (beyond the clone)

New: `data/nfl-teams.json`, `scripts/ingest.mjs` (rewritten), `scripts/lib/csv.mjs`, `scripts/lib/elo.mjs`, `scripts/backtest.mjs` (rewritten), `scripts/odds-snapshot.mjs` (rewritten), `src/lib/nfl.ts`, `src/lib/radar.ts` (rewritten), `src/lib/consensus.ts` (rewritten), `src/lib/boxscore.ts` (rewritten), `src/lib/score.ts` (rewritten), `src/lib/slate.ts` (rewritten), `src/lib/backtest.ts` (rewritten), `src/app/standings/page.tsx`, `src/app/rookies/page.tsx`, `src/app/radar/page.tsx` (rewritten), `src/app/player/[id]/page.tsx` (rewritten), `src/app/backtest/page.tsx` (rewritten), `src/components/Slate.tsx` (rewritten), `src/app/layout.tsx`.
Edited: `generated.ts`, `types.ts`, `tendencies.ts`, `projection.ts`, `adjusted.ts`, `situational.ts`, `archive.ts`, `espn.ts`, `odds.ts`, `odds-core.mjs`, `feed.ts`, `watchguide.ts`, `ask.ts`, `sheet.ts`, `digests.ts`, `summaries.ts`, `report.ts`, game page, GameCard, ProspectCard, Avatar, Headshot, badges, ConsensusTable, Situations, WrittenReport, API routes, telegram-bot and write-watchguides scripts, package.json.
Deleted: `cfbd.ts`, `data.ts` (sample slate), `forecast.ts`, `declarations.ts`, `portal.ts`, `prospects.ts`, `DecisionButtons.tsx`, the draft and rankings pages, the declare route, college ingest scripts, college runtime data (archive, odds, ai, backtest, weights).

## Model documentation

- Elo (`scripts/lib/elo.mjs`): every team 1500 the first season in the file (2019); each later season starts at 1500 + 2/3 of last year's distance from 1500; K 20; 48 Elo points of home field; margin multiplier ln(margin + 1) * 2.2 / (0.001 * winner Elo diff + 2.2); 25 Elo per point of spread. Walk-forward pregame values per game id in `elo.json`.
- Watch Score (`src/lib/score.ts`): competitive 30% (100 minus 4.5 per point of spread), unit mismatches 25%, rookie and breakout density 15%, stakes 20% (division game +25, both teams winning +25 scaled by week, playoff seeds late), availability 10% (national window 100, CBS/FOX regional 70, final 30).
- Player Watch Score (`src/lib/radar.ts`): production percentile 50% (within NFL position group, blended with the opponent-adjusted percentile when a game log exists), snap share 30%, context 20% (slot beaten for rookies and year 2, breakout, starter). Slot score: 100 minus 25 * sqrt((pick - 1) / 31), undrafted 8. "Producing like pick N" inverts that. Breakout: target share up 7 points to at least 15%, or production per game up 40% on a base of 4+ games last season.
- Tendencies from play-by-play (`scripts/ingest.mjs`): plays are pass or run plays with EPA, no aborted plays; success and EPA per play, explosiveness = EPA on successful plays, standard vs passing downs (1st; 2nd and 7 or less; 3rd/4th and 4 or less), pressure = sacks plus QB hits per dropback, blitz and play action from FTN (5+ rushers or any blitzer), run game axis = rush EPA per carry (yards before contact are not in play-by-play).

## Ideas along the way

- Snap share by week would make the Breakout lens sharper than season averages; the snap counts file has it per game already.
- The FTN file has drops, interception-worthy throws, and catchable balls per play: a QB "ball placement" line on the radar card would be real data, not a checklist.
- Standings stakes could use ESPN FPI's playoff probability (already fetched in `fpiRatings`) for "playoff odds swing" on the game card.
- The Odds API's `player_anytime_td` props next to the Matchup players would tie the lens to the market in one line.
- The depth chart snapshot is daily; a "who moved up the chart this week" list is one diff away.

## Session 2026-10-04 (game-day morning)

Ops: Telegram bot @EdgeSheet_NFLbot live (token and chat id in `.env.local`), PM2 `nfl-telegram` and `nfl-odds` (cron every 6 hours Thu to Mon) started, `pm2 save` done. First full odds snapshot: 27 games, 467 credits left. All 14 watch guides written (about $0.31; two needed a retry after the proper-noun validator rejected ordinary capitalized words like "Staying" and "Could"). `npm run guides` now runs under `tsx` (it imports TypeScript libs; plain `node` failed).

Fix: tackles. The ingest dropped nflverse `def_tackle_assists`, so every tackle total was solo plus with-assist only (Roquan Smith showed 10, real combined 28). Now `tk = solo + ast + tast`, the way books grade "tackles + assists". Radar production for defenders moves with it.

New: DraftKings and props lens (`src/lib/dfs.ts`, `src/components/DfsPanel.tsx`).
- Salaries from DraftKings' public lobby JSON (`getcontests`, then `lineup/getavailableplayers?draftGroupId=`; the `api.draftkings.com` draftables endpoint returns Access Denied). Classic group with the most games on the date, Showdown FLEX for games outside it. Cached 20 minutes in memory and in `data/dk/<date>.json`.
- DK points scored from nflverse game lines with Classic rules (no two-point conversions). Defense vs position = DK points allowed per game by position, ranked 1 (softest) to 32.
- Proj = average (blended with last season under 2 games) times half the matchup factor (capped 0.7 to 1.35), plus half an Out or Doubtful teammate's average for the next man up, only when that absence is new (he played the team's last game). QBs never add points; a backup QB shows only when the starter is out. Value = proj per $1,000.
- Defensive props: tackles (5+ a game, half the snaps) against opponent plays per game; pass rush (1+ QB hit a game or 2+ sacks) against opponent pressure allowed. Posted lines show when props are pulled.
- Props pull now includes `player_tackles_assists` and `player_sacks`: 6 credits a game, still on demand only.
- Game page: new "DraftKings and props" section (`#dfs`). Sheet: 04 DraftKings plays (Classic, by value, plus a "Showdown only" line per Showdown game with the next man up), 05 Defensive names for props; windows and weather are now 06 and 07.
- Sheet PNG: the old 816 x 1056 capture cut off everything after section 04. Now two pages (`/sheet?print=1&part=1|2`), each trimmed to content with sharp, sent as one Telegram album (`sendPhotoAlbum`). The single `/api/sheet.png` render is full height.

Open: the side leans ignore QB injuries (Colts at Commanders reads WSH by 5.3 "high confidence" with Jayden Daniels Out). Leans label 12 of 14 games STRONG against a backtest of 49.6% ATS; tighten after week 4 grades. Not committed.

## Session 2026-10-04, part 2: the model knows who is playing (`src/lib/availability.ts`)

- Status, freshest first: ESPN league injury feed (live through game-day inactives; athlete ids are our player ids), then the nflverse official report. Roster moves: a player whose last 2026 line was for another team arrived; one whose last line was here and is now elsewhere left; ESPN transactions (last 200) listed per team for context.
- QB: (expected starter EPA a play - play-weighted EPA a play of the QBs who took this season's snaps) x team QB plays a game. EPA a play = this season + half of last, shrunk toward replacement (25th percentile of QBs with 150+ plays) with a 200-play prior. Capped at 12. Covers injuries, benchings, and signed or traded QBs the same way.
- RB WR TE: EPA a touch or target above the 25th percentile at the position x plays a game x 0.5, capped at 3. OL DL LB DB: fixed starter values (OL 0.4, DL 0.4, LB 0.25, CB 0.4, S 0.25) x snap share, pass rushers with 1.5+ QB hits a game 1.5x; labeled "assumed value" on the page.
- Every non-QB charge is weighted by the share of team games he played (out since week 1 is already in the numbers) and the chance he sits (Out, IR, inactive 1; Doubtful 0.85; Questionable 0.25, 0.5 with no final-day practice). Offense and defense each capped at 4 before the QB term.
- `projectGame` takes `homeAvail`/`awayAvail`: margin moves by home total minus away total; the model total moves by both offenses minus both defenses; a questionable starting QB drops high confidence to medium. Basis lines say what moved.
- Archive: the pregame lock now follows the news until kickoff (projection, spread, total, consensus refreshed together so the grade uses the line the call was made against); the first lock is kept in `pregame.first`. Nothing moves after kickoff.
- Game page: "Who is playing" section (`#playing`). DraftKings lens uses ESPN status too (DK tag, then ESPN, then the report).
- Known limit: QB value only sees this season and last. Jayden Daniels prices near Marcus Mariota on that window, so the model moves Colts at Commanders far less than the market did.

## Session 2026-10-04, part 3: QB track records (2:30 PM)

- Ingest pulls `stats_player_week` for 2022 to 2024 too (optional files) and writes `data/generated/history.json`: compact QB and skill totals per current player for seasons before last, plus last season's regular-season QB plays and EPA by team (`teamQb`).
- QB value = weighted EPA a play over up to five seasons (this season 1, last 0.7, then 0.5, 0.35, 0.25), shrunk with a 200-play prior whose mean slides from replacement level (thin record) to the league average (500+ weighted plays). Daniels now 0.099 against Mariota 0.040 (was about even on the old one-and-a-half-season window).
- QB baseline blends this season's QB snaps with last season's, this season weighted games / (games + 6), because the Elo still carries most of last season. Side effect, on purpose: a healthy starter whose team's Elo was built with backups last year gets credit (Burrow +2.8, Kyler Murray over last year's McCarthy +2.7). Same idea as QB-adjusted Elo; not backtested yet.
- Open: backtest the QB adjustment on 2022 to 2025 (starter by game from the weekly files, replay Elo with and without, compare margin error against finals and closing lines), then tune weights and the STRONG thresholds. Live and final game pages show in-game injury changes in the displayed projection; the archive lock is frozen at kickoff, so grading is not affected.

## Session 2026-10-04, part 4: QB backtest (3:15 PM)

`npm run backtest:qb` (`scripts/backtest-qb.mjs`, results in `data/backtest/qb.json`). Walk-forward over 2022 to 2025, 1,139 games: each starter (nflverse schedule QB names, matched in the weekly files) is valued only from plays before kickoff, with the same weights, prior, and baseline as the live model. Downloads 2018 to 2021 weekly files to the cache for the track records.

| | MAE vs final margin | side cover vs close |
| --- | --- | --- |
| Market (closing line) | 9.54 | |
| Elo alone | 9.95 | 49.6% |
| Elo + 0.75 x QB (live) | 9.88 | 48.3% |
| Elo + 1.0 x QB | 9.90 | 48.5% |
| QB-change games (386), Elo alone / + 0.75 x QB | 10.32 / 10.07 | 51.7% / 51.5% |

- The QB term correlates 0.61 with how far the market sits from Elo and 0.17 with how far the result lands from Elo: real information, already in the price. It makes the model more accurate and pulls it toward the closing line; it does not make the side beat the close.
- Cover by gap to the close (k 0.75): 0-1 46.7%, 1-2 49.7%, 2-3 50.2%, 3-4 40.1%, 4-6 57.1% (98), 6+ 44.4% (18). No gap size clears 52.4%; noise around 50.
- Changes: QB term scaled 0.75 (`QB_SCALE`). Leans relabeled from strong/moderate and "high confidence" to "big gap"/"gap"; the sheet and Telegram lean lists carry `LEAN_BACKTEST_NOTE` (digests.ts). Totals are still untested (needs play-by-play per season for the EPA total).
- Next: backtest the total (download pbp 2022 to 2025, rebuild the EPA total walk-forward), then the unit-edge blend; only then decide whether any lean deserves a stronger label.

## Session 2026-10-04, part 5: totals backtest (3:35 PM)

`npm run backtest:total` (`scripts/backtest-total.mjs`, results in `data/backtest/total.json`). Rebuilds the live total walk-forward from nflverse `stats_team_week` (230 KB a season; passing plus rushing EPA over attempts, sacks, carries), weeks 3 on, 2022 to 2025, 959 games. Weather and availability left out.

| | MAE vs final total | bias | over/under hit |
| --- | --- | --- | --- |
| Closing total | 10.12 | | |
| Old live (22.8, full deviation) | 10.83 | +0.72 | 47.9% |
| New live (22.4, half deviation) | 10.51 | -0.08 | 48.4% |
| Best on grid (22.4, 0.75, last season blended at 3/(games+3)) | 10.48 | -0.08 | 48.0% |

- Applied: `AVG_PPG` 22.4, `TOTAL_SHRINK` 0.5 in projection.ts. The last-season blend was a hair better but needs last season's team rates in teams.json; not done.
- No gap size beats a coin flip on the over/under (5+ gap: 52% on 281 games with the old model, noise). `LEAN_BACKTEST_NOTE` now says so for totals too.
- consensus.ts keeps its own EPA margin model with the old constants; the total backtest does not speak to margins, so it was left alone.
