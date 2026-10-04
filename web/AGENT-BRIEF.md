# EdgeSheet NFL: read this first

This repo is the NFL version of EdgeSheet, cloned from the college app on 2026-10-03. The college brief below still applies
(never invent a player, stat, or line; no emojis; no em dashes; light theme; plain English), with these differences:

- Data layer is nflverse (`scripts/ingest.mjs`), no CollegeFootballData, no key. Team join key is the nickname ("Chiefs");
  `abbr` is the ESPN abbreviation (LAR, WSH); `code` is the nflverse code (LA, WAS). See `data/nfl-teams.json`.
- Division is always "NFL" and there is nothing to filter by level. Ranks are inside the 32.
- The radar is a Watch radar with tiers Rookie, Breakout, Matchup, Watch (`src/lib/radar.ts`). No recruiting, no draft forecast.
- Scout Score is the Watch Score (`src/lib/score.ts`). Elo is ours (`scripts/lib/elo.mjs`), FPI comes from ESPN.
- Port 3100. PM2 names `nfl`, `nfl-telegram`, `nfl-odds`. Odds API credits are shared with the college app: snapshot every 6 hours Thu to Mon.
- Team nicknames are plural: "the Chiefs lead", "the Seahawks are No. 1". Keep sentence verbs plural.

Status and next steps: `AGENT-REPORT-nfl.md`.

---

# EdgeSheet build brief (shared by all agents)

You are one of several agents working IN PARALLEL in the same working tree on this Next.js 16 app
(`C:\Users\derek\OneDrive\Desktop\ASTRA_TESTING\college-game-scout\web`). Read this whole file first.

## What the app is
College football game discovery through an NFL scouting lens. Pick any game and know why it is worth watching,
who NFL scouts are looking at by draft class, how the teams play, what the model projects, and whether the call played out.
Owner: Derek. Product name is now **EdgeSheet** (was Scout the Slate).

## Hard rules
- NEVER invent a player, stat, scheme, line, or quote. Every number shown must come from a source row. If data is missing, say so in the UI ("not available", "unmeasured"). This is the product's core promise.
- No emojis anywhere. No em dashes (use commas, periods, or "to"). Plain English. No AI-sounding filler.
- Light theme, sleepers.app style. Use the existing tokens/classes: `card`, `chip`, `seg`, `eyebrow`, `display`, `mono`, `meter`,
  colors `text-chalk` (navy text), `text-chalk-2`, `text-chalk-3` (muted), `bg-panel`, `bg-panel-2`, `bg-ink-2`, `border-line`,
  accents `text-navy`/`bg-navy`, `text-sky` (link blue), `text-turf` (green, good/live), `text-brick` (red, bad/final), `text-warn` (yellow).
  Rounded 4px cards with hairline borders. Display font is condensed (Barlow Semi Condensed), body is Source Sans.
- Server components by default. Only use `"use client"` for interactivity. Client components cannot import `node:fs` modules
  (`generated.ts`, `archive.ts`, `declarations.ts`, `memo.ts` users). Pass plain data as props.
- Everything that goes to the browser must be JSON-serializable plain objects (no Map/Set in Game or props).
- Do NOT run `next build`, do NOT restart pm2, do NOT `git commit`, do NOT run `npm run ingest` (rate limits). Type-check with
  `npx tsc --noEmit` only. The orchestrator builds, restarts, and commits at the end.
- CollegeFootballData free tier returns 429 if you fire many calls at once. Any script you write must call sequentially with a
  small pause and retry on 429 with backoff (see `scripts/ingest.mjs` for the pattern). Responses over 2MB bypass the Next fetch
  cache; use `memo()` from `src/lib/memo.ts` or write digests to `data/generated/`.
- The CFBD key is in `.env.local` as `CFBD_API_KEY`. Other keys may be absent right now: `TELEGRAM_BOT_TOKEN`, `ODDS_API_KEY`,
  `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`. Code must degrade gracefully and tell the user in the UI what key is missing.
- Shared files you may need to touch: `src/lib/slate.ts` (builds Game objects), `src/lib/types.ts`, `src/app/game/[id]/page.tsx`,
  `src/app/layout.tsx` (NAV list), `src/app/history/page.tsx`, `src/lib/archive.ts`. Other agents edit these at the same time.
  ALWAYS Read the file immediately before each Edit, make the smallest additive edit possible (add an optional field, add an import,
  add one section/component call), never rewrite or reformat these files, never remove other people's code. If an Edit fails
  because the text changed, re-read and retry. Prefer putting your logic in NEW files under `src/lib/<yours>.ts`,
  `src/components/<Yours>.tsx`, `src/app/<yours>/page.tsx`.
- When you finish, write `AGENT-REPORT-<yourname>.md` in `web/` with: what you built, files touched, how to verify, any key needed,
  known gaps, and ideas you had along the way (Derek wants to hear new ideas).

## Architecture you need to know
- `scripts/ingest.mjs` writes `data/generated/{players,teams,draft,meta}.json` from CFBD (rosters, season stats, usage, recruiting,
  advanced team stats FBS-only, 5 drafts). `src/lib/generated.ts` reads them (memoized by mtime).
