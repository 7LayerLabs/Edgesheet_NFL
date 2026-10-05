# Project: EdgeSheet NFL, audit round (accuracy + viewing efficiency)

## Problem Statement
Four read-only audits ran on 2026-10-04 evening (data layer, displayed pages, model logic, speed and scanability).
The core numbers are sound: all 1,478 players' 2026 stat lines match the raw nflverse files, team tendencies and Elo
recompute correctly, kickoff times / networks / week labels match ESPN, and all 13 graded week-4 calls are graded
against the right line. The problems are in what feeds the model (stale statuses, live odds, neutral sites, lagging
denominators), what the pages label, and how heavy the pages are (multi-MB images, a 1.1 MB slate payload).

Every item below was verified (repro scripts in the session scratchpad: audit-data, audit-model, audit-display, audit-perf).
File:line references are from commit 0b37dfe.

Ground rules for the fixes:
- This Desktop folder is a second working copy. The live instance (PM2, Telegram, odds cron) runs on the other PC.
  Fixes get committed here and pushed; the other PC pulls. **Never commit `web/data/archive/` or `web/data/ai/`
  from this copy**: page GETs here write lock files, and the live PC owns that record.
- One fix, one purpose, smallest change that solves the root cause. `npx tsc --noEmit` after each item; re-run the
  matching audit repro and re-check the page.

## Plan

### Phase 0: Housekeeping (this copy)
- [x] 0.1 Undo the audit's side effects: `git restore web/data/archive web/package-lock.json` and delete the ~30 untracked
      week-5 lock files the audit page loads created (401872979+). They regenerate on the next page view.

