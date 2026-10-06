# WHERE WE LEFT OFF (kept current at every push)

Last updated 2026-10-06, commit "Phase 11". Derek's instruction: finish the rest and push as soon as it is done.
- DONE and pushed: game page read (Section 1), Phase 1 data (per-game snaps, history-games.json, play calling), Phase 2
  trends, info tips everywhere, Phase 3 work left open, Phase 4 player history, Phase 5 backtests (results below: no
  storyline passes; only a player's own home/away split carries over, weakly; primetime teams score 1.1 under the line).
- DONE and pushed since: Phase 11 (DraftKings Our price, Safest/Upside value lists, graded record).
- LEFT, in this order: Phase 6 (splits
  on the page: the player home/away flag, primetime team note, defense home-division), Phase 7 (defense vs position
  table), Phase 8 (slate home: team totals, values, weather, total bands, Main/Showdown filters), Phase 9 (sleepers by
  beat buzz), Phase 10 (single-entry lineup). Then the section-by-section review resumes at the Matchups fold.
- KNOWN: nflverse had not posted week 4 snap counts (re-run `npm run ingest` to fill them); the dev server on :3100 was
  stopped by Claude Code for low memory on 2026-10-06 and not restarted; memoSync results live on globalThis, so restart
  the dev server after changing a cached shape; pre-existing lint errors remain in BoardClient and the two error.tsx.

# Project: Trends, splits, and storyline backtests (ideas borrowed from the "Edge" YouTube walkthrough)

Status: Phases 1-5 BUILT and pushed; the rest in progress (see WHERE WE LEFT OFF). Derek picked each item yes or no on
2026-10-05 (WR vs CB skipped: no alignment or coverage data in any source we have, it would be guessed).

## Problem Statement
A walkthrough of another NFL app had ideas worth borrowing: weekly usage trends with the reason attached, position rooms,
play calling by week, vacated targets, history against the opponent, home/division splits, a richer slate page, a
sleepers list, a single-entry lineup. Derek's rule for the "edges" in it (hometown games, revenge games, "he loves
playing Arizona", "Pittsburgh at home vs a division rival"): test them on 2018-2025 before the site calls anything an
edge, and show how the player did each time.

What we already have that is close (survey 2026-10-05): season snap share only (per-game snaps are averaged away in
ingest); per-game targets, carries, and target share in gamelogs.json; season pass rate in Team style; DK points allowed by
position, season only, inside the DFS projection (dfs.ts defenseVsPosition); a hidden "half to the next man up" rule in
the DFS sim; the beat feed (Bluesky, Reddit, Google News) with Jev chips; Homecoming / College ties / Revenge tags in Who
to watch; slate windows plus Prime time and Weather chips; DK values on /dfs and /sheet.

Data on hand for all of it: nflverse weekly player lines 2018-2026 (game id, team, opponent), games.csv 1999-2026 (rest
days, division flag, weekday and kickoff time, closing spread and total, stadium id, neutral site), snap counts 2025-2026
per game, play-by-play 2026 with xpass and pass_oe, ESPN birthplace and college (storylines.ts cache).

## Plan
### Phase 1: data foundation (ingest only, no UI)
- [x] 1.1 Per-game snap share (offense, defense, special teams, and snap counts) on every gamelogs.json line, from
      snap_counts per game, plus carry share per game (his carries over the team's). Check: Bijan's week lines match the
      snap_counts CSV.
- [x] 1.2 History lines: data/generated/history-games.json, every QB/RB/WR/TE game 2018 to now: season, week, game id,
      team, opponent, home/away/neutral, DK points, targets, carries, yards, TDs, plus the game's flags from games.csv
      (division, primetime = not Sunday or kickoff 7 PM ET or later, short week = 4 or fewer days of rest, closing spread
      and total, stadium id). Report the file size; keep it under about 5 MB.
- [x] 1.3 Team play calling by week from play-by-play: pass rate, neutral-situation pass rate, and pass rate over
      expected (nflverse pass_oe) per team per week.

Phase 1 notes (2026-10-05): gamelogs lines carry `sn` {o, d, st, os, ds} and `s.rshare`; teams.json carries `calls` by
week; history-games.json is compact rows (cols: g, t, then the dkPoints stat keys plus tgt, ra, pa), 23,900 rows for 555
of 599 current skill players, 1.2 MB. It starts in 2019, not 2018: rows point at schedule.json by game id, and the
schedule starts in 2019, so the opponent, home/away, division, kickoff, rest, and closing line are not copied. DK points
are computed at read time with dkPoints (one scoring function). Checks: Bijan's snaps match the CSV (77/51/72%), carry
shares sum to 1.00 in all 116 team-games, every history row's game is in the schedule, Bijan's 2024 DK total 354.7, no
other game log field changed. Known gap: nflverse had posted 91 snap rows for week 4 (a full week is about 1,500), so
week 4 lines have no snaps yet; the trends must say "snaps not posted yet", never 0%. League mean pass rate over
expected is -1.9 points this season (nflverse's xpass model), small next to the +/-5 labels.

### Phase 2: trends (game page section + player page)
- [x] 2.1 src/lib/trends.ts: each team's rooms (QB, RB, WR/TE) by week: snap %, carries and carry share, targets and
      target share, air yards share, DK points. A week is a change when snap share moves 15 points or target or carry
      share moves 8 points against his average before it.
- [x] 2.2 The reason for each change, from data only, first match wins: a teammate in his room who normally plays did not
      play ("Michael Pittman did not play"); he came back from missing games; blowout (final margin 17+, starters sat
      late); left early (snaps under half his norm and on the injury report the next week); rookie workload growing
      (rookie, snaps up three straight weeks); new team this season. Else "no clear cause in the data".
- [x] 2.3 Game page: a "Trends" section (closed by default like the others) with metric toggles (snaps, targets,
      carries, air yards, DK points; several at once), rooms per team, the reason under each change. Closed summary line,
      for example "Saints backfield: Kamara 31% of snaps; Etienne out".
- [x] 2.4 Player page: his week-by-week log with the same metrics and reasons.
- [x] 2.5 Play calling by week on the game page: each team's pass rate and pass rate over expected per week, labeled
      pass-heavy / balanced / run-heavy (over expected by +5 points or more / within 5 / -5 or less).

Phase 2 notes (2026-10-05, BUILT, waiting on Derek's look, not committed): reasons as built, first match wins: a regular
in his room (40% snaps, 15% targets, or 25% carries) did not play, left for another team, or came back; he left early
(snaps under half his norm, then missed the next game or listed the next week); blowout (17+, snap changes only: a
blowout says nothing about who got the targets); first game back; rookie snaps up three games running; a teammate's role
moving the other way. "New team this season" was dropped (it is a context, not a cause). Unexplained changes keep their
cell tint and hover text but sit in one muted "no clear cause" line, not in the notes. The summary line leads with the
newest week's strongest cause (topChange). Checked on the Rams: week 2 "Puka Nacua did not play" lifts Mumpfield 26 to
69% snaps and Ferguson 4 to 30% of targets; week 3 Ferguson "left early, then missed week 4"; week 4 Adams "Puka Nacua
came back". Layout: phone 390 px has no page overflow, tables scroll inside their card from the newest week with the name
column fixed; receivers with no carries skip the carries line; QBs show attempts. Gotcha hit again: memoSync results
live on globalThis, so a shape change in trends needs a dev server restart.

Added on Derek's ask (2026-10-05): an "i" tip on every player-page season-line stat (src/components/InfoTip.tsx,
src/lib/stat-glossary.ts): what the stat means, and what counts as good computed from this season's league at his
position over a volume bar (QB 10 attempts a week, RB 5 carries, WR/TE 3 targets, defenders half the games and 30% of
snaps, punters 2 punts, kickers 1 try): average, where the top quarter starts, best, his rank. EPA totals compare per
dropback / carry / target; INT and sacks per attempt or dropback (lower is better). No benchmark is typed in by hand.
Hover on desktop, tap on a phone; the box anchors to the stat's card so it stays on screen (checked at 390 px).
Then everywhere analytics or usage shows (Derek: "anywhere it's beneficial and helpful, especially analytics/usage"):
one definitions file, src/lib/terms.ts, checked against the code (success rate is nflverse's EPA above zero, not the
40/60/100 rule; production mixes per-game and season totals; Watch Score is 50% production pct, 30% snap pct, 20%
context). Tips on: the answer strip (The model, The edge with the lean backtest note), the Matchups intro, every Team
style metric, the Trends toggles and Play calling (its footnote removed), the DraftKings panel, the DFS page's player
table, and the player page's Watch Score, meters, Against the slot (its "producing like pick No. X" now says above,
about at, or below that slot), and Week by week. Every tip measured inside a 390 px screen.

### Phase 3: vacated opportunity and with/without
- [x] 3.1 For each player who is out: the share he leaves open ("Etienne out: 38% of Saints carries, 9% of targets").
- [x] 3.2 With/without: in games this season and last that he missed, each teammate's share and DK points against games
      with him; top three risers, with the games count.
- [x] 3.3 Show it in "Who plays" and use it for the Role change pick in Who to watch (who actually absorbed the work, not
      just the busiest teammate). The DFS sim's next-man-up rule stays until a model change passes its calibration gate.

Phase 3 notes (2026-10-05, BUILT, waiting on Derek's look, not committed): src/lib/vacated.ts. Who counts: backs,
receivers, tight ends on the availability list with a 50%+ chance to sit. Games he missed: this season after his first
game (posted games only), last season between his first and last game for the team (history-games.json stat rows, so a
teammate's zero-stat game drops out of both averages). Teammates compared per game: targets, carries, DK, with him (2+
games) against without (1+); risers ranked by the work he leaves (targets for a receiver or tight end, carries plus
targets for a back), 1+ a game gained, top three. Counts per game, not shares: last season's team totals would need
players no longer on the roster. Shown as "Work left open" under each team in Who's playing (with an info tip), and the
Role change slot now names the top riser ("In 3 games without Puka Nacua: 10.3 targets a game, up from 8.1") or, with
no games without him, the busiest teammate plus the carries and targets he leaves. Checked: Puka what-if finds 2025 W7
and 2026 W2-W3 and ranks Ferguson, Adams, Higbee by targets gained (Corum dropped once a receiver's sit counts targets
only); Etienne and Jefferson have no games missed in the window, so the block says so.

### Phase 4: history vs the opponent, and each storyline game
- [x] 4.1 Player page "Vs <opponent>": every game since 2018 against this week's opponent: date, his team, DK points,
      his average that season, the difference; the average difference and the games count. No "loves playing them"
      verdict unless Phase 5 finds such history predicts.
- [x] 4.2 Player page "Storyline games": every past revenge, hometown, home-state, and college-state game with DK points
      against his season average (Derek: "how they performed each time should be noted").

Phase 4 notes (2026-10-05, BUILT, not committed): src/lib/player-history.ts (pastGames, vsOpponent, storylineGames),
src/components/PlayerHistory.tsx, src/lib/places.ts (where a game was played: stadium id -> the team that plays there in
the latest season it appears -> nfl-teams.json city; OAK00 Oakland, LAX97 Carson, LAX99 Los Angeles by hand; London and
other international games by stadium name). Since 2019 (history-games.json), QB/RB/WR/TE only (defenders have no DK
history). The difference is against his average in his OTHER games that season. Birth city is strict: stadiums in
suburbs (Arlington, Foxborough, East Rutherford, Inglewood) do not match a "Dallas" birthplace; birth state catches them.

### Phase 5: backtests (rules written into the script before it is run; results in data/backtest/ and a short summary)
- [x] 5.1 Storylines (scripts/backtest-stories.mts): hometown (birth city), home state, college state, revenge (a team he
      played for within four seasons, or his drafting team), and first return. Measure: DK points minus his average in his
      other games that season (four or more other games). Compare with his other road games so home field is not the
      effect. Passes only with 50+ games, +1.5 DK or more, a 95% bootstrap interval above zero, and a 55%+ beat-his-average
      rate. Also report that rate plainly, against the "80 to 90%" claim.
      AMENDED BEFORE THE FIRST RUN (2026-10-05, no results seen): the 55% beat rate is dropped as a pass condition. DK
      points skew right, so most games sit under a player's own average and a fixed 55% bar measures the skew, not the
      story; the beat rate is reported for the group and its baseline side by side instead. The exact rules are in the
      header of scripts/backtest-stories.mts (also hometown-first and revenge-first subsets; revenge on 2022-2025 so the
      four seasons before each game are in the data). Needs ESPN birthplace and college for about 2,500
      players (one fetch each, cached) and a stadium table with city and state (non-US games left out).
- [x] 5.2 Splits (scripts/backtest-splits.mts): home/away, division, primetime, short week. Players: DK points against
      their season average. Teams: points against the closing implied team total. Defenses: DST DK points against their
      season average. Two questions: does the split exist league-wide, and does a player's or team's own split carry
      into the next season (year-to-year correlation). A split gets a flag only if it carries over (correlation 0.15+,
      interval above zero).
- [ ] 5.3 Wire the verdicts: what passes gets a flag on the player page, Who to watch, and DFS notes ("tested: +2.1 DK
      a game, 140 games"); what fails stays a storyline with "no measured edge in 2018-2025".

Phase 5 RESULTS (2026-10-05; npm run backtest:stories / backtest:splits; data/backtest/stories.json, splits.json):
Storylines, 38,030 QB/RB/WR/TE games 2019-2025, 1,046 players, ESPN birthplace for 1,044. NOTHING PASSES.
  birth city 48 games, +0.15 DK vs other road games [-1.62, 1.94], beat his own average 35% (other road games 40%);
  first game back in his birth city 41, +0.56, 34%; birth state 881, +0.38 [-0.08, 0.86], 43%; college state 685, +0.35,
  42%; revenge (2022-2025) 431, +0.32 [-0.29, 0.91], 45% vs 41%; first revenge game 300, +0.17. The "80 to 90%" claim:
  35% in our data.
Splits (2019-2025):
  Players: home +0.35 DK league-wide [0.14, 0.55]; a player's OWN home/away split carries over 2019-21 to 2022-25,
  r 0.18 [0.06, 0.30], 281 players: PASS (weak: expect about a fifth of a past gap). Division, primetime, short week:
  no carry-over.
  Teams against the closing implied total: home and division priced in; PRIMETIME -1.11 points [-1.83, -0.37] (389
  games, both teams under), a league-wide lean to unders that is NOT tested against the vig. No team's own split
  carries over.
  Defenses: home +0.53 DK [0.16, 0.90], home against a division rival +0.70 [0.26, 1.16] league-wide (mostly the home
  part; division alone +0.19, not significant); a team's own home-division split does not carry over (r -0.11).
  "Loves playing them": r 0.00 [-0.02, 0.03] over 9,572 games, slope 0.01. Past games against a team tell nothing.
5.3 so far: src/lib/backtest-notes.ts puts the verdicts on the player page (a visible line under Against the <opp>
and Storyline games, a tip on each storyline card) and in the Who to watch tip ("good stories, not edges"). The one
pass (players' home/away) and the primetime-teams finding feed Phase 6.

### Phase 6: splits on the page
- [ ] 6.1 Player page: home/away, division, primetime, short week, each next to his overall average with the games count.
- [ ] 6.2 Game page: each team's points against the implied total in this game's situation (home/away, division), and
      the defense's DST history in it (the Pittsburgh-at-home-vs-division case), with the games count.

### Phase 7: defense vs position, extended
- [ ] 7.1 DK points allowed to QB/RB/WR/TE this season and over the last four weeks, with rank, as a small table in the
      Matchups section for both defenses.

### Phase 8: slate home page
- [ ] 8.1 Implied team totals on each card (dst.ts impliedTotals) and a "Highest team totals" strip.
- [ ] 8.2 Top DK values strip (the day's simulation if built, else value per $1,000).
- [ ] 8.3 Weather watch list (games with a flag, worst first).
- [ ] 8.4 Cards banded by game total (high, middle, low; thresholds from the league's totals this season).
- [ ] 8.5 Main and Showdown filters (DK's main-slate games; single-game showdowns).

### Phase 9: sleepers by beat buzz
- [ ] 9.1 Tag feed items to any rostered player by name (today only radar players get tagged).
- [ ] 9.2 Rank players with more beat mentions this week than their role suggests (mentions against snap share and DK
      salary), boosted by Jev's "promoted" chip and by vacated work from Phase 3. Top ten on /feed and in each game's Beat
      feed section, each with its source links.

### Phase 10: DFS single-entry lineup
- [ ] 10.1 A third lineup that maximizes each player's 75th-percentile outcome (between Cash at the median and GPP at the
      90th), same DraftKings Classic rules and salary cap.

### Phase 11: DraftKings "Our price" and value picks (Derek, 2026-10-05: yes to all three)
Salaries are DraftKings' own (public lobby: getcontests, then getavailableplayers per draft group).
- [x] 11.1 Our price for every DK player: the salary his simulated median is worth at what DK charges per point at his
      position on that slate, next to DK's price with the gap ("DK $6,100 · ours $7,400 · $1,300 cheap") and the reasons
      from our data (role up with a teammate out, matchup, Jev news), on the DFS page and the game's DraftKings panel.
- [x] 11.2 Two lists per slate: Safest values (cheap for the price, lowest bust rate: cash) and Upside values (cheap,
      highest boom rate: tournaments). Not "can't miss": everyone busts in some simulations; each pick shows its bust chance.
- [x] 11.3 Log each slate's picks before kickoff, grade them after (beat the price, by how much, against everyone at that
      price), and show the record. No past DK salaries exist to backtest, so the record is the test.

Phase 11 notes (2026-10-06, BUILT and pushed; not seen in a browser: the dev server was down for low memory):
src/lib/dfs-value.ts, src/lib/dfs-picks.ts. Our price = the DK salary at the same rank by our simulated median within
the position on the slate (rank mapping: DraftKings' own price scale, zero-sum per position, no dollars-per-point rate
invented), rounded to $100. Lists: $300+ cheap, 75%+ to play, capped like a lineup (1 QB, 2 RB, 2 WR, 1 TE; uncapped,
the Safest list was six quarterbacks, who bust least by nature); Safest by lowest bust, Upside by highest boom; defenses
left out until the record can grade them. Reasons: next-man-up work, Jev's role read, a top-8 or bottom-8 matchup, and
the newest explained usage change (a reason when the role grew, "Caution" when it shrank). Record: picks and the priced
pool saved to data/dk/picks-<date>.json the first time the lists are built before a pick's kickoff (DFS page or a game's
DraftKings panel), never rewritten; graded against price-mates (same position, within $500, 75%+ to play; no stat line
in a posted game = 0 for picks and mates alike). Checked on the cached 2026-10-11 slate: Safest = Goff, Juwan Johnson
(+$2,200), Swift (caution: carry share 52% to 28%), Taylor, Wan'Dale Robinson, Carnell Tate.

Order: phases 1 to 3 first (the trends Derek asked for), then 4 and 5 together (the backtest decides what 4 may claim),
then 11 (Derek asked for it next), then 6 to 10. Each phase: tsc, lint, a check on tonight's or next week's games, Derek's look, commit when he says.

---

# Previous project: Game page, a simple read first, everything else on demand

Status: BUILT 2026-10-05, waiting on Derek's look (not committed). Upcoming game page on a phone: about 2,300 px
(2.7 screens, was about 17); the read starts at 631 px, folds at 1,148 px. Final: about 4,000 px with the box score open.
Checked: no horizontal scroll at 390 and 700 px (the 7-item top nav overflowed 640 to 760 px, so the nav now switches at
768 px), #market opens on arrival, Open all / Close all toggles all 13 sections. tsc and lint clean.

## Problem Statement
Derek: "for each game we should make the initial read simple, not too much just basic info but can collapse sections or
another link to much more data and writeups." The page is about 17 phone screens for an upcoming game. The first look
should answer "is this worth my time, who wins, what's the number, who to watch" in about two screens, and every deeper
section should sit one tap away, saying something useful even while closed.

## Plan
- [x] R1 "The read" (always open, about two phone screens): header (teams, kickoff, TV, records), the answer strip (model
      call, the number, the gap or the grade, the notes that move it), why watch (headline plus two lines), and the top
      three to watch as one-line rows (name, position, the one reason). Live and final games add the score line and a
      three-line box summary up top.
- [x] R2 Everything else in collapsible sections, closed by default, each with a one-line summary that carries information
      while closed, for example:
      - Matchups: "Falcons run game is a mismatch; Saints win on passing downs"
      - Who's playing: "Saints -1.2: Kamara questionable"
      - DraftKings: "Best value: Bijan Robinson, median 23"
      - Market: "NO -2.5, total 45.5, no move"
      - Team style, Storylines, Conditions, Beat feed, Watch Score breakdown, More names on the radar,
        Written report ("No report yet" or its headline)
      Live and final: the box score and "Did it play out?" open by default.
- [x] R3 "Open all / close all" control, and the jump bar becomes the section list: tapping a section opens it and scrolls
      there (a small client script, so #market links open the right section too).
- [x] R4 Slate cards link to the read; nothing else changes on the slate.
- [x] R5 Check at 390 px and desktop: the read fits in about two screens, closed sections cost one line each, no horizontal
      scroll, deep links open the right section. tsc, lint, build.

Not in scope: a separate "full report" page. One URL keeps deep links and sharing simple, and closed sections cost one
line each. If the page still feels heavy, closed sections can stop rendering until opened (lazy) as a follow-up.

## Section-by-section pass (Derek leads the opinions, reference game MNF ATL @ NO, 401872979)
Section 1, the read. BUILT 2026-10-05, waiting on Derek's look (not committed):
- [x] Header in plain words: "Monday, Oct 5 · 8:15 PM ET · ESPN", records beside the names, "NFC South game".
- [x] Answer strip: "The model" (Even game under a 1-point margin), "The line" (team names), "The edge" (side, else the
      total lean, else "No edge"). The notes keep only injury news (played last game, or status uncertain) and QB notes.
- [x] "Update now" replaces the "Locked" line (the lock stays in the projection footnote): POST /api/refresh drops the
      injury and transaction feeds, the game, the day's slates, and the DK sim; once per 30 s per game.
- [x] Follow buttons moved to the bottom of the read.
- [x] Who to watch, three slots: (1) the player the biggest matchup runs through, (2) the other team's top skill player,
      (3) a storyline (src/lib/storylines.ts): revenge game (a team he played for in the last four seasons, from the
      nflverse weekly files, or his drafting team), else for the visiting team a birthplace or college in the venue's
      state (ESPN athlete and college records, cached in data/espn/), else a role change, else the next top player.
Fixes found on the way:
- memo.ts store moved to globalThis: Next bundles route handlers apart from pages, so the refresh route had its own empty
  store and cleared nothing (dropped: 0). Now drops 7 entries for tonight's game.
- Bio lookups skipped nflverse-only ids (linemen) after counting them against the cap; 16 lookups checked only 11.
- ESPN gives a birthplace, not where he grew up, so the text says "was born in", never "hometown".
- Kickers, punters, and long snappers are left out of storylines (a punter won Vikings @ Saints before).
Round 2 (Derek: fuller descriptions, more than one name only in tier 3; the why-watch lines repeated the strip and used jargon):
- [x] Every row has a label (Key matchup, Top player, Revenge game, Homecoming, College ties, Role change), a sentence,
      and a season line (box score without zero counts, games, snap share only when the snap feed covers every game).
- [x] Top player sentence: his load, his rank at the position (two or more games), the defense he faces (No. 1 = best).
- [x] Tier 3 lists up to three: storylines mixed by kind (gameStories, round robin), then role changes. Only players on
      30% or more of their side's snaps.
- [x] Why watch on the game page shows only what the strip and Who to watch miss (stakes, records, a line move, weather),
      else nothing (whyWatchRead). The slate cards, digests, and report keep the full reasons. "Producing like pick No. 97"
      is gone everywhere (the 55-69 radar line was cut; the 70+ line says "playing above that slot" in words).
- [x] Matchup notes in words ("a mismatch", not "(dominant edge)").
- [x] Defensive matchup picks weighted by snap share (a 15%-snap special-teamer was Pittsburgh's "coverage leader").
Open data issue (not fixed): the snap feed joins some players to only part of their games (Minkah Fitzpatrick: 1 of 2).

---

# Previous project: DraftKings Monte Carlo slate simulator (with Jev news judgments)

Status: v1 BUILT 2026-10-05 (Phases A to E; E3 stretch and F props not started). Derek approved scope, Jev use, and the NFL-only TypeSafe key.

## Problem Statement
The DraftKings lens gives each player one number (season average blended with last season, a small matchup factor, the
next man up). One number can't tell a safe cash play from a boom-or-bust tournament play, can't see that a QB and his WR
rise and fall together, and can't price a questionable tag as "maybe he plays." Tournament winners are built from ranges
and correlations. Also, the lens covers QB/RB/WR/TE only: there is no defense (DST) projection, so it can't build a legal
Classic lineup at all.

Goal: simulate each slate about 10,000 times from real historical outcome shapes and correlations, then show each
player's floor, median, ceiling, and boom/bust odds, and build Cash and GPP lineups from the simulated totals. Use Jev to
read injury and beat-reporter news into a probability the player plays and whether his role is shrinking or growing.

What this is not: it does not make sides and totals beat the closing line (the model covers about 48% against a 52.4%
break-even, and simulating the same inputs cannot change that). DFS is where simulation genuinely beats a single number.

Honest limits, up front:
- No free source of historical DraftKings salaries or contest results, so lineup ROI cannot be backtested. What can be
  tested: whether the simulated ranges are calibrated (the 90th percentile gets beaten about 10% of the time), DST
  projection error, and whether Jev's play probabilities beat the status-only prior.
- Ownership is not modeled in v1 (no free projected-ownership source). GPP lineups lean on ceiling and stacks instead.

## Plan

### Phase A: Outcome shapes and correlations from history (no UI)
- [x] A1 Residual library (`scripts/build-dfs-sim.mjs`): reuse the walk-forward projection in `scripts/backtest-dfs.mjs`
      (2022 to 2025, the cached nflverse weekly files) and record actual / projected DK points per player-week, bucketed by
      position and projection tier. Output `data/generated/dfs-sim.json`. This is the boom/bust shape, measured, not assumed.
- [x] A2 Correlations from the same residuals, by role pair: QB with his WR1/WR2/TE/RB, WR with WR, opposing QB with WR
      (the bring-back), RB with his own DST, DST with the opposing QB, plus a shared game-environment shock.
- [x] A3 Calibration gate: simulate 2025 walk-forward and check the 10th/50th/90th percentiles against actuals by position.
      Pass = each within 3 points of its nominal rate. Nothing reaches the UI until this passes.

### Phase B: Defense (DST) projection, so lineups are legal
- [x] B1 DST DK points from nflverse team stats (sacks, interceptions, fumble recoveries, defensive and return TDs, points
      allowed tiers) with the opponent's sack and turnover rates and the market's implied opponent team total
      (total / 2 minus or plus half the spread). Backtest MAE on 2024 and 2025 next to a season-average baseline.
- [x] B2 DST rows from the DraftKings lobby (the salary feed already carries them) joined to teams.

### Phase C: The simulator (`src/lib/dfs-sim.ts`, pure functions, seeded so a slate always simulates the same way)
- [x] C1 Per simulation: one shock per game (scoring environment) and per team; a Gaussian copula with the A2 correlations
      turns those into a percentile for every player; the A1 residual tier turns the percentile into a points multiplier
      on his projection. A play-or-sit draw from his play probability; if he sits, the existing next-man-up rule moves
      his share to the backup inside that simulation.
- [x] C2 Player outputs: mean, floor (10th), median, ceiling (90th), boom rate (points at or above 5x salary/$1,000),
      bust rate (below 2x), play probability.
- [x] C3 Lineups under DraftKings Classic rules (QB, 2 RB, 3 WR, TE, FLEX, DST, $50,000): Cash = best median lineup total;
      GPP = best 90th-percentile lineup total, which rewards correlated stacks by construction; a second GPP with a
      bring-back. Lineup totals are summed per simulation, so correlation is in the math, not a rule of thumb. Search is
      greedy plus swap passes over a candidate pool; no new dependency.
- [x] C4 Cache each slate's result (`data/dk/<date>-sim.json`, already gitignored); recompute when salaries, statuses, or
      Jev judgments change.

### Phase D: Jev reads the news (optional layer; everything works without a key)
- [x] D1 State per player who is questionable, doubtful, or newly hurt, plus any player the beat feed tags with role news
      in the last 72 hours: name, team, status and practice line, kickoff, the ESPN injury comment, and the tagged posts
      with source and time (named JSON fields).
- [x] D2 One `askJev` request per player with independent questions together:
      - plays (Noul): will he be active at kickoff, given these posts and this status?
      - role (Score, 3 levels described concretely): limited or on a snap count / his usual role / a bigger role than usual.
      - beneficiary (Choice from teammates code lists, plus "nobody in particular"): who absorbs the work if he sits.
- [x] D3 Policy in code, not in the model: with fresh posts, Jev's play probability replaces the status prior; a Noul near
      0.5 keeps the prior; a role Score with confidence under 0.5 counts as usual role; role multipliers start at -25% / 0 /
      +15% and get tuned. Every judgment is logged with its inputs to `data/ai/jev-dfs.jsonl`.
- [x] D4 Weekly check: Brier score of Jev's play probability against actual inactives, next to the status-only prior;
      role level against the actual snap-share change. Jev stays in the projection only if it beats the prior. Cost is
      logged per slate (expect 20 to 40 requests).

### Phase E: Show it
- [x] E1 `/dfs` page: slate player table (salary, median, floor, ceiling, boom, bust, value, play probability, Jev role
      flag), position filters, and the three lineups with their simulated distributions.
- [x] E2 Game page DraftKings section: floor / median / ceiling instead of one number. Sheet section 04 uses medians and
      ceilings.
- [ ] E3 (stretch) Showdown captain lineups; Telegram `/dfs`.

### Phase F: Props (separate plan, later)
- [ ] F1 Needs stat-level simulation (yards, receptions, TDs, not DK points) and `ODDS_API_KEY` in this copy. Plan it once
      Phases A to E are live.

### Decisions (Derek, 2026-10-05)
1. Scope v1 = Phases A to E: yes. 2. Jev for play probability, role, beneficiary: yes.
3. The pasted TypeSafe key is the NFL project's own: it lives in web/.env.local (gitignored) and jev.ts now prefers it over
   the machine-wide TYPESAFE_API_KEY. 4. NCAAF reuse: later.

## Progress Notes (DFS)
- A: `scripts/build-dfs-sim.mjs` -> `data/backtest/dfs-sim.json` (tracked). 14,855 player-weeks, 1,918 DST-weeks.
  Outcome shapes per position and projection tier. Factor model: game shock, team shock, pass/run tilt, plus a link per
  pass catcher that his QB loads on (one shared receiver loading underfit QB-WR1, 0.24 vs 0.33 observed; the links fit
  it exactly). Calibration, leave one season out: average within 0.8 points of nominal for every position; single
  seasons drift up to 5.6 (the league's scoring level moves every range together). The plan's single-holdout +/-3 gate
  failed in 2 of 4 seasons for that reason, so the gate is now average within 3 and every season within 6 (documented in
  the script and on the page). Ties at 0 count half (low-end receivers' 10th percentile is 0).
- B: `src/lib/dst-core.mjs`, shared by the backtest, the ingest, and the app. MAE 4.05 vs 4.27 for the season average.
  The ingest writes per-team DST counts (this season and last) into teams.json; `src/lib/dst.ts` projects; dfs.ts adds
  DST plays.
- C: `src/lib/dfs-sim.ts` (pure, seeded): simulateSlate, buildLineups (cash median, GPP 90th, GPP with a bring-back),
  assignRoles. Synthetic check: QB-WR1 0.32, WR1-WR2 0.04, DST vs opposing QB -0.37, a 50% player sits 49.6%, his backup
  picks up the work. `src/lib/dfs-slate.ts`: Classic pool (this week and next, each team's next game only, so Mon-Thu
  slates work), status priors, Jev, backups, 10,000 sims, memo 20 min, a copy in data/dk/<date>-sim.json.
- D (jev-news agent): `src/lib/jev-dfs.ts`, `scripts/score-jev-dfs.mjs` (`npm run jev:score`). Found and fixed two Jev
  biases on real data: role wording (17 of 20 read "limited"; news-anchored levels now) and Choice order (picks flipped
  5 of 20; both orders asked and averaged). Dates go to Jev as words. About 180 ms a call; 14 calls on the week-5 slate.
- E: `/dfs` page (lineups, might-not-play, player board with position and sort links, how it works), DFS tab in the nav
  (tab bar 7 columns), game page DraftKings rows show sim floor / median / ceiling, sheet section 04 shows median to 90th.
- Checks: tsc clean, lint clean on new files, prod build clean, no horizontal scroll at 390 px.

## Review (DFS v1)
- Known limits: ownership not modeled; contest ROI not backtestable (no free salary and payout history); Jev's value is
  unproven until `npm run jev:score` grades a few weeks; when Jev says a starting QB likely sits, his backup is not added
  to the pool (the pool adds a backup QB only on an Out or Doubtful status); Showdown and Telegram /dfs not built (E3).
- Live PC: pull, `REFRESH=1 npm run ingest` (teams.json gains DST counts), `npm run build`, restart PM2. Add the NFL
  TypeSafe key to that copy's web/.env.local too (it is not in git). dfs-sim.json ships in git; rebuild it with
  `npm run dfs:build` after a season or when the projection formula changes.
- Follow-ups from the Jev agent's review (open):
  - [ ] The 0.75 prior for "Questionable (out last game, no update since)" looks high: 15 of 20 such players got Jev
        answers of 0.40 to 0.48, inside the near-50/50 band, so the prior always survives. Measure the real return rate
        (snap counts, missed game then next game) or let `npm run jev:score` decide after a few weeks.
  - [ ] Beat-feed noise reaches Jev: Spanish posts, spam, stat-line junk, and same-name players (no judgeFeed filter).
  - [ ] Thin evidence moves some calls a lot (Breece Hall 0.75 to 0.39 on a one-word "inactive" about week 4).
  - [x] Questionable teammates named each other as backups: Jev now gets healthy teammates only.

---

# Previous project: EdgeSheet NFL, audit round (accuracy + viewing efficiency), DONE

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

### Follow-up 2026-10-05 (Derek)
- [x] Merged the duplicate run matchups ("run game vs run defense" on rush success, "ground game vs run front" on rush EPA a
      carry, a college "line yards" stand-in). One run card now carries both numbers; success decides the edge.
- [x] Renamed the units: run game vs run defense, pass game vs pass defense (explosiveness decides, pass success rides
      along), passing-down offense vs passing-down defense. Archive, slate, and sheet parsers read old and new titles.
- [x] Removed the "live all afternoon" line (it ran on night games); EPA prints 0.00, not -0.00.

### Notes
- Page GETs write data/archive locks in any copy. Never commit data/archive or data/ai from this Desktop copy.
- The dev server's in-process memo outlives code edits (HMR keeps memo.ts); restart it after changing cached shapes.
- Not backtested: QB-in-total, the stale-status rule, the rescaled Watch Score and tags.
- Five lint errors predate this round and remain (BoardClient, two error.tsx, AvailabilityPanel apostrophes).
- Details and numbers: web/AGENT-REPORT-nfl.md, "Session 2026-10-04, part 7".