- `src/lib/radar.ts`: scouting radar. Scores players 0..100 from production percentile (vs same position, same division),
  pedigree (recruiting stars), usage share, NFL size norms, scaled by level (FBS 1, FCS .72, DII .5, DIII .38). Tiers Eligible/Future/Sleeper/Watch.
  `radarIndex()`, `radarForTeam(school)`, `radarPlayer(id)`, `radarBoard(filter)`. Player ids are CFBD athlete ids, which are ESPN athlete ids.
- `src/lib/tendencies.ts`: team style from advanced stats with ranks inside the division; `unitEdges(off, def)` four axes
  (rush success, pass explosiveness, line yards, passing-downs success) with percentile gaps; `pressurePoint`, `styleContrast`, `leagueMeans`.
- `src/lib/projection.ts`: projected outcome. Margin = 60% pregame Elo (+65 home) + 40% net unit edges; win prob at sigma 16;
  model total from EPA per play vs opposing defense over pace; weather tilt; side lean and total lean vs market.
- `src/lib/forecast.ts`: 2027 draft forecast, supply (radar) vs demand (5-year position averages); bands; estimated pick; `src/lib/declarations.ts` for declared/returning.
- `src/lib/archive.ts`: accountability. `lockPregame(game, season)` writes `data/archive/<season>/<gameId>.json` before kickoff;
  `gradePostgame(game, season, box, excitement)` grades edges, radar names, projection, side, total after the final. `listEntries`, `historyStats`.
- `src/lib/slate.ts`: `getSlate(date)` builds the day's games (CFBD games/lines/media/teams/venues/records/rankings + NWS weather for D1),
  `getGame(id)` builds one with box score and archive, `getPlayer(id)`, `gameIndexForWeek()`. Game type in `src/lib/types.ts`.
  Status is schedule-based today: `live` = started and not completed, with no score (free tier has no live feed). That is what the ESPN agent fixes.
- `src/lib/boxscore.ts`: CFBD games/players per week/classification, memoized. `src/lib/nws.ts`: forecasts. `src/lib/cfbd.ts`: typed fetchers.
- Pages: `/` slate, `/game/[id]`, `/radar`, `/player/[id]`, `/rankings`, `/draft`, `/history` (Record), `/watchlist`. Mobile tab bar + desktop nav come from `NAV` in `layout.tsx` and `src/components/NavLinks.tsx`.
- Components: `GameCard`, `ProspectCard` (+ `RadarScore`), `Avatar` (jersey circle + logo; the ESPN agent adds headshots), `badges` (`CoverageBadge`, `StatusPill`, `DivisionTag`, `Tier`, `Confidence`), `FollowButton`, `DecisionButtons`, `NavLinks`.
- Game page section order: Why watch, Where the game gets decided (pressure point, 4 matchups with logos, Projected outcome box),
  Draft radar, Keep an eye on, Live/Who showed up (+ Did it play out), Team style, Conditions, Market (+ What the stats say box), Storylines, Score. Sticky jump bar with ids: why, decided, radar, eye, showed, style, conditions, market, storylines, score.
- Server runs under PM2 as `scout` on port 3000 (do not restart it). Verify your work with `npx tsc --noEmit` and, for scripts, by running them.

## Division I only
Everything new is for FBS and FCS. Lower divisions keep today's behavior.

## Round 2 (2026-10-03 night): presentation pass and the next layer

Everything from round 1 is live (ESPN live feed, consensus, situations, beat feed, odds, AI reports and Ask, Telegram, portal, backtest).
Keys now in `.env.local`: CFBD_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ODDS_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY.
LLM adapter is `src/lib/llm.ts` (Anthropic: claude-opus-5 for reports, claude-sonnet-5 when `small: true`). Slate is Division I only, grouped Top 25 first.
PM2: `scout` (site), `scout-telegram`, `scout-odds`. Still do not build, restart, commit, or run `npm run ingest`.

### TypeSafe Jev (new)
Jev is a System One judgment model: send `state` (JSON) plus typed questions and get calibrated probabilities back, fast and cheap. It does NOT
generate text. Three primitives: Choice (pick one option, probabilities per option, confidence), Score (ordered descriptive levels), Noul (probability
that a yes/no condition holds). Read https://docs.typesafe.ai/llms.txt, then https://docs.typesafe.ai/api.md and https://docs.typesafe.ai/sdk/javascript.md
before writing any call. Batch independent questions over the same state in ONE request (speculative fan-out). Key: `TYPESAFE_API_KEY`.
A shared client will live at `src/lib/jev.ts` (owned by the `jev` agent): `askJev(state, questions)` plus helpers. If it does not exist yet when you need it,
write your call against the documented JS SDK directly and keep it behind a try/catch so the feature works without Jev.
Good uses here: classify a feed post (injury / availability / praise / demotion / unrelated as separate Nouls), confirm a name match refers to
the player at that team (Noul), rank candidate "things to watch" by how compelling they are to a neutral diehard fan (Score), verify a report
sentence is supported by its evidence (Noul per sentence), rank live games by "worth flipping to right now" (Score). Code keeps the policy and thresholds.

### Voice for anything written for the fan
Derek's words: "shown from the perspective of a diehard fan watching, someone who's never really seen each team, where they can explain: hey you got
to see this player, or what they do here on defense, or how they handle this." Specific, confident, numbers inside the sentence, tells you WHAT to look for
and WHEN. No hedging, no filler, no emojis, no em dashes.