### Phase 1: Accuracy, the model is fed wrong inputs (biggest effect on the calls)
- [x] 1.1 **QB change counted twice in the model total.** `projection.ts:193` adds the QB term (measured against a baseline
      that blends LAST season's QBs) to a total built only from THIS season's EPA. Browns@Jets total gets +1.8 that should be 0
      (reads "over by 6"). Fix: the total uses a QB term against this season's QB mix only; the margin keeps the blend.
- [x] 1.2 **Last week's game-day statuses charged against next week.** `availability.ts:129` treats any ESPN comment containing
      "inactive" (and in-game "won't return") as a certain absence with no date check; `dfs.ts:197` `isOut` inherits it.
      Jefferson -1.9, McConkey -2.7 on week-5 projections; they also drop out of the DK plays. Fix: ignore ESPN game-day /
      in-game designations dated on or before the team's last completed game; fall back to the official report.
- [x] 1.3 **In-game odds snapshots become "the market".** `odds-snapshot.mjs:69` keeps snapshotting 4 h after kickoff and
      `odds.ts:93` `latestLine` returns the newest. IND@WSH final shows "IND -10.5, moved from -4.5", ML WSH +1030, and a lean
      against it (real close -4.5). Fix: `latestLine` ignores snapshots after kickoff; the cron stops at kickoff;
      `digests.ts:76` `modelLeans` skips live games too.
- [x] 1.4 **Neutral-site games scored as home games, with the wrong city's weather.** Week-5 PHI@JAX (Tottenham) is marked
      "Home" by nflverse: +48 Elo home field, JAX by 7.6 → a "big gap" that is really 2.65; NWS pulls Jacksonville. Munich,
      Mexico City, Melbourne, Rio venues don't match the list and fall back to the US home stadium with NWS on.
      Fix: neutral when ESPN `neutralSite` is true or the stadium isn't the home team's (`slate.ts:511`, `ingest.mjs:161`);
      add Melbourne / Maracanã / Bayern / Banorte to `data/nfl-teams.json`; `venueFor` (`nfl.ts:230-243`) returns `nws: false`
      when unmatched or outside the US.
- [x] 1.5 **Games-played counts come from scores; the stats files lag.** `ingest.mjs:187-192, 714, 772-776`. Tonight's ingest
      has MIA@MIN scored but not in play-by-play: MIA pace 43.0 (true 57.3), MIN 41.0 (54.7); DK defense-vs-position ranks
      flip (MIA vs QBs 22nd, should be 7th); tackle-prop opponent plays cut ~25%. Fix: count team games from the pbp game ids
      actually tallied; write a game-log entry only when it has player lines; `statsThroughWeek` = last fully posted week, and
      the slate note says "N of M week-4 games".
- [x] 1.6 **Breakout lens: per-game math applied twice.** `radar.ts:261-262` divides `production()` by games, but production
      already mixes per-game rates with season totals. Tyler Warren "+209%" with flat per-game numbers; 49 of 95
      production-based breakouts fail the 40% test when computed once. Fix: per-game normalize once, consistently.
- [x] 1.7 **A Wednesday-start week swallows the prior Monday night game.** `nfl.ts:111` starts each week 2 days before its
      first kickoff. 2026 week 12 (Wed 11-25) takes week 11's Bengals@Commanders Monday game; it never shows or locks.
      Fix: a week starts the day after the previous week's last game.
- [x] 1.8 **Questionable QB who missed practice treated as out.** `availability.ts:356` healthy filter is `< 0.5` and
      Q+DNP scores exactly 0.5 → Burrow swaps to Flacco (-3.1) and confidence stays high. Fix: `<= 0.5`.
- [x] 1.9 **Closing-line value is zero by construction.** The lock follows the line to kickoff, so close == lock; all 13 graded
      entries show CLV 0. Fix: `archive.ts:323` / `odds.ts:240` measure CLV from `pregame.first ?? pregame`.
- [x] 1.10 **Depth chart takes KR/PR slots as a player's best rank.** `ingest.mjs:245-252`: 42 non-specialists listed rank 1
      via returner slots (Ameer Abdullah "KR 1" outranks RB2 for next-man-up). Fix: ignore Special Teams rows except K/P/LS.
- [x] 1.11 **Snap-count join by name drops real starters.** `ingest.mjs:286-300`: 19 players with snaps get none
      (Pat/Patrick Surtain II, Gregory Rousseau, Kenneth Gainwell...), so Surtain Out costs nothing. Fix: join on
      `pfr_player_id` = roster `pfr_id` (1,611 of 2,015 have it), name as fallback.
- [x] 1.12 **`gp` counts stat rows, not games played.** `ingest.mjs:340-391`: nflverse writes no row for a zero-stat game, so
      per-game rates inflate (96 of 404 skill players affected; Tonyan gp 1 vs 4 snap games). Fix: gp = max(stat games,
      snap games) via the 1.11 join. (Do after 1.11.)
- [x] 1.13 **Two-point tries counted as plays.** `ingest.mjs:554-557`: 23 tries in team metrics (down empty → 0), 7 phantom
      red-zone trips. BUF rzTd 0.765 vs 0.733 true. Fix: skip `two_point_attempt === "1"`.
- [x] 1.14 **Prior seasons include playoff games.** `ingest.mjs:341-391, 816-828` (Allen 2024 gp 19 vs 16 REG). The backtests
      use REG only, so live and backtest disagree. Fix: filter `season_type === "REG"`.
- [x] 1.15 **Stale roster/injury rows.** `ingest.mjs:216-226, 260-264`: 17 players on old teams from week-1 roster rows; bye
      teams will carry last week's game-day statuses. Fix: drop roster rows older than the file's latest week unless the
      player has current stats; show injury rows only when their week matches the team's next game week.
- [x] 1.16 **Elo ties never move ratings.** `elo.mjs:49` `ln(0+1)=0`. 6 ties since 2019, max 4.9 Elo. Fix:
      `Math.log(Math.max(margin, 1) + 1)`. Re-run `npm run backtest` and note the (tiny) change.
- [x] 1.17 **Team tendencies don't refresh after an ingest.** `tendencies.ts:69,136,287` memo keys miss the teams.json mtime;
      unit edges can lag up to an hour while availability is fresh. Fix: include the digest mtime in the keys.

### Phase 2: Accuracy, what the pages say
- [x] 2.1 **Out / IR players on the radar as available, and "On the spot" picks an injured QB.** `slate.ts:494-499` tags from
      the nflverse report only (same page's "Who is playing" uses ESPN); `radar.ts:455-470` picks the QB with most attempts
      (Caleb Williams, Out; Bagent threw all 34). Fix: use the availability status for tags, drop IR from the lenses, filter
      out non-playing players before picking.
- [x] 2.2 **Records skip games that went final after the ingest.** `nfl.ts:169`: "Chiefs 3-0 30 @ Raiders 3-0 27 · Final" while
      "Colts 2-2" counts today. Fix: fold the ESPN finals the page already fetches into the record math.
- [x] 2.3 **Final pages show a rebuilt projection that contradicts the grade under it.** (known #8, worse than described)
      IND@WSH: "Colts by 7.4" next to "winner wrong"; the lock was WSH by 0.75. Fix: live/final pages show `archive.pregame`.
- [x] 2.4 **"Starting quarterbacks" storyline is wrong.** `slate.ts:591` uses nflverse schedule names (Keenum for CHI;
      Mariota for WSH, who was Doubtful). Fix: use the availability model's expected starter.
- [x] 2.5 **One lean vocabulary everywhere.** Three threshold sets (`digests.ts:70` 4/2, `ledger.ts:71-72` 6/3, game page
      `479-480` 6/3 + "slight"); the game page still shows red "STRONG LEAN", "noise under 2 points", "Confidence high"
      (means inputs exist); Telegram `/game` says "(high confidence)" (`digests.ts:381`); Ledger says "strong". Fix: one
      shared constant, "gap"/"big gap" wording, `LEAN_BACKTEST_NOTE` on the game page and ledger, "Confidence high" →
      "inputs complete".
- [x] 2.6 **Box-score leaders show ESPN ids instead of names** on nflverse-sourced finals ("passing 4432722 15/33").
      `slate.ts:426-427` passes an empty names map. Fix: fill it from the players digest.
- [x] 2.7 **Projected score doesn't match the margin.** "Lions 29 @ Panthers 23" next to "Lions by 4.8". `projection.ts:228`.
      Fix: away = round((total - margin) / 2), home = round((total + margin) / 2).
- [x] 2.8 **Telegram `/game` date from UTC.** Night games show the next day (`digests.ts:370`). Fix: `etDateOf`.
- [x] 2.9 **DK cache key ignores which games were asked for** (`dfs.ts:159`): the first page to ask decides which Showdown
      games get salaries for the date. Fix: key on date + the Showdown game set (or cache the raw lobby, filter per call).
- [x] 2.10 **Label cleanup (one commit):** `Situations.tsx:74` says "inside the division" for league ranks; college leftovers
      (`/watchlist` "Your Saturday", "Top 25" buttons → 404 `/rankings`, `/feed` Georgia/Alabama example, Ledger
      "CollegeFootballData consensus", "Noon" for 9:30 AM / 1 PM windows in `format.ts:35`); `/history` cuts text at "No."
      (`history/page.tsx:102`), "waiting on a final" rows have no date, the empty excitement table needs a one-line why;
      "NFL Net" not in `NATIONAL_WINDOWS` (`nfl.ts:366`) so London games score availability 60 not 100.

### Phase 3: Speed (measured on a prod build)
- [x] 3.1 **Headshots load full size.** nfl.com headshots are 1.1 to 3.8 MB each for a 36-64 px circle: ~15 MB per game page,
      65 MB `/radar`, 86 MB `/rookies`. Fix: request a 128 px crop (`w_128,h_128,c_fill,g_face` in the nfl.com URL, ESPN
      `combiner/i?img=...&w=96&h=70`); ~2 to 10 KB each. One helper.
- [x] 3.2 **Team logos are 500 px PNGs** (40-94 KB each, shown at 14-48 px; 1.6 MB of filter chips on `/radar`). Fix:
      `logoUrl` (`nfl.ts:56`) uses ESPN's combiner at 96 px (~2 KB).
- [x] 3.3 **The slate ships every full game record to the browser.** `page.tsx:76` hands `games` to the client `<Slate>`:
      1,114 KB of the 1,168 KB HTML, and again on every 60 s live refresh. Cards read ~18 fields. Fix: map to card fields
      before passing down (~31 KB).
- [x] 3.4 **Outside fetches run one after another.** `buildGame` chain in `slate.ts` (scoreboard → NWS → ESPN injuries → FPI):
      ~690 ms serial on cold builds, none depends on another. Fix: start them together at the top (~450 ms saved).
- [x] 3.5 **No timeout on weather; 20 s on injuries.** `nws.ts:25` can hang the page; `availability.ts:57` waits 20 s despite
      a disk fallback. Fix: 4 s NWS, 6 s ESPN injuries.
- [x] 3.6 **Live polling refreshes on every tab refocus.** `LivePoller` has no throttle (each slate refresh ~1 MB before 3.3).
      Fix: skip the refocus refresh if the last one was < 30 s ago.
- [x] 3.7 **Finals rebuild every 30 s for 30 hours** (`slate.ts:734`), each re-fetching ESPN. Fix: 600 s TTL once final.
- [x] 3.8 **Beat feed renders up to 60 items** (~9.5 phone screens) and tries Bluesky hosts one after another (12 s worst case,
      `feed.ts:86, 279`). Fix: cap the game page at 10 with a link to `/feed`; race the two hosts.
- [x] 3.9 (small) `generated.ts:166` stats the digest file ~2,800 times per build (~130 ms). Fix: re-check mtime at most every 5 s.

### Phase 4: Scanability (design changes; needs Derek's sign-off on direction first)
- [x] 4.1 **Game page: put the answer on screen 1.** Today the projected winner is ~6 phone screens down and the lean ~21
      (page ~37 screens, ~6,900 words). Add one answer strip under the title: model call, line, lean, one key note. Move
      the "what this report cannot say" box to the bottom.
- [x] 4.2 **Cut repeats:** Why-watch heading duplicates reason #1 (`slate.ts:350`); Pressure point card repeats matchup #4;
      "vs the number" printed twice (`page.tsx:499, 578-583`); consensus in two blocks.
- [x] 4.3 **Shorten long sections:** radar top 4 + "show all"; Team style in a `<details>`; hide empty placeholders on
      upcoming games ("No report written yet", "Opens at kickoff"); jump bar from 15 links to ~6 plain labels.
- [x] 4.4 **Slate: first game card above the fold** (now starts 1,078 px down at phone width): collapse filters to one row, add
      the model call to each card, drop what's identical on every card ("NFL" tag, "FULL" coverage, doubled "defense D").
- [x] 4.5 **Labels that don't tell games apart:** "Hidden Gem" on 10 of 13 Sunday cards; tighten the rule.
- [x] 4.6 **Sheet table on phones:** hide Kick/TV under `sm`, give "Why" its own row.
- [x] 4.7 **Decision for Derek:** the radar's default order is 19 of the top 20 defenders, and 8 of 14 headlines use the
      "X (LB/SAF/CB, Rookie) is a top-of-the-radar name" template. Rebalance by position, or leave it?

### Phase 5: Verify and ship
- [x] 5.1 `npx tsc --noEmit`, `npx next build`, re-run `npm run backtest`, `backtest:qb`, `backtest:total`, `backtest:dfs`
      and record any changed numbers in AGENT-REPORT-nfl.md.
- [x] 5.2 Re-run the four audit repros; walk the slate, 3 game pages (final, week 5, PHI@JAX London), radar, rookies on
      the prod build; re-time pages.
- [x] 5.3 Commit per phase (no `data/archive`, no `data/ai`). Push only on Derek's go; the other PC then pulls,
      `REFRESH=1 npm run ingest`, `pm2 restart nfl`.

## Progress Notes
- 2026-10-04: audits complete, plan written. Derek: "do it all" (all phases, radar rebalance, push at the end).
- Phase 0: restored the audit's archive/package-lock side effects. (Page views keep re-writing archive files; they are never staged.)
- Phase 1 (src side): QB total term vs this season's QBs only (`offenseTotal`); `playerStatus` + `statusClock` date ESPN game-day
  designations (30 h news window after the previous kickoff) and drop official reports from earlier weeks, shared by availability
  and DraftKings; odds snapshots after kickoff ignored on read and refused on write, cron stops at kickoff, leans pregame only;
  neutral = nflverse flag OR ESPN neutralSite, listed neutral venues matched regardless of flag, unmatched neutral = no forecast;
  breakout compares last season restated at this season's game count (102 -> 64 breakouts); week windows start after the
  previous week's last game (0 misplaced games 2024-2026); Q QB with no practice blended, not benched; CLV from the first lock
  (ledger recomputes, fixes stored zeros); tendency memos keyed on teams.json mtime.
- Phase 1 (scripts side, 1.4 ingest/1.5/1.10-1.16): done by the ingest agent (scripts/ and data/nfl-teams.json only), each
  item verified against the raw CSVs; the app shows `meta.latestWeek` ("10 of 11 week 4 finals posted").
- Phase 2: one status per game page (TeamAvailability.statuses) drives radar tags, drops players who sit from the lenses and
  the matchup pick, and names them in storylines; expected QBs from the availability model; records fold in ESPN finals
  (espnWeek now 10 min, carries finals); live/final games show the locked call (`lockedProjection`); shared `leans.ts`
  (thresholds 4/2 side, 5/2.5 total; "big gap"/"gap"; inputs label) used by digests, ledger, game page; box names from the
  players digest; score line rounds both sides from total and margin; Telegram date in ET; DK slate fetched per date from the
  schedule; label cleanup (windows Early/Late afternoon, NFL Net national, college leftovers, history fixes).

- Phase 3: small image renditions (images.ts), card-sized client payloads (card.ts), parallel fetches, timeouts, poller
  throttle, final-game memo, mtime throttle, feed cap and Bluesky race.
- Phase 4: answer strip, jump bar, section order and disclosures, slate filters and card model call, Hidden Gem 78, density
  rescale, radar snap share as a within-group percentile, headline order, sheet phone layout. Also fixed horizontal overflow
  at 390 px that predated this round (ProspectCard and LivePanel grids, drive chart rows, DraftKings chips).
- Phase 5: tsc clean, prod build clean, backtests re-run, pages walked at 390 px, prod timings taken.

## Review
### Changes Made
- Ingest (scripts/ingest.mjs, scripts/lib/elo.mjs, data/nfl-teams.json): neutral venues, games from play-by-play, latestWeek,
  depth chart, pfr snap join, gp with snaps and zero lines, two-point tries out, regular season only, stale roster rows, Elo ties.
- Model and data (src/lib): availability (QB total term, dated statuses, statuses map), projection (locked call, score line,
  shared market text), odds (pregame-only snapshots), nfl (week windows, venues, finals, standings, small logos), radar
  (breakout basis, snap-share percentile, sits filters), slate (status, neutral, finals, parallel fetches, locked call,
  storylines, density, headline order), archive and ledger (CLV from the first lock), leans.ts (one vocabulary), dfs,
  digests, boxscore, tendencies, generated, feed, nws, score, format, card.ts, images.ts.
- UI: game page restructure, GameCard model call, Slate filters, Ledger wording, LivePanel folds, BeatFeed limit link,
  AvailabilityPanel wording, history fixes, standings logos, sheet phone CSS, label cleanup.
- Key decisions: lean thresholds unified on the sheet's 4/2 and 5/2.5 (the ledger's simulated record changes); stale ESPN
  game-day designations fall back to questionable (0.25) until a fresh report; Hidden Gem 78 and density / 4.5 were
  calibrated on two slates (27 games) and should be checked after a few more weeks.

### Notes
- Page GETs write data/archive locks in any copy. Never commit data/archive or data/ai from this Desktop copy.
- The dev server's in-process memo outlives code edits (HMR keeps memo.ts); restart it after changing cached shapes.
- Not backtested: QB-in-total, the stale-status rule, the rescaled Watch Score and tags.
- Five lint errors predate this round and remain (BoardClient, two error.tsx, AvailabilityPanel apostrophes).
- Details and numbers: web/AGENT-REPORT-nfl.md, "Session 2026-10-04, part 7".
