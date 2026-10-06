import Link from "next/link";
import { TERMS } from "@/lib/terms";
import { COLS, TEAM_COLS } from "@/lib/leader-cols";
import { genMeta } from "@/lib/generated";

export const metadata = {
  title: "Index · EdgeSheet NFL",
  description: "Everything EdgeSheet uses: the websites and feeds, the data files, the stats and what they mean, the models, what the backtests said, and when it all updates.",
};

/**
 * The index (Derek: "the stats that we use, the websites that we use, the information, the data, everything"). One
 * page, summaries first; long lists fold open. Sources were read off the code (every URL the app and scripts fetch);
 * backtest numbers come from data/backtest/*.json. Update this page when a source, model, or verdict changes.
 */

const SECTIONS = [
  ["sources", "Websites and feeds"],
  ["files", "Data files"],
  ["models", "Models"],
  ["backtests", "What the backtests said"],
  ["stats", "Stats glossary"],
  ["pages", "Pages"],
  ["schedule", "When it updates"],
] as const;

type Source = { name: string; url: string; what: string; when: string; key: string };
const SOURCES: Source[] = [
  { name: "nflverse", url: "https://github.com/nflverse/nflverse-data/releases", what: "The backbone. Schedules and closing lines since 1999, every play since 1999 (EPA, success, CPOE), weekly player and team stats, rosters, injuries, depth charts, snap counts, draft picks, combine, trades, PFR charting, Next Gen Stats, FTN charting, play participation.", when: "Ingested Tuesdays (files move Monday and Tuesday)", key: "None, free" },
  { name: "ffverse (ffopportunity)", url: "https://github.com/ffverse/ffopportunity", what: "Expected fantasy points per player per week: what a player's targets, carries, and field position were worth.", when: "With the nflverse ingest", key: "None, free" },
  { name: "ESPN", url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl", what: "Live scores and game state, broadcasts, the live injury list with news lines, transactions, FPI, player bios (birthplace, college) and headshots.", when: "Live, cached a few minutes", key: "None" },
  { name: "The Odds API", url: "https://the-odds-api.com", what: "Current spreads, totals, moneylines, and player props from the books.", when: "Every 6 hours Thursday to Monday (PM2 nfl-odds)", key: "Yes (shared credits with the college app)" },
  { name: "DraftKings", url: "https://www.draftkings.com/lobby", what: "Contest lobby and player salaries for the Classic and Showdown slates.", when: "When salaries post, refreshed with the DFS page", key: "None" },
  { name: "National Weather Service", url: "https://api.weather.gov", what: "Kickoff forecasts for outdoor stadiums: wind, rain, snow, temperature.", when: "Game week, by forecast", key: "None" },
  { name: "Beat feed: Bluesky, Reddit r/nfl, Google News", url: "https://bsky.app", what: "Beat-reporter posts and headlines for role news and sleepers (Jev reads them into chips).", when: "Live on the feed and game pages", key: "None" },
  { name: "YouTube", url: "https://www.youtube.com", what: "A highlights search link on the feed; a video embed only when a YouTube Data API key is set.", when: "On demand", key: "Optional" },
  { name: "Jev (local model router)", url: "http://localhost:3210", what: "Reads news into play probabilities and role changes, writes watch guides. Kept only where it beats the plain status prior.", when: "On demand", key: "Local" },
  { name: "Telegram", url: "https://core.telegram.org/bots", what: "Sends the slate and the leans to Derek's phone (PM2 nfl-telegram).", when: "On demand", key: "Bot token" },
  { name: "College EdgeSheet", url: "http://localhost:3000/draft", what: "Next year's draft class and the college forecast board (linked, not copied).", when: "Separate app", key: "None" },
];

const FILES: [string, string][] = [
  ["schedules/games.csv", "Every game 1999 to now: score, closing spread and total, moneylines, roof, surface, rest days, ESPN id."],
  ["pbp/play_by_play_<season>", "Every play: EPA, success, down and distance, field position, air yards, CPOE, expected YAC, pass rate over expected."],
  ["stats_player/stats_player_week_<season>", "Each player each week: passing, rushing, receiving, defense, kicking, EPA, target and air-yards share."],
  ["stats_team/stats_team_week_<season>", "Each team each week, for team totals and defense against position."],
  ["rosters/roster_<season>, weekly_rosters", "Who is on each team (with ESPN, PFR, and Sleeper ids), and who joined or left by week."],
  ["injuries/injuries_<season>", "The official injury report: game status and practice participation."],
  ["depth_charts/depth_charts_<season>", "The latest depth chart: who is the starter."],
  ["snap_counts/snap_counts_<season>", "Offense and defense snap share per player per game."],
  ["draft_picks/draft_picks.csv", "Every draft pick with round, pick, team, and position (2017 to now used)."],
  ["combine", "40, vertical, broad jump, 3-cone, shuttle, bench."],
  ["trades", "Every trade with its date."],
  ["pfr_advstats (pass, rush, rec, def)", "Pro Football Reference charting: pressures, hurries, missed tackles, coverage allowed, yards before and after contact, drops, bad throws."],
  ["nextgen_stats (passing, rushing, receiving)", "NFL tracking: time to throw, CPOE, aggressiveness, rush yards over expected, 8-man boxes, separation, YAC over expected."],
  ["ftn_charting", "FTN charting: blitzers, pass rushers, play action, motion, screens."],
  ["pbp_participation", "Who was on the field on each play: coverage shells and man or zone (2023 to 2025)."],
  ["ffopportunity ep_weekly", "Expected fantasy points per player per week."],
];

type Model = { name: string; what: string; inputs: string; where: string };
const MODELS: Model[] = [
  { name: "Game projection (side and total)", what: "Who wins and by how much, and how many points.", inputs: "Elo ratings (home field included), 40% of the unit matchup edges, injury points from Who is playing (QB swap on 5 seasons of EPA), and for the total each offense's EPA per play against the other defense, both teams' pace, and a weather tilt.", where: "Game page, clean sheet, Record" },
  { name: "The gap", what: "How far the model sits from the posted spread or total. Called a gap, never a pick.", inputs: "Projection against the current line. 2+ points on the side or 2.5+ on the total is a gap; 4+ and 5+ a big gap.", where: "Game page, clean sheet" },
  { name: "Who is playing (availability)", what: "Points each team loses or gains from who is out.", inputs: "ESPN live list, the official report, practice lines, snap shares, and each player's value; a starting QB change is priced from his EPA.", where: "Game page Injuries, model" },
  { name: "DraftKings projection", what: "Each player's expected DK points and our price.", inputs: "DK points a game blended with last season (3-game prior), expected fantasy points at half weight, a quarter of the defense-against-position matchup, and the next-man-up bump (RB 25%, TE 20%, WR none).", where: "DFS page, game page DraftKings" },
  { name: "DFS simulator", what: "10,000 simulated slates for ranges, bust rates, and lineups.", inputs: "Historical outcome shapes and correlations (QB with his receivers, opposing players), game environment shocks, DST model.", where: "DFS page" },
  { name: "Watch Score (games)", what: "How worth watching a game is, 0 to 100. Not a bet signal.", inputs: "Competitive (30), unit mismatches (25), stakes (20), rookie and breakout density (15), national TV (10).", where: "Full slate, game page" },
  { name: "Radar score (players)", what: "How worth watching a player is. Not a grade.", inputs: "Production percentile at his position (50%), snap share percentile (30%), context (20%: breakout, against the slot, starter).", where: "Radar, game page" },
  { name: "Against the slot", what: "Is a rookie or second-year player beating his draft range?", inputs: "His DK (offense) or IDP (defense) points per team game against every player drafted in the same range at the position he plays since 2018, same career season, same point of the season.", where: "Rookies, player page" },
  { name: "Unit matchups", what: "Which unit wins: run game against run defense, pass game against pass defense, passing downs.", inputs: "Play-by-play success rate, EPA, explosiveness, ranked among the 32 teams, offense against the other defense.", where: "Game page Matchups, clean sheet" },
  { name: "Pass rush chance", what: "Model chance a pass rusher gets half a sack or more.", inputs: "PFR pressures with the opponent's pressure allowed at half weight.", where: "Game page Defense, DFS" },
  { name: "Fourth-down calls", what: "Whether a coach's go, kick, or punt matched the best call, in win probability.", inputs: "A win-probability model distilled from nflfastR and 2018 to 2025 go, field goal, and punt outcomes.", where: "Game page Fourth downs (after kickoff)" },
  { name: "Standings and playoff odds", what: "Seeds with the official tiebreakers, playoff chances.", inputs: "The full NFL tiebreak chain and Elo simulations of the rest of the season.", where: "Standings" },
  { name: "Coverage", what: "How each defense plays (man, zone, two-deep) and how receivers do against it.", inputs: "Play participation 2023 to 2025.", where: "Game page Matchups" },
];

type Test = { name: string; result: string; verdict: "Used" | "Context only" | "Not used" };
const TESTS: Test[] = [
  { name: "Model side against the spread (2022 to 2025, 1,139 games)", result: "Covered about 48% against the closing line; no gap size beat 52.4%. Picks the winner 64% of the time.", verdict: "Context only" },
  { name: "Model total (959 games)", result: "Hit 48% on the over/under; no gap size beat 52.4%.", verdict: "Context only" },
  { name: "Expected fantasy points in the DK projection (8,209 player-weeks)", result: "Miss fell from 6.52 to 6.46 points at half weight.", verdict: "Used" },
  { name: "Pass rush from pressures (12,394 rusher-weeks)", result: "Better than sacks alone (Brier 0.179 vs 0.196).", verdict: "Used" },
  { name: "Next man up", result: "Backups gained 28% of an out back's average, 23% of a tight end's, about none of a receiver's.", verdict: "Used" },
  { name: "Defense against position", result: "A quarter weight helped; more hurt.", verdict: "Used" },
  { name: "Efficiency stats in the DK projection (2022 to 2025)", result: "Rush success barely predicts later DK points (0.05); did not lower the projection's miss. QB EPA a dropback is the stickiest (0.52).", verdict: "Context only" },
  { name: "Against the slot baselines", result: "Production falls with draft range at every position; a rookie's first 4 games match the rest of his season (0.75 over 635 rookies).", verdict: "Used" },
  { name: "Standings tiebreakers (2019 to 2025)", result: "Matched all 96 playoff teams and seeds.", verdict: "Used" },
  { name: "Coverage carry-over", result: "Two-deep rate carries over (0.49); a receiver's man/zone split weakly (0.19); man rate does not.", verdict: "Used" },
  { name: "Primetime unders as a bet", result: "56.7% in 2019 to 2025 but about 49 to 52% in other eras and 2024 to 2026.", verdict: "Not used" },
  { name: "Referee totals", result: "No carry-over; betting the tendency hit 49.9% on 1,502 games.", verdict: "Not used" },
  { name: "Storylines: revenge, homecoming, college ties (38,030 games)", result: "Nothing passed; revenge games beat a player's average 45% of the time. Good stories, not edges.", verdict: "Context only" },
  { name: "Player splits (home, division, primetime, short week)", result: "Only a player's home/away split carries over, weakly (about a fifth repeats).", verdict: "Context only" },
  { name: "\"Loves playing them\" (past games against a team)", result: "No relationship (0.00 over 9,572 games).", verdict: "Not used" },
];

const PAGES: [string, string, string][] = [
  ["/", "Slate", "The clean sheet: every game of the week with a short summary; Full slate for every number by day."],
  ["/game/…", "Game page", "Everything on one game: injuries, the model and the gap, who to watch, matchups, defense, DraftKings, splits, conditions, fourth downs."],
  ["/radar", "Radar", "Players worth watching across the league."],
  ["/dfs", "DFS", "Our DraftKings prices, value picks, simulated ranges, lineups."],
  ["/leaders", "Leaders", "Passing, rushing, receiving, and team efficiency boards: EPA, success, explosive plays, CPOE, and more."],
  ["/standings", "Standings", "Divisions, seeds with tiebreakers, playoff odds."],
  ["/rookies", "Rookies", "The class in draft order with production against the slot."],
  ["/history", "Record", "Every locked call and how it graded."],
  ["/watchlist", "Watchlist", "Players you follow."],
  ["/feed", "Feed", "Beat-reporter posts and sleepers."],
  ["/backtest", "Backtest", "How the Elo did on past seasons."],
  ["/ask", "Ask", "Ask a question about the slate."],
];

const SCHEDULE: [string, string][] = [
  ["Tuesday", "npm run ingest: nflverse and ffverse files, then extras, leaders, and the rookie baselines. Rebuild and restart nfl."],
  ["Thursday to Monday, every 6 hours", "Odds snapshot from The Odds API (PM2 nfl-odds)."],
  ["Wednesday to Friday", "Official injury reports post; the injuries fold switches from last week's report to this week's."],
  ["Every page load", "ESPN scores, game state, and the live injury list (cached a few minutes)."],
  ["Before each kickoff", "The model's call is locked into the Record; graded after the final."],
];

const TERM_LABEL: Record<string, string> = {
  passRate: "Pass rate", earlyPass: "Early-down pass rate", sr: "Success rate", ex: "Explosiveness", rushSr: "Rush success rate", passEx: "Pass explosiveness",
  ly: "Run game EPA", pdSr: "Passing-downs success", pressure: "Pressure rate", blitz: "Blitz rate", playAction: "Play-action rate", rzTd: "Red zone TD rate",
  matchups: "Matchups", dvp: "DraftKings points allowed", model: "The model", edge: "The gap", trendMetrics: "Trends", playCalling: "Play calling",
  production: "Production", snapShare: "Snap share", draftSlot: "Draft slot score", size: "Size", vsSlot: "Against the slot", watchScore: "Watch Score",
  vacated: "Vacated work", whoToWatch: "Who to watch", splits: "Splits", vsOpponent: "Against an opponent", storyGames: "Storyline games",
  ourPrice: "Our price", valuePicks: "Value picks", sleepers: "Sleepers", dfs: "DraftKings",
};

const VERDICT_STYLE: Record<Test["verdict"], string> = { Used: "bg-turf text-white", "Context only": "bg-ink-2 text-chalk", "Not used": "bg-brick text-white" };

export default function IndexPage() {
  const meta = genMeta();
  return (
    <div>
      <p className="eyebrow">Index{meta ? ` · data as of ${new Date(meta.ingestedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">Everything we use</h1>
      <p className="mt-1 max-w-3xl text-sm text-chalk-3">
        Where the data comes from, what the stats mean, what the models do, and what the backtests said about each one. Nothing on the site is invented; when something is missing, the page says so.
      </p>
      <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="chip !py-1 !text-[12px]">{label}</a>
        ))}
      </nav>

      <Section id="sources" title="Websites and feeds" lead={`${SOURCES.length} sources. Free and public unless it says a key is needed.`}>
        <ul className="grid gap-2 md:grid-cols-2">
          {SOURCES.map((s) => (
            <li key={s.name} className="card p-3">
              <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold text-chalk hover:text-sky">{s.name}</a>
              <p className="mt-0.5 text-sm text-chalk-2">{s.what}</p>
              <p className="mono mt-1 text-[11px] text-chalk-3">{s.when} · key: {s.key}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="files" title="Data files" lead="The nflverse and ffverse files we download, cached on this PC and digested into the site's data. Seasons back to 2018 for players, 1999 for games and plays.">
        <Rows rows={FILES} mono />
      </Section>

      <Section id="models" title="Models" lead="What each model does, what goes into it, and where it shows. None of them is a pick unless a backtest says so (see below).">
        <ul className="grid gap-2 md:grid-cols-2">
          {MODELS.map((m) => (
            <li key={m.name} className="card p-3">
              <p className="font-semibold text-chalk">{m.name}</p>
              <p className="mt-0.5 text-sm text-chalk-2">{m.what}</p>
              <p className="mt-1 text-xs text-chalk-3"><span className="font-semibold text-chalk-2">Inputs: </span>{m.inputs}</p>
              <p className="mono mt-1 text-[11px] text-chalk-3">Shows on: {m.where}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="backtests" title="What the backtests said" lead="Every model change is tested on past seasons first. Used means it earned its place; context only means it is shown but does not move a number; not used means it failed. Nothing is called strong or an edge without beating 52.4% against the spread or total.">
        <ul className="divide-y divide-line">
          {TESTS.map((t) => (
            <li key={t.name} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_7rem] sm:items-baseline sm:gap-3">
              <span className="text-sm font-semibold text-chalk">{t.name}</span>
              <span className="text-sm text-chalk-2">{t.result}</span>
              <span className={`w-fit rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider sm:justify-self-end ${VERDICT_STYLE[t.verdict]}`}>{t.verdict}</span>
            </li>
          ))}
        </ul>
        <p className="mono mt-2 text-[11px] text-chalk-3">Full numbers: data/backtest/*.json; rerun with npm run backtest:qb, :total, :xfp, :pressure, :nextman, :efficiency, :primetime, :seed, :coverage, :fourth, :stories, :splits.</p>
      </Section>

      <Section id="stats" title="Stats glossary" lead={`Every stat and term on the site in plain words: ${Object.keys(TERMS).length} site terms and ${COLS.passing.length + COLS.rushing.length + COLS.receiving.length + TEAM_COLS.length} Leaders columns. Click a group to open it.`}>
        <Fold title="Site terms (the i tips)" count={Object.keys(TERMS).length} open>
          <Rows rows={Object.entries(TERMS).map(([k, v]) => [TERM_LABEL[k] ?? k, v])} />
        </Fold>
        {(["passing", "rushing", "receiving"] as const).map((t) => (
          <Fold key={t} title={`Leaders: ${t}`} count={COLS[t].length}>
            <Rows rows={COLS[t].map((c) => [c.label, c.help])} />
          </Fold>
        ))}
        <Fold title="Leaders: teams" count={TEAM_COLS.length}>
          <Rows rows={TEAM_COLS.map((c) => [c.label, c.help])} />
        </Fold>
      </Section>

      <Section id="pages" title="Pages" lead="What each page is for.">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {PAGES.map(([href, label, what]) => (
            <li key={href} className="text-sm">
              {href.includes("…") ? <span className="font-semibold text-chalk">{label}</span> : <Link href={href} className="font-semibold text-chalk hover:text-sky">{label}</Link>}
              <span className="text-chalk-2">: {what}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="schedule" title="When it updates" lead="Running on this PC under PM2: nfl (the site, port 3100), nfl-telegram (the bot), nfl-odds (the odds job).">
        <Rows rows={SCHEDULE} />
      </Section>
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-20">
      <div className="flex items-baseline gap-3">
        <h2 className="display text-3xl font-bold text-chalk">{title}</h2>
        <span className="h-px flex-1 bg-line" />
      </div>
      <p className="mt-1 max-w-3xl text-sm text-chalk-3">{lead}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Rows({ rows, mono }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-0.5 py-1.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3">
          <dt className={`min-w-0 text-sm font-semibold text-chalk [overflow-wrap:anywhere] ${mono ? "mono !text-xs" : ""}`}>{k}</dt>
          <dd className="text-sm text-chalk-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Fold({ title, count, open, children }: { title: string; count: number; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="card mt-2 p-3" open={open}>
      <summary className="cursor-pointer select-none font-semibold text-chalk">
        {title} <span className="mono text-xs font-normal text-chalk-3">{count}</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
