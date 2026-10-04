# EdgeSheet NFL (web)

Next.js 16 app. See the repo README for the overview and `AGENT-REPORT-nfl.md` for status, PM2, and Telegram setup.

```
npm run ingest            # nflverse digests into data/generated (REFRESH=1 to re-download)
npm run dev               # port 3100
npm run build             # prebuild runs the ingest
npm run backtest          # Elo vs closing line, 2022 to 2025, writes data/backtest/results.json
npm run odds:dry          # Odds API matcher check, 0 credits
npm run odds:snapshot     # one Odds API slate call (3 credits)
npm run guides            # AI watch guides for today's games
npm run reports           # AI written reports
npm run sheet:send        # render the Sunday sheet PNG and send it to Telegram
npm run telegram:bot      # long-running bot (PM2 nfl-telegram)
npm run telegram:chat-id  # print your chat id after messaging the bot
```

## Consensus of projection systems

The game page shows the EdgeSheet projection (our Elo plus unit edges) as the headline, then an "Other systems" table: ESPN FPI (fetched from ESPN's power index endpoint), our Elo alone (`scripts/lib/elo.mjs`: start 1500, one-third regression each season, K 20, 48 Elo points of home field, margin multiplier, 25 Elo per point), and the EPA model (each offense's EPA per play against the other defense over the game's pace). The posted line is the reference row. The consensus median and side are locked pregame and graded on the Record page. Code: `src/lib/consensus.ts`, `src/components/ConsensusTable.tsx`.

## Watch Score

`src/lib/score.ts`: competitive expectation 30%, unit mismatches 25%, rookie and breakout density 15%, stakes 20%, availability 10%. Null components are excluded and the weights renormalize.
