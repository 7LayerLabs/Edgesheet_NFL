import Link from "next/link";
import { notFound } from "next/navigation";
import Image from "next/image";
import { getGame } from "@/lib/slate";
import { COMPONENT_KEYS, COMPONENT_LABELS, WEIGHTS, availableWeight, prospectCounts, scoreTag, scoutScore } from "@/lib/score";
import { evaluateWeather } from "@/lib/weather";
import { axisLabel, componentPhrase } from "@/lib/stadiums";
import { baselineLine } from "@/lib/climate";
import { asOf, etDateOf, kickoffTime, mlText, moveText, spreadText } from "@/lib/format";
import type { DefenseProfile, Game, OffenseProfile, Prospect, Team } from "@/lib/types";
import { CoverageBadge, StatusPill } from "@/components/badges";
import { ScoutScore } from "@/components/ScoutScore";
import { FollowButton } from "@/components/FollowButton";
import { ProspectCard } from "@/components/ProspectCard";
import { LineMovement } from "@/components/LineMovement";
import { PropsForRadar } from "@/components/PropsForRadar";
import { LivePanel } from "@/components/LivePanel";
import { LivePoller } from "@/components/LivePoller";
import { WrittenReport } from "@/components/WrittenReport";
import { ConsensusTable } from "@/components/ConsensusTable";
import { Suspense } from "react";
import { BeatFeed, BeatFeedFallback } from "@/components/BeatFeed";
import { SleepersPanel } from "@/components/SleepersPanel";
import { SituationalCues, SituationsTable } from "@/components/Situations";
import { DfsPanel } from "@/components/DfsPanel";
import { AvailabilityPanel } from "@/components/AvailabilityPanel";
import { FoldControls } from "@/components/FoldControls";
import { UpdateNow } from "@/components/UpdateNow";
import { InfoTip } from "@/components/InfoTip";
import { TERMS } from "@/lib/terms";
import { TrendsPanel, type TrendsTeam } from "@/components/TrendsPanel";
import { changeText, teamTrends, topChange } from "@/lib/trends";
import { vacatedFor } from "@/lib/vacated";
import { splitsNotes, storiesSummary } from "@/lib/backtest-notes";
import { dstSplits, teamSplits } from "@/lib/splits";
import { SplitsTable } from "@/components/SplitsTable";
import { defenseVsPosition } from "@/lib/dfs";
import { teamByShort } from "@/lib/nfl";
import { absentWords } from "@/lib/availability";
import { inputsLabel, LEAN_BACKTEST_NOTE, sideTier, tierLabel, totalTier } from "@/lib/leans";
import { readReport, seasonOf } from "@/lib/report";
import { publishedGuide } from "@/lib/watchguide";
import { WatchGuide } from "@/components/WatchGuide";
import { CoveragePanel } from "@/components/CoveragePanel";
import { InjuryReport } from "@/components/InjuryReport";
import { injuriesFor, injurySummaryLine, starterOut } from "@/lib/injuries";
import { FourthDowns } from "@/components/FourthDowns";
import { fourthDownsFor, type FourthDown } from "@/lib/fourth";

export const dynamic = "force-dynamic";

const TIERS: Prospect["tier"][] = ["Matchup", "Rookie", "Breakout", "Watch"];
const DEFENSE_TIER_TITLE: Record<Prospect["tier"], [string, string]> = { Matchup: ["What to watch on defense", "the defender each defensive edge puts on the spot"], Rookie: ["Defensive rookies", "ranked against the draft slot"], Breakout: ["Breakout defenders", "year 2 and 3 jumps against last season"], Watch: ["Watch", "defensive starters worth knowing"] };
const TIER_TITLE: Record<Prospect["tier"], [string, string]> = { Matchup: ["On the spot", "the unit edges put these players in the game plan"], Rookie: ["Rookie class", "ranked against the draft slot"], Breakout: ["Breakout watch", "year 2 and 3 jumps against last season"], Watch: ["Watch", "starters worth knowing"] };

export default async function GamePage({ params }: PageProps<"/game/[id]">) {
  const { id } = await params;
  const game = await getGame(id);
  if (!game) notFound();

  const score = scoutScore(game.scoreComponents);
  const tag = scoreTag(game);
  const flags = game.weather ? evaluateWeather(game.weather) : [];
  const { likely, future } = prospectCounts(game);
  const started = game.status !== "upcoming";
  const fourth = started ? fourthDownsFor(game.id) : [];
  const report = readReport(seasonOf(game.kickoff), game.id);
  // The headline is reason one; the read shows two more.
  // Why watch: only what the strip and Who to watch do not already say (older archived games: the headline and reasons).
  const read = game.whyWatchRead ?? [game.whyWatch, ...game.whyWatchReasons.filter((r) => r !== game.whyWatch)];
  // Who to watch: the three-slot list built for the game page, else the top of the radar.
  const guide = publishedGuide(game);
  const watch = game.whoToWatch ?? game.prospects.slice(0, 3).map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, label: undefined as string | undefined, reason: readLine(p), detail: undefined as string | undefined }));

  // One-line summaries: each closed section still says something.
  const offense = game.offenseRadar ?? game.prospects;
  const defense = game.defenseRadar ?? [];
  const tiers = (["Matchup", "Rookie", "Breakout", "Watch"] as const).map((t) => [t, offense.filter((p) => p.tier === t).length] as const).filter(([, n]) => n);
  const dTiers = (["Matchup", "Rookie", "Breakout", "Watch"] as const).map((t) => [t, defense.filter((p) => p.tier === t).length] as const).filter(([, n]) => n);
  const defenseSummary = `${defense.length} names: ${dTiers.map(([t, n]) => `${n} ${t === "Matchup" ? "on the spot" : t === "Breakout" ? "breakout" : t === "Rookie" ? "rookie" : "to watch"}`).join(", ")}`;
  const radarSummary = offense.length ? `${offense.length} names: ${tiers.map(([t, n]) => `${n} ${t === "Matchup" ? "on the spot" : t.toLowerCase()}`).join(", ")}` : "Nobody clears the radar yet";
  const m0 = game.matchups.find((m) => m.edge !== "even") ?? game.matchups[0];
  const edgeWord = (m: Game["matchups"][number]) => (m.strength === "dominant" ? "mismatch" : m.strength === "clear" ? "clear edge" : m.strength === "real" ? "edge" : "even");
  const matchupSummary = m0 ? `${m0.a} vs ${m0.b}: ${edgeWord(m0)}${game.matchups.length > 1 ? ` · ${game.matchups.length - 1} more` : ""}` : game.projection ? "Not charted; the projection is inside" : "Not charted yet";
  const av = game.availability;
  const avNet = av ? Math.round((av.home.total - av.away.total) * 10) / 10 : 0;
  const worst = av ? [...av.away.items, ...av.home.items].filter((i) => i.kind !== "qb" && i.pts < 0).sort((a, b) => a.pts - b.pts)[0] : undefined;
  const playingSummary = !av ? "" : avNet === 0 && !worst ? "Lineups as expected" : `${avNet === 0 ? "No net change" : `${(avNet > 0 ? game.home : game.away).short} +${Math.abs(avNet)} on the margin`}${worst ? ` · ${worst.name} ${worst.status.split(" (")[0].toLowerCase()}` : ""}`;
  const ms = game.market.spread;
  const marketSummary = ms ? `${spreadText(ms.team, ms.line)}${ms.open !== ms.line ? ` (opened ${spreadText(ms.team, ms.open)})` : ""} · total ${game.market.total?.line ?? "none"}` : "No widely available line";
  const styleSummary = `${game.away.short}: ${game.offense[game.away.abbr]?.label ?? "not charted"} · ${game.home.short}: ${game.offense[game.home.abbr]?.label ?? "not charted"}`;
  // Injuries: ESPN's live list merged with the latest official report (src/lib/injuries.ts), opened when a starter sits.
  const injuries = await injuriesFor(game).catch(() => undefined);
  const boxSummary = game.score && Number.isFinite(game.score.home) ? `${game.away.abbr} ${game.score.away}, ${game.home.abbr} ${game.score.home} · ${game.score.clock}` : game.status === "live" ? "In progress" : "Final";
  // Work left open by each back, receiver, or tight end likely to sit (src/lib/vacated.ts), by team nickname.
  const vacated = av
    ? Object.fromEntries(
        [av.away, av.home].map((t) => [t.team, vacatedFor(t.team, t.items.filter((i) => i.kind === "out" && i.absence >= 0.5).map((i) => ({ id: i.id, status: i.status })))]),
      )
    : undefined;
  // Trends: usage by week for both teams (src/lib/trends.ts), each week headed "W1 @PIT".
  const trendsTeams: TrendsTeam[] = [game.away, game.home].flatMap((t) => {
    const tr = teamTrends(t.short);
    if (!tr?.weeks.length) return [];
    return [{ name: t.short, abbr: t.abbr, color: t.color, heads: tr.weeks.map((w) => `W${w.wk} ${w.ha === "away" ? "@" : ""}${teamByShort(w.opp)?.abbr ?? w.opp}`), trends: tr }];
  });
  const topNote = topChange(trendsTeams.map((x) => x.trends));
  const trendsSummary = topNote ? `Week ${topNote.wk}: ${topNote.name}, ${changeText(topNote)} (${topNote.reason})` : "Snaps, targets, and carries by week for both teams";
  // Splits since 2019 for both teams and defenses in this game's situation (src/lib/splits.ts).
  const splitTeams = game.source === "live" ? [game.away, game.home].map((t) => ({ t, team: teamSplits(t.short, game.id), dst: dstSplits(t.short, game.id) })) : [];
  const hasSplits = splitTeams.some((x) => x.team.some((r) => r.n > 0));
  const homeSplit = splitTeams[1];
  const splitsSummary = homeSplit
    ? [
        (() => {
          const r = homeSplit.team.find((x) => x.key === "home" && x.now) ?? homeSplit.team.find((x) => x.now && x.n > 0);
          return r && r.mean !== null ? `${homeSplit.t.short} ${r.label.toLowerCase()}: ${r.mean > 0 ? "+" : ""}${r.mean} against the line (${r.n})` : "";
        })(),
        homeSplit.dst.homeDivision.now && homeSplit.dst.homeDivision.mean !== null ? `${homeSplit.t.short} defense at home in the division: ${homeSplit.dst.homeDivision.mean} DK a game (${homeSplit.dst.homeDivision.n})` : "",
      ].filter(Boolean).join(" · ") || "Both teams and defenses in spots like this one, since 2019"
    : "";
  const jump: { id: string; label: string }[] = [
    ...(started ? [{ id: "showed", label: game.status === "live" ? "Live" : "Box score" }] : []),
    { id: "injuries", label: "Injuries" },
    ...(defense.length ? [{ id: "defense", label: "Defense" }] : []),
    { id: "decided", label: "Matchups" },
    { id: "playing", label: "Who plays" },
    ...(trendsTeams.length ? [{ id: "trends", label: "Trends" }] : []),
    ...(hasSplits ? [{ id: "splits", label: "Splits" }] : []),
    { id: "dfs", label: "DraftKings" },
    { id: "market", label: "Market" },
    { id: "feed", label: "Feed" },
    { id: "writeup", label: "Write-up" },
  ];

  return (
    <article className="rise">
      <Link href={game.source === "live" ? `/?date=${etDateOf(game.kickoff)}` : "/"} className="mono text-xs text-chalk-3 hover:text-chalk">← Slate</Link>

      {/* Header: who, when, where. The answer strip under it carries the call. */}
      <header className={`mt-3 ${game.status === "final" ? "rounded border-l-4 border-brick pl-4" : ""}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-chalk-2">
            {new Date(game.kickoff).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" })} · {kickoffTime(game.kickoff)} ET · {game.network}
          </span>
          <StatusPill status={game.status} clock={game.score?.clock} />
          <LivePoller active={game.status === "live"} />
          {game.coverage !== "Full" && <CoverageBadge level={game.coverage} />}
        </div>
        <h1 className="display mt-2 text-4xl font-extrabold leading-none text-chalk sm:text-6xl">
          <TeamName t={game.away} score={game.score?.away} />
          <span className="mx-2 text-chalk-3 sm:mx-3">@</span>
          <TeamName t={game.home} score={game.score?.home} />
        </h1>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm text-chalk-3">
            {game.venue}
            {game.divGame && game.home.conference ? ` · ${game.home.conference} game` : game.city ? ` · ${game.city}` : ""}
          </p>
          <div className="w-36">
            <ScoutScore score={score} tag={tag} size="sm" />
          </div>
        </div>
      </header>

      <AnswerStrip game={game} />

      {/* The read: why it is worth the time and who to watch. Everything else is one tap away below. */}
      <section aria-label="The read" className="mt-6">
        {read[0] && <h2 className="display text-2xl font-bold leading-tight text-chalk sm:text-3xl">{read[0]}</h2>}
        {read.length > 1 && (
          <ul className="mt-2 grid max-w-3xl gap-1">
            {read.slice(1, 3).map((r) => (
              <li key={r} className="border-l-2 border-line-2 pl-3 text-base leading-snug text-chalk-2">{r}</li>
            ))}
          </ul>
        )}
        {watch.length > 0 && (
          <div className={read[0] ? "mt-5" : undefined}>
            <p className="relative text-sm font-semibold text-chalk">
              Who to watch
              <InfoTip label="Who to watch" what={TERMS.whoToWatch} context={storiesSummary()} />
            </p>
            <ul className="mt-1 divide-y divide-line">
              {watch.map((w) => (
                <li key={w.id} className="grid grid-cols-1 gap-x-3 py-2 sm:grid-cols-[15rem_minmax(0,1fr)] sm:items-baseline">
                  <span className="min-w-0 truncate">
                    <Link href={`/player/${w.id}`} className="font-semibold text-chalk hover:text-sky">{w.name}</Link>
                    <span className="mono ml-2 text-xs text-chalk-3">{w.pos} · {w.team}</span>
                  </span>
                  <span className="min-w-0 text-sm text-chalk-2">
                    {w.label && <span className="mr-2 rounded bg-ink-2 px-1.5 py-0.5 text-xs font-semibold text-chalk">{w.label}</span>}
                    {w.reason}
                    {w.detail && <span className="mono mt-0.5 block text-xs text-chalk-3">{w.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {game.storyNotes && game.storyNotes.length > 0 && (
              <p className="mt-1 border-t border-line pt-2 text-xs leading-snug text-chalk-3">
                <span className="font-semibold text-chalk-2">Also: </span>
                {game.storyNotes.map((n, i) => (
                  <span key={n.id}>
                    {i ? "; " : ""}
                    <Link href={`/player/${n.id}`} className="hover:text-sky">{n.name}</Link> ({n.pos}, {n.team}), {n.label.toLowerCase()}: {n.text.charAt(0).toLowerCase() + n.text.slice(1).replace(/\.$/, "")}
                  </span>
                ))}
                .
              </p>
            )}
          </div>
        )}
        {/* The watch guide (scripts/write-watchguides.mjs): a hook and three things to look for, every name and number
            checked against the source. Shown only when one has been written for this game. */}
        {guide && (
          <div className="mt-6">
            <p className="text-sm font-semibold text-chalk">
              Watch guide <span className="font-normal text-chalk-3">· {guide.headline}</span>
            </p>
            <WatchGuide game={game} guide={guide} />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <FollowButton kind="games" id={game.id} size="sm" />
          {game.source === "live" && (
            <>
              <FollowButton kind="teams" id={game.away.short} label={`Follow ${game.away.short}`} size="sm" />
              <FollowButton kind="teams" id={game.home.short} label={`Follow ${game.home.short}`} size="sm" />
            </>
          )}
        </div>
      </section>

      <FoldControls items={jump} />

      {started && (
        <Fold id="showed" title={game.status === "live" ? "Live" : "Box score"} summary={boxSummary} open>
          <PostgameBody game={game} />
        </Fold>
      )}

      {/* Fourth downs: each call against the win-probability model (src/lib/fourth.ts), once play-by-play is posted. */}
      {started && fourth.length > 0 && (
        <Fold id="fourth" title="Fourth downs" summary={fourthSummary(fourth)}>
          <FourthDowns gameId={game.id} />
        </Fold>
      )}

      {injuries && (
        <Fold id="injuries" title="Injuries" summary={injurySummaryLine(injuries)} open={starterOut(injuries)}>
          <InjuryReport data={injuries} away={game.away} home={game.home} />
        </Fold>
      )}

      <Fold id="radar" title="Radar: offense and kickers" summary={radarSummary}>
        {offense.some((p) => p.radar) && (
          <p className="max-w-3xl text-sm text-chalk-3">
            Quarterbacks, backs, receivers, and tight ends, the players whose lines move the bets. Each has a radar score from 0 to 100: production against the league at his position (half), snap share (30%), and context (20%: beating his draft slot, a breakout, or a starter). It ranks who is worth watching, not a projection. Players listed out are left off and named under Injuries. Defenders have their own section below.
            {game.statsAsOf ? ` Stats as of ${asOf(game.statsAsOf)}.` : ""}
          </p>
        )}
        <RadarTiers list={offense} game={game} />
        {game.kickers && game.kickers.length > 0 && (
          <div className="mt-5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="display text-2xl font-bold text-chalk">Kickers</span>
              <span className="text-xs text-chalk-3">field goals and extra points; wind and roof are under Conditions</span>
            </div>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {game.kickers.map((k) => (
                <li key={k.id} className="card px-3 py-2 text-sm">
                  <Link href={`/player/${k.id}`} className="font-semibold text-chalk hover:text-sky">{k.name}</Link>
                  <span className="mono ml-2 text-xs text-chalk-3">K · {k.team}</span>
                  <span className="mt-0.5 block text-chalk-2">{k.line}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {game.odds && offense.length > 0 && <PropsForRadar gameId={game.id} odds={game.odds} prospects={offense} upcoming={game.status === "upcoming"} />}
        {offense.length === 0 && <p className="mt-2 text-sm text-chalk-3">No skill player on either roster clears the production or snap-share thresholds. See More names.</p>}
      </Fold>

      {/* Defense: its own section, announced, so defenders are never mixed into the betting side above. */}
      {defense.length > 0 && (
        <Fold id="defense" title="Defense" summary={defenseSummary}>
          <p className="max-w-3xl text-sm text-chalk-3">
            The defender each defensive edge puts on the spot, breakout defenders, defensive rookies, and starters worth knowing, scored the same way as the radar above. For pass rushers and tacklers with prop lines, see DraftKings and props.
          </p>
          <RadarTiers list={defense} game={game} titles={DEFENSE_TIER_TITLE} />
        </Fold>
      )}

      <Fold id="decided" title="Matchups" summary={matchupSummary}>
        {game.matchups.length > 0 ? (
          <>
            <p className="relative max-w-3xl text-sm text-chalk-3">
              Each offense against the opposing defense: the run, the pass, and passing downs. Run and pass show how often the play works (that decides the edge) and how much it is worth. Ranks are among all 32 teams. The gap is in percentile points; 40 or more is a clear edge, 55 or more is a mismatch.
              <InfoTip label="Success rate, EPA, passing downs" what={TERMS.matchups} />
            </p>
            <div className="mt-3 grid gap-3">
              {game.matchups.map((m, i) => (
                <MatchupCard key={i} m={m} game={game} />
              ))}
            </div>
            {game.situations && <SituationalCues cues={game.situations.cues} />}
          </>
        ) : (
          <p className="text-base text-chalk-3">{game.pressurePoint}</p>
        )}
        <CoveragePanel away={game.away.short} home={game.home.short} />
        <DvpTable game={game} />
        {game.projection && <ProjectionBox game={game} />}
      </Fold>

      {game.availability && (
        <Fold id="playing" title="Who's playing" summary={playingSummary}>
          <AvailabilityPanel game={game} a={game.availability} vacated={vacated} />
        </Fold>
      )}

      {trendsTeams.length > 0 && (
        <Fold id="trends" title="Trends" summary={trendsSummary}>
          <TrendsPanel teams={trendsTeams} />
        </Fold>
      )}

      {hasSplits && (
        <Fold id="splits" title="Splits" summary={splitsSummary}>
          <p className="relative max-w-3xl text-sm text-chalk-3">
            Each team&apos;s scoring against the betting line and each defense&apos;s DraftKings points, in this game&apos;s spots, since 2019.
            <InfoTip label="Splits" what={TERMS.splits} />
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {splitTeams.map(({ t, team, dst }) => (
              <div key={t.short} className="card p-4">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-4 w-1 rounded-sm" style={{ background: t.color }} />
                  <span className="display text-2xl font-bold">{t.short}</span>
                </div>
                <div className="mt-2">
                  <SplitsTable rows={team} mode="diff" unit="Points against the closing implied team total (games)" />
                </div>
                <div className="mt-3">
                  <SplitsTable rows={dst.rows} mode="level" unit="Defense: DraftKings points a game (games)" />
                  {dst.homeDivision.n > 0 && (
                    <p className="mono mt-1 text-xs text-chalk-2">
                      At home against a division rival: <span className="font-semibold text-chalk">{dst.homeDivision.mean}</span> ({dst.homeDivision.n}), other games {dst.homeDivision.rest} ({dst.homeDivision.restN})
                      {dst.homeDivision.now && <span className="ml-2 rounded bg-ink-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-chalk">this week</span>}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {[...splitsNotes("teams"), ...splitsNotes("defenses")].map((n) => (
            <p key={n} className="mt-1 max-w-3xl text-xs text-chalk-3">{n}</p>
          ))}
        </Fold>
      )}

      <Fold id="dfs" title="DraftKings and props" summary="Salaries, simulated floor to ceiling, defensive props">
        <Suspense fallback={<p className="mt-3 text-sm text-chalk-3">Loading DraftKings salaries.</p>}>
          <DfsPanel game={game} />
        </Suspense>
      </Fold>

      <Fold id="market" title="Market" summary={marketSummary}>
        {game.market.spread ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Consensus spread" value={spreadText(game.market.spread.team, game.market.spread.line)} sub={moveText(game.market.spread.open, game.market.spread.line)} />
            {game.market.total && <Stat label="Total" value={String(game.market.total.line)} sub={moveText(game.market.total.open, game.market.total.line)} />}
            {game.market.moneyline ? (
              <Stat label="Moneyline" value={`${game.home.abbr} ${mlText(game.market.moneyline.home)} / ${game.away.abbr} ${mlText(game.market.moneyline.away)}`} sub={`one book; ${game.market.books} ${game.market.books === 1 ? "book" : "books"} on the spread`} />
            ) : (
              <Stat label="Books" value={String(game.market.books)} sub="consensus median" />
            )}
            <p className="mono text-xs text-chalk-3 sm:col-span-3">
              As of {asOf(game.market.asOf)}{started ? ", the last pregame number" : ""}. The model against it is under Matchups.
            </p>
          </div>
        ) : (
          <p className="text-sm text-chalk-3">No book we track lists this game. The report does not estimate a line.</p>
        )}
        {game.odds && <LineMovement odds={game.odds} home={game.home} away={game.away} />}
      </Fold>

      <Fold id="storylines" title="Storylines" summary={game.storylines[0] ?? "Nothing beyond the schedule"}>
        {game.storylines.length === 0 && <p className="text-sm text-chalk-3">Nothing on file beyond the schedule.</p>}
        <ul className="grid gap-1.5">
          {game.storylines.map((s) => (
            <li key={s} className="border-l-2 border-line-2 pl-3 text-sm text-chalk-2">{s}</li>
          ))}
        </ul>
      </Fold>

      <Fold id="style" title="Team style" summary={styleSummary}>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {[game.away, game.home].map((t) => (
            <div key={t.id} className="border-l-4 pl-3" style={{ borderColor: t.color }}>
              <dt className="display text-xl font-bold text-chalk">{t.short}</dt>
              <dd className="text-sm text-chalk-2">Offense: {game.offense[t.abbr]?.label ?? "not charted"}</dd>
              <dd className="text-sm text-chalk-2">Defense: {game.defense[t.abbr]?.label ?? "not charted"}</dd>
            </div>
          ))}
        </dl>
        {game.offense[game.home.abbr]?.sample !== "unavailable" && (
          <>
            {game.statsAsOf && <p className="mono mt-4 text-xs text-chalk-3">Play-by-play through {asOf(game.statsAsOf)}. Ranks are among all 32 teams.</p>}
            <div className="mt-3 grid gap-2.5 md:grid-cols-2">
              {[game.away, game.home].map((t) => (
                <div key={t.id} className="card p-4">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-4 w-1 rounded-sm" style={{ background: t.color }} />
                    <span className="display text-2xl font-bold">{t.short}</span>
                  </div>
                  <StyleCard side="Offense" o={game.offense[t.abbr]} />
                  <StyleCard side="Defense" d={game.defense[t.abbr]} />
                </div>
              ))}
            </div>
            {game.situations && <SituationsTable away={game.away} home={game.home} s={game.situations} />}
          </>
        )}
      </Fold>

      {(game.weather || game.climate) && (
        <Fold id="conditions" title="Conditions" summary={game.weather ? weatherHeadline(game) : "No forecast yet"}>
          {game.weather && (
            <>
              <div className="mono flex flex-wrap gap-x-5 gap-y-1 text-xs text-chalk-2">
                <span>{game.weather.tempF}° / feels {game.weather.feelsLikeF}°</span>
                <span>Wind {game.weather.windDir} {game.weather.windMph} mph, gusts {game.weather.gustMph}</span>
                <span>Rain {game.weather.precipChance}%{game.weather.precipWindow ? ` ${game.weather.precipWindow}` : ""}</span>
                <span>Humidity {game.weather.humidity}%</span>
                <span>{game.weather.surface === "grass" ? "Grass" : "Turf"} · {roofLabel(game.weather.roof)}</span>
                <span>{game.weather.elevationFt.toLocaleString()} ft</span>
                <span className="text-chalk-3">as of {asOf(game.weather.asOf)}</span>
              </div>
              {game.weather.roof === "open" && (
                <p className="mt-2 text-sm text-chalk-2">
                  {game.weather.windMph > 0 ? `Wind ${game.weather.windDir} ${game.weather.windMph} mph` : "Calm"}
                  {game.weather.windComponent && game.weather.fieldBearing != null
                    ? `, ${componentPhrase(game.weather.windComponent)} (field runs ${axisLabel(game.weather.fieldBearing)}${game.weather.fieldBearingConfidence !== "high" ? ", from the stadium outline" : ""}).`
                    : game.weather.fieldBearing != null
                      ? `. Field runs ${axisLabel(game.weather.fieldBearing)}.`
                      : ". Field orientation is not on file for this venue, so the crosswind call is unmeasured."}
                </p>
              )}
              {game.climate && <p className="mt-1 text-sm text-chalk-2">{baselineLine(game.climate, game.weather)}</p>}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {flags.length === 0 && <p className="card p-4 text-sm text-chalk-2">No weather flag. Conditions are not expected to change play calling.</p>}
                {flags.map((f) => (
                  <div key={f.key} className={`card p-4 ${f.level === "elevated" ? "border-brick/60" : f.level === "flag" ? "border-warn/50" : ""}`}>
                    <p className={`text-sm font-semibold ${f.level === "elevated" ? "text-brick" : f.level === "flag" ? "text-warn" : "text-chalk-2"}`}>
                      {f.level === "elevated" ? "▲ " : f.level === "flag" ? "△ " : ""}
                      {f.title}
                    </p>
                    <p className="mt-1 text-sm leading-snug text-chalk-2">{f.effect}</p>
                  </div>
                ))}
              </div>
            </>
          )}
          {!game.weather && game.climate && <p className="text-sm text-chalk-2">{baselineLine(game.climate)}</p>}
        </Fold>
      )}

      {game.keepAnEyeOn.length > 0 && (
        <Fold id="eye" title="More names" summary={game.keepAnEyeOn.map((k) => k.name).join(", ")}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {game.keepAnEyeOn.map((k) => (
              <li key={k.name} className="card p-4">
                <span className="display text-2xl font-semibold text-chalk">{k.name}</span>
                <span className="mono ml-2 text-xs text-chalk-3">{k.team}</span>
                <p className="mt-1 text-base text-chalk-2">{k.note}</p>
              </li>
            ))}
          </ul>
        </Fold>
      )}

      {/* Beat feed: posts and headlines about both teams, tagged to radar players. Context only, never a source for the report. */}
      <Fold id="feed" title="Beat feed" summary={`Posts and headlines on the ${game.away.short} and ${game.home.short}, last 3 days`}>
        <Suspense fallback={<p className="mb-4 text-xs text-chalk-3">Reading the beat for sleepers.</p>}>
          <SleepersPanel teams={[game.away.short, game.home.short]} players={game.prospects.map((p) => ({ id: p.id, name: p.name, team: p.team === game.home.abbr ? game.home.short : game.away.short }))} vacated={vacated} />
        </Suspense>
        <Suspense fallback={<BeatFeedFallback />}>
          <BeatFeed
            limit={10}
            schools={[game.away.short, game.home.short]}
            players={game.prospects.map((p) => ({ id: p.id, name: p.name, team: p.team === game.home.abbr ? game.home.short : game.away.short }))}
          />
        </Suspense>
      </Fold>

      <Fold id="writeup" title="Written report" summary={report?.report?.headline ?? "No report written yet"}>
        <WrittenReport game={game} bare />
      </Fold>

      <Fold id="score" title="Watch Score" summary={`${score} of 100 · ${tag}`}>
        <div className="grid gap-2">
          {COMPONENT_KEYS.map((k) => {
            const v = game.scoreComponents[k];
            return (
              <div key={k} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-xs sm:grid-cols-[12rem_1fr_3rem]">
                <span className={v === null ? "text-chalk-3" : "text-chalk-2"}>
                  {COMPONENT_LABELS[k]} <span className="text-chalk-3">{Math.round(WEIGHTS[k] * 100)}%</span>
                </span>
                {v === null ? <span className="mono text-[10px] text-chalk-3">not available, excluded</span> : <div className="meter"><span style={{ width: `${v}%` }} /></div>}
                <span className="mono text-right text-chalk">{v === null ? "–" : v}</span>
              </div>
            );
          })}
          <p className="mt-1 text-xs text-chalk-3">
            Ranks viewing value, not team quality. Competitive expectation, unit mismatches, rookie and breakout density, stakes from the standings, and the broadcast window.
            {game.source === "live" ? ` ${likely} to watch, ${future} more on the radar.` : ""}
            {availableWeight(game.scoreComponents) < 0.999 && ` Scored on ${Math.round(availableWeight(game.scoreComponents) * 100)}% of the weights; excluded inputs are not ingested yet.`}
          </p>
        </div>
      </Fold>

      <Fold id="gaps" title="What this report cannot say" summary={`${(game.gaps ?? []).length ? `${(game.gaps ?? []).length} ${(game.gaps ?? []).length === 1 ? "note" : "notes"}` : "Nothing missing"} · report as of ${asOf(game.reportAsOf)}`}>
        <ul className="grid gap-1 text-sm text-chalk-3 sm:grid-cols-2">
          {(game.gaps ?? []).map((g) => (
            <li key={g} className="flex gap-2"><span>–</span>{g}</li>
          ))}
          <li className="flex gap-2"><span>–</span>Report as of {asOf(game.reportAsOf)}.</li>
        </ul>
      </Fold>
    </article>
  );
}

/* ---------------------------------------------------------------- bits */

/**
 * The call on one screen: who the model has and by how much, the posted number, and where the model sits
 * against it (or how the call graded, once final), plus the one or two notes that move it.
 */
function AnswerStrip({ game }: { game: Game }) {
  const p = game.projection;
  const s = game.market.spread;
  const t = game.market.total;
  const teamOf = (abbr: string) => (abbr === game.home.abbr ? game.home : game.away);
  const winner = p ? teamOf(p.winner) : undefined;
  const side = p?.modelSide ? teamOf(p.modelSide) : undefined;
  const sTier = p ? sideTier(p.sideGap ?? 0) : undefined;
  const tTier = p && p.totalLean && p.totalLean !== "none" ? totalTier(p.totalGap ?? 0) : undefined;
  const sideLine = side && s ? (side.abbr === s.team ? s.line : -s.line) : undefined;
  const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
  const graded = game.archive?.postgame?.projectionResult;
  const notes = keyNotes(game);
  const even = p ? p.margin < 1 : false;
  const scoreLine = p ? `${game.away.abbr} ${p.away}, ${game.home.abbr} ${p.home}` : "";
  const totalPart = p?.modelTotal !== undefined && t ? (tTier ? `total: model ${p.modelTotal}, leans ${p.totalLean} (${Math.abs(p.totalGap ?? 0).toFixed(1)} pts)` : `total: model ${p.modelTotal}, no lean`) : "";
  return (
    <section aria-label="The call" className="mt-5 rounded border border-line bg-panel">
      {/* Phone: the call across the top, the line and the edge side by side under it. Wider: three columns. */}
      <div className="grid grid-cols-2 sm:grid-cols-[1.3fr_1fr_1.2fr]">
        <div className="relative col-span-2 border-b border-line p-4 sm:col-span-1 sm:border-b-0 sm:border-r" style={{ boxShadow: winner && !even ? `inset 4px 0 0 ${winner.color}` : undefined }}>
          <p className="text-xs font-semibold text-chalk-3">
            {game.status === "upcoming" ? "The model" : "Pregame call"}
            <InfoTip label="The model" what={TERMS.model} />
          </p>
          {p && winner ? (
            <>
              <p className="display mt-0.5 text-3xl font-bold text-chalk">{even ? "Even game" : `${winner.short} by ${p.margin.toFixed(1)}`}</p>
              <p className="mono mt-0.5 text-xs text-chalk-2">{even ? `${winner.short} by ${p.margin.toFixed(1)} · ` : ""}{Math.round(p.winProb * 100)}% to win · {scoreLine}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-chalk-3">No projection: the inputs are not ingested.</p>
          )}
        </div>
        <div className="border-r border-line p-4">
          <p className="text-xs font-semibold text-chalk-3">{game.status === "upcoming" ? "The line" : "The line at kickoff"}</p>
          <p className="display mt-0.5 text-xl font-bold text-chalk sm:text-2xl">{s ? `${teamOf(s.team).short} ${signed(s.line)}` : "No line"}</p>
          <p className="mono mt-0.5 text-xs text-chalk-2">{t ? `total ${t.line}` : "no total"}</p>
        </div>
        <div className="relative p-4">
          {graded ? (
            <>
              <p className="text-xs font-semibold text-chalk-3">How the call did</p>
              <p className={`display mt-0.5 text-xl font-bold sm:text-2xl ${graded.winnerRight ? "text-turf" : "text-brick"}`}>{graded.winnerRight ? "Winner right" : "Winner wrong"}</p>
              <p className="mono mt-0.5 text-xs text-chalk-2">
                margin off by {graded.marginError.toFixed(0)}
                {graded.modelSideCovered !== undefined ? ` · side ${graded.modelSideCovered ? "covered" : "lost"}` : ""}
                {graded.totalLeanRight !== undefined ? ` · total ${graded.totalLeanRight ? "right" : "wrong"}` : ""}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-semibold text-chalk-3">
                The gap
                <InfoTip label="The gap" what={TERMS.edge} context={LEAN_BACKTEST_NOTE} align="right" />
              </p>
              {side && sTier && sideLine !== undefined ? (
                <>
                  <p className="display mt-0.5 text-xl font-bold text-chalk sm:text-2xl">{side.short} {signed(sideLine)}</p>
                  <p className="mono mt-0.5 text-xs text-chalk-2">model {p!.sideGap!.toFixed(1)} pts off the line{totalPart ? ` · ${totalPart}` : ""}</p>
                </>
              ) : tTier && t ? (
                <>
                  <p className="display mt-0.5 text-xl font-bold text-chalk sm:text-2xl">{p!.totalLean === "under" ? "Under" : "Over"} {t.line}</p>
                  <p className="mono mt-0.5 text-xs text-chalk-2">model total {p!.modelTotal} ({Math.abs(p!.totalGap ?? 0).toFixed(1)} pts) · no side</p>
                </>
              ) : (
                <>
                  <p className="display mt-0.5 text-xl font-bold text-chalk-2 sm:text-2xl">{s && p ? "No gap" : "Nothing to compare"}</p>
                  <p className="mono mt-0.5 text-xs text-chalk-2">{s && p ? "model and market agree" : ""}</p>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-b border-t border-line bg-panel-2 px-4 py-2 text-sm text-chalk-2">
        {notes.map((n) => (
          <span key={n}>{n}</span>
        ))}
        {game.status !== "final" && <UpdateNow id={game.id} asOf={game.reportAsOf} />}
      </div>
    </section>
  );
}

/**
 * The notes that move the call, in plain words: a quarterback change or a questionable starter, absences that are news
 * (he played the last game, or his status is uncertain; a player out for weeks is already in the numbers), a weather
 * flag, a neutral field.
 */
function keyNotes(game: Game): string[] {
  const out: string[] = [];
  if (game.status === "final") {
    const post = game.archive?.postgame;
    if (post?.spreadResult) out.push(`Market: ${post.spreadResult}${post.totalResult ? `, total went ${post.totalResult}` : ""}`);
    return out;
  }
  const a = game.availability;
  for (const [team, av] of a ? ([[game.away, a.away], [game.home, a.home]] as const) : []) {
    if (av.qb && (av.qb.uncertain || Math.abs(av.qb.pts) >= 1.5)) out.push(`${team.short}: ${av.qb.expected} at QB${av.qb.uncertain ? ", questionable" : ""} (${av.qb.pts > 0 ? "+" : ""}${av.qb.pts})`);
    const news = av.items.filter((i) => i.kind === "out" && i.pts <= -0.3 && (i.fresh || i.absence < 0.85)).slice(0, 2);
    for (const i of news) out.push(`${team.short}: ${i.name} ${absentWords(i.status)} (${i.pts} pts)`);
  }
  const flag = game.weather ? evaluateWeather(game.weather).find((f) => f.level !== "note") : undefined;
  if (flag) out.push(flag.title);
  const neutral = game.storylines.find((s) => s.startsWith("Neutral site"));
  if (neutral) out.push(neutral.replace(/\.$/, ""));
  return out.slice(0, 4);
}

function RadarTiers({ list, game, titles = TIER_TITLE }: { list: Prospect[]; game: Game; titles?: Record<Prospect["tier"], [string, string]> }) {
  const byTier = new Map<Prospect["tier"], Prospect[]>();
  for (const p of list) byTier.set(p.tier, [...(byTier.get(p.tier) ?? []), p]);
  return (
    <>
      {TIERS.filter((t) => byTier.has(t)).map((y) => (
        <div key={y} className="mt-5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="display text-2xl font-bold text-chalk">{titles[y][0]}</span>
            <span className="text-xs text-chalk-3">{titles[y][1]}</span>
          </div>
          <div className="mt-2 grid gap-2.5 md:grid-cols-2">
            {byTier.get(y)!.map((p) => (
              <ProspectCard key={p.id} p={p} team={p.team === game.home.abbr ? game.home : game.away} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function MatchupCard({ m, game }: { m: Game["matchups"][number]; game: Game }) {
  const tone = m.edge === "offense" ? "border-l-4 border-l-turf" : m.edge === "defense" ? "border-l-4 border-l-sky" : "border-l-4 border-l-line-2";
  const label = m.strength === "dominant" ? "Mismatch" : m.strength === "clear" ? "Clear edge" : m.strength === "real" ? "Edge" : "Even";
  const labelTone = m.strength === "dominant" ? "bg-brick text-white" : m.strength === "clear" ? "bg-navy text-white" : m.strength === "real" ? "bg-ink-2 text-chalk" : "bg-ink-2 text-chalk-3";
  const offTeam = m.a.startsWith(game.home.short) ? game.home : game.away;
  const defTeam = offTeam === game.home ? game.away : game.home;
  const winner = m.edge === "offense" ? offTeam : m.edge === "defense" ? defTeam : undefined;
  return (
    <div className={`card p-4 sm:p-5 ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${labelTone}`}>{label}</span>
        <TeamMark team={offTeam} state={winner ? (winner === offTeam ? "win" : "lose") : "even"} />
        <span className="display text-xl font-bold text-chalk sm:text-2xl">{m.a}</span>
        <span className="text-chalk-3">vs</span>
        <TeamMark team={defTeam} state={winner ? (winner === defTeam ? "win" : "lose") : "even"} />
        <span className="display text-xl font-bold text-chalk sm:text-2xl">{m.b}</span>
        {winner && <span className={`ml-auto text-sm font-semibold ${m.edge === "offense" ? "text-turf" : "text-sky"}`}>Advantage {winner.short}</span>}
      </div>
      <p className="mt-3 text-base leading-relaxed text-chalk">{m.why}</p>
      {m.watch && <p className="mt-2 text-sm text-chalk-2"><span className="font-semibold text-chalk">Watch for:</span> {m.watch}</p>}
      <p className="mono mt-2 text-xs text-chalk-3">Evidence: {m.evidence}</p>
    </div>
  );
}

const BOX_LABEL: Record<string, string> = { passing: "Pass", rushing: "Rush", receiving: "Rec", defensive: "Def", interceptions: "INT", kicking: "Kick", punting: "Punt", fumbles: "Fum", kickReturns: "KR", puntReturns: "PR" };

function PostgameBody({ game }: { game: Game }) {
  return (
    <>
      <LivePanel game={game} />
      {game.box ? (
        <>
          <div className="mt-3 grid gap-2.5 md:grid-cols-2">
            {game.box.teams.map((t) => (
              <div key={t.team} className="card p-4">
                <div className="flex items-baseline justify-between">
                  <span className="display text-2xl font-bold text-chalk">{t.team}</span>
                  {t.points !== null && <span className="display text-3xl font-extrabold text-flag">{t.points}</span>}
                </div>
                <ul className="mt-2 grid gap-1.5">
                  {t.leaders.map((l) => (
                    <li key={l.id + l.category} className="flex items-baseline gap-2 text-sm">
                      <span className="w-10 shrink-0 text-xs font-semibold text-chalk-3">{BOX_LABEL[l.category] ?? l.category.slice(0, 4)}</span>
                      <Link href={`/player/${l.id}`} className="font-medium text-chalk hover:text-flag">{l.name}</Link>
                      <span className="mono truncate text-xs text-chalk-2">{l.headline}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-chalk-3">
            {game.box.source === "espn" ? "Box from the ESPN feed; the nflverse weekly stats replace it once posted. " : ""}
            Radar players below show their line from this game. One game is one data point.
          </p>
          {game.archive?.postgame && <Accountability entry={game.archive} />}
        </>
      ) : (
        <p className="mt-2 text-base text-chalk-3">The data feed posts player stats after the game settles. Check back in a few minutes.</p>
      )}
    </>
  );
}

/** Logo chip. The side with the advantage is full color with a ring; the other side is shaded. */
function TeamMark({ team, state, size = "md" }: { team: Team; state: "win" | "lose" | "even"; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "h-12 w-12" : "h-9 w-9";
  const ring = state === "win" ? "ring-2 ring-turf ring-offset-2 ring-offset-white" : state === "lose" ? "opacity-30 grayscale" : "";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white ${dim} ${ring}`} title={team.name}>
      {team.logo ? (
        <Image src={team.logo} alt={team.short} width={48} height={48} className="h-[82%] w-[82%] object-contain" unoptimized />
      ) : (
        <span className="display text-sm font-bold" style={{ color: team.color }}>{team.abbr}</span>
      )}
    </span>
  );
}

/**
 * The projection in full: the score line, the side and the total against the posted numbers (one place for
 * both), how the margin was built, and the outside systems. Live and final games show the locked call.
 */
function ProjectionBox({ game }: { game: Game }) {
  const p = game.projection!;
  const winnerTeam = p.winner === game.home.abbr ? game.home : game.away;
  const graded = game.archive?.postgame?.projectionResult;
  const locked = game.archive?.pregame.projection;
  const sideTeam = p.modelSide ? (p.modelSide === game.home.abbr ? game.home : game.away) : undefined;
  const sTier = sideTier(p.sideGap ?? 0);
  const tTier = p.totalLean && p.totalLean !== "none" ? totalTier(p.totalGap ?? 0) : undefined;
  const badge = (t: ReturnType<typeof sideTier>) => (t === "strong" ? "bg-navy text-white" : t === "moderate" ? "bg-ink-2 text-chalk" : "bg-ink-2 text-chalk-3");
  return (
    <div className="card mt-5 border-l-4 border-l-navy p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-chalk-3">{game.status === "upcoming" ? "Projected outcome, a model, not a pick" : "The pregame call, a model, not a pick"}</p>
          <p className="display mt-1 flex flex-wrap items-center gap-x-3 text-3xl font-bold text-chalk sm:text-5xl">
            <TeamMark team={game.away} state={p.winner === game.away.abbr ? "win" : "lose"} size="lg" />
            <span>{game.away.short} {p.away}</span>
            <span className="text-chalk-3">@</span>
            <TeamMark team={game.home} state={p.winner === game.home.abbr ? "win" : "lose"} size="lg" />
            <span>{game.home.short} {p.home}</span>
          </p>
          <p className="mt-1 text-lg text-chalk">
            <span className="font-semibold" style={{ color: winnerTeam.color }}>{winnerTeam.short}</span> by {p.margin.toFixed(1)} · {Math.round(p.winProb * 100)}% to win · total {p.total}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold text-chalk-3">Inputs</p>
          <p className="text-base font-semibold text-chalk">{inputsLabel(p.confidence)}</p>
        </div>
      </div>
      <p className="mt-3 text-base leading-relaxed text-chalk">{p.shape}</p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-line bg-panel-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-chalk">Side</span>
            <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${badge(sTier)}`}>{tierLabel(sTier)}</span>
          </div>
          {sideTeam && game.market.spread ? (
            <>
              <p className="display mt-1 flex items-center gap-2 text-2xl font-bold text-chalk">
                <TeamMark team={sideTeam} state={sTier ? "win" : "even"} />
                {sideTeam.short}
                <span className="mono text-sm font-normal text-chalk-3">{spreadText(game.market.spread.team, game.market.spread.line)}</span>
              </p>
              <p className="mt-1 text-base text-chalk">{p.vsMarket}</p>
            </>
          ) : (
            <p className="mt-1 text-base text-chalk-3">No posted spread to compare.</p>
          )}
        </div>
        <div className="rounded border border-line bg-panel-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-chalk">Total</span>
            <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${badge(tTier)}`}>{tTier ? `${tierLabel(tTier)}, ${p.totalLean}` : "no lean"}</span>
          </div>
          {p.modelTotal !== undefined && game.market.total ? (
            <>
              <p className="display mt-1 text-2xl font-bold text-chalk">
                {p.totalLean && p.totalLean !== "none" ? p.totalLean.toUpperCase() : "Even"} <span className="mono text-sm font-normal text-chalk-3">model {p.modelTotal} · posted {game.market.total.line}</span>
              </p>
              <p className="mt-1 text-base text-chalk">{p.totalNote}</p>
              {p.weatherTilt && <p className="mt-1 text-sm text-chalk-2"><span className="font-semibold text-chalk">Weather:</span> {p.weatherTilt}</p>}
            </>
          ) : p.modelTotal !== undefined ? (
            <p className="mt-1 text-base text-chalk">Model total {p.modelTotal}. No posted total to compare.</p>
          ) : (
            <p className="mt-1 text-base text-chalk-3">Total needs tendency data for both teams.</p>
          )}
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer select-none text-sm font-semibold text-sky">How the number was built</summary>
        <ul className="mono mt-2 grid gap-0.5 text-xs text-chalk-3">
          {p.basis.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </details>
      <ConsensusTable game={game} />
      <p className="mt-2 text-xs text-chalk-3">
        Margin is our pregame Elo (K 20, 48 points of home field, 25 Elo per point) plus 40% of the unit-edge adjustment and who is playing. Total is each offense&apos;s EPA per play against the other defense over both teams&apos; pace, plus a weather tilt when the forecast is flagged. Win probability assumes a 13.5-point standard deviation. {LEAN_BACKTEST_NOTE}
        {locked && !graded && ` Locked ${asOf(game.archive!.pregame.updatedAt ?? game.archive!.pregame.capturedAt)}; graded after the final.`}
        {graded && ` Graded: winner ${graded.winnerRight ? "right" : "wrong"}, margin off by ${graded.marginError.toFixed(0)}${graded.modelSideCovered !== undefined ? `, model side ${graded.modelSideCovered ? "covered" : "did not cover"}` : ""}${graded.totalLeanRight !== undefined ? `, total lean ${graded.totalLeanRight ? "right" : "wrong"}` : ""}.`}
      </p>
    </div>
  );
}

function Accountability({ entry }: { entry: NonNullable<Game["archive"]> }) {
  const post = entry.postgame!;
  const pre = entry.pregame;
  const tone = (v: string) =>
    v === "played out" || v === "showed up" ? "bg-turf text-white" : v === "did not play out" || v === "quiet" ? "bg-brick text-white" : v === "mixed" ? "bg-warn text-chalk" : "bg-ink-2 text-chalk-3";
  const graded = post.edges.filter((e) => e.edge !== "even" && e.verdict !== "unmeasured");
  const hits = graded.filter((e) => e.verdict === "played out").length;
  const pros = post.prospects.filter((p) => p.verdict !== "unmeasured");
  const showed = pros.filter((p) => p.verdict === "showed up").length;
  return (
    <div className="card mt-4 border-l-4 border-l-navy p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="display text-3xl font-bold text-chalk">Did it play out?</h3>
        <span className="mono text-xs text-chalk-3">Call locked {asOf(pre.capturedAt)} · graded {asOf(post.capturedAt)}</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <Stat label="Matchup calls" value={graded.length ? `${hits} of ${graded.length}` : "none graded"} sub="played out" />
        <Stat label="Radar names" value={pros.length ? `${showed} of ${pros.length}` : "none"} sub="showed up" />
        <Stat label="Pressure point" value={post.pressurePointVerdict} />
        <Stat label="Market" value={post.spreadResult ?? "no line"} sub={post.totalResult ? `total went ${post.totalResult}` : undefined} />
        {post.projectionResult && (
          <Stat
            label="Projection"
            value={post.projectionResult.winnerRight ? "winner right" : "winner wrong"}
            sub={`margin off by ${post.projectionResult.marginError.toFixed(0)}${post.projectionResult.modelSideCovered !== undefined ? ` · model side ${post.projectionResult.modelSideCovered ? "covered" : "lost"}` : ""}`}
          />
        )}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer select-none text-sm font-semibold text-sky">Every call, graded ({post.edges.length + post.prospects.length})</summary>
        <ul className="mt-3 grid gap-2">
          {post.edges.map((e, i) => (
            <li key={i} className="grid gap-1 rounded border border-line bg-panel-2 p-3 sm:grid-cols-[auto_1fr] sm:items-start sm:gap-3">
              <span className={`inline-block w-fit rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${tone(e.verdict)}`}>{e.verdict}</span>
              <span>
                <span className="text-base font-semibold text-chalk">{e.a} vs {e.b}</span>
                <span className="block text-sm text-chalk-2">Called: advantage {e.edge}. Actual: {e.actual}.</span>
              </span>
            </li>
          ))}
          {post.prospects.map((p) => (
            <li key={p.id} className="grid gap-1 rounded border border-line bg-panel-2 p-3 sm:grid-cols-[auto_1fr] sm:items-start sm:gap-3">
              <span className={`inline-block w-fit rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${tone(p.verdict)}`}>{p.verdict}</span>
              <span>
                <Link href={`/player/${p.id}`} className="text-base font-semibold text-chalk hover:text-sky">{p.name}</Link>
                <span className="text-sm text-chalk-3"> {p.pos} · radar {p.score}</span>
                <span className="block text-sm text-chalk-2">{p.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-3 text-sm text-chalk-3">
        Watch Score was {pre.scoutScore}. Every graded game goes into <Link href="/history" className="text-sky">the record</Link>, so the thresholds can be tuned against real results instead of opinion.
      </p>
    </div>
  );
}

function TeamName({ t, score }: { t: Team; score?: number }) {
  const hasScore = score !== undefined && Number.isFinite(score);
  return (
    <span className="inline-flex items-baseline gap-2">
      {t.logo && <Image src={t.logo} alt="" width={40} height={40} className="h-8 w-8 self-center object-contain sm:h-10 sm:w-10" unoptimized />}
      {t.rank && (
        <span className="text-2xl text-flag sm:text-3xl" title={t.rankPoll}>
          {t.rankPoll && !/^AP/i.test(t.rankPoll) && <span className="mono mr-1 text-xs uppercase tracking-wider text-chalk-3">{t.rankPoll.includes("FCS") ? "FCS" : "poll"}</span>}
          {t.rank}
        </span>
      )}
      <span style={{ color: "var(--chalk)" }}>{t.short}</span>
      {hasScore ? <span className="text-flag">{score}</span> : t.record ? <span className="mono self-center text-base font-normal text-chalk-3 sm:text-xl">{t.record}</span> : null}
    </span>
  );
}

/** A collapsible report section: closed, it costs one line and its summary still says something. */
/** DraftKings points each defense allows a game to each position, this season and over its last four games, with rank. */
function DvpTable({ game }: { game: Game }) {
  const season = defenseVsPosition();
  const recent = defenseVsPosition(4);
  const sides = [game.away, game.home].filter((t) => season.table.has(t.short));
  if (!sides.length) return null;
  const POS = ["QB", "RB", "WR", "TE"] as const;
  const tone = (rank: number) => (rank <= 8 ? "text-turf" : rank >= 25 ? "text-brick" : "text-chalk");
  // Through four games the last four are the season: the column waits until a defense has played more.
  const showRecent = sides.some((t) => (season.table.get(t.short)?.QB?.games ?? 0) > 4);
  return (
    <div className="mt-4">
      <p className="relative text-sm font-semibold text-chalk">
        DraftKings points allowed
        <InfoTip label="DraftKings points allowed" what={TERMS.dvp} />
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {sides.map((t) => (
          <div key={t.short} className="card px-4 py-2">
            <p className="text-sm text-chalk-2">
              <span className="font-semibold text-chalk">{t.short} defense</span> allows a game (rank, No. 1 = most)
            </p>
            <table className="mono mt-1 w-full text-xs">
              <thead>
                <tr className="text-left text-chalk-3">
                  <th className="py-1 font-normal">&nbsp;</th>
                  <th className="py-1 text-right font-normal">season</th>
                  {showRecent && <th className="py-1 text-right font-normal">last 4</th>}
                  <th className="py-1 text-right font-normal">league</th>
                </tr>
              </thead>
              <tbody>
                {POS.map((pos) => {
                  const s = season.table.get(t.short)?.[pos];
                  const r = recent.table.get(t.short)?.[pos];
                  return (
                    <tr key={pos} className="border-t border-line">
                      <td className="py-1 text-chalk-3">to {pos}s</td>
                      <td className="py-1 text-right">{s ? <span className={tone(s.rank)}>{s.perGame} <span className="text-chalk-3">(No. {s.rank})</span></span> : "–"}</td>
                      {showRecent && <td className="py-1 text-right">{r ? <span className={tone(r.rank)}>{r.perGame} <span className="text-chalk-3">(No. {r.rank})</span></span> : "–"}</td>}
                      <td className="py-1 text-right text-chalk-3">{season.league[pos]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fold({ id, title, summary, open, children }: { id: string; title: string; summary: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details id={id} className="fold" open={open}>
      <summary className="grid grid-cols-[1rem_minmax(0,1fr)] items-baseline gap-x-2 py-3 sm:grid-cols-[1rem_12rem_minmax(0,1fr)]">
        <span className="fold-chev text-chalk-3" aria-hidden>▸</span>
        <span className="display text-xl font-bold text-chalk">{title}</span>
        <span className="col-start-2 truncate text-sm text-chalk-2 sm:col-start-3">{summary}</span>
      </summary>
      <div className="pb-6 pt-1">{children}</div>
    </details>
  );
}

/** The one reason a name is on the read: the matchup note, his top piece of radar evidence, or his stat line. */
function readLine(p: Prospect): string {
  return p.lensNote ?? p.radar?.evidence?.[0]?.label ?? p.stat ?? p.projected;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="mono mt-1 text-xl text-sky">{value}</p>
      {sub && <p className="mono mt-0.5 text-xs text-chalk-3">{sub}</p>}
    </div>
  );
}

function StyleCard({ side, o, d }: { side: string; o?: OffenseProfile; d?: DefenseProfile }) {
  const prof = o ?? d;
  const label = prof?.label ?? "Unavailable";
  const sample = prof?.sample ?? "unavailable";
  const metrics = prof?.metrics;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{side}</p>
        {sample === "small" && <span className="mono text-[10px] text-flag-2">small sample</span>}
        {sample === "unavailable" && <span className="mono text-[10px] text-chalk-3">no charting</span>}
      </div>
      <p className="mt-0.5 text-base font-semibold text-chalk">{label}</p>
      {prof?.summary && <p className="mt-1 text-sm leading-snug text-chalk-2">{prof.summary}</p>}
      {metrics && metrics.length > 0 && (
        <dl className="mono mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
          {metrics.filter((m) => ["passRate", "earlyPass", "sr", "ex", "rushSr", "passEx", "ly", "pdSr", "pressure", "blitz", "playAction", "rzTd"].includes(m.key)).map((m) => (
            <MetricRow key={m.key} m={m} />
          ))}
        </dl>
      )}
      {sample !== "unavailable" && !metrics && o && (
        <dl className="mono mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-chalk-2">
          <Row k="Pass rate" v={`${o.passRate}% (${o.neutralPassRate}% neutral)`} />
          <Row k="Pace" v={`${o.secondsPerPlay}s per play`} />
          <Row k="Structure" v={o.structure ?? ""} />
          <Row k="Run game" v={o.runGame ?? ""} />
          <Row k="Pass game" v={o.passGame ?? ""} />
          <Row k="Success / explosive" v={`${o.successRate}% / ${o.explosiveRate}%`} />
          <Row k="Pressure allowed" v={`${o.pressureAllowed}%`} />
        </dl>
      )}
      {sample !== "unavailable" && !metrics && d && (
        <dl className="mono mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-chalk-2">
          <Row k="Front" v={d.front ?? ""} />
          <Row k="Coverage" v={d.coverage ?? ""} />
          <Row k="Blitz / pressure" v={`${d.blitzRate}% / ${d.pressureRate}%`} />
          <Row k="Stuff rate" v={`${d.stuffRate}%`} />
          <Row k="Explosives allowed" v={`${d.explosivesAllowed}%`} />
        </dl>
      )}
      {sample === "unavailable" && (
        <p className="mt-1 text-xs text-chalk-3">Play-by-play has not been ingested for this team yet.</p>
      )}
    </div>
  );
}

function MetricRow({ m }: { m: NonNullable<OffenseProfile["metrics"]>[number] }) {
  const pct = m.pct;
  const tone = pct === undefined ? "text-chalk-2" : pct >= 75 ? "text-turf" : pct <= 25 ? "text-brick" : "text-chalk-2";
  return (
    <>
      <dt className="relative text-chalk-3">
        {m.label}
        {m.key in TERMS && <InfoTip label={m.label} what={TERMS[m.key as keyof typeof TERMS]} context={m.rank ? "Ranked among the 32 teams for this side of the ball: No. 1 is the best at it." : undefined} />}
      </dt>
      <dd className={`text-right ${tone}`}>{m.value}</dd>
      <dd className="w-14 text-right text-chalk-3">{m.rank ? `No. ${m.rank}` : ""}</dd>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-chalk-3">{k}</dt>
      <dd className="text-chalk-2">{v}</dd>
    </>
  );
}

function weatherHeadline(g: Game) {
  const flags = evaluateWeather(g.weather!);
  const top = flags.find((f) => f.level === "elevated") ?? flags.find((f) => f.level === "flag") ?? flags[0];
  return top ? top.title : `${g.weather!.tempF}°, calm`;
}

function roofLabel(r: NonNullable<Game["weather"]>["roof"]) {
  return r === "open" ? "open air" : r === "fixed" ? "fixed roof" : r === "retractable-closed" ? "roof closed" : "retractable, status unknown";
}

/** One line for the Fourth downs fold: how many calls, and the costliest one the model disagreed with. */
function fourthSummary(downs: FourthDown[]): string {
  const costly = downs.filter((d) => !d.agree && d.cost >= 3).sort((a, b) => b.cost - a.cost);
  const base = `${downs.length} ${downs.length === 1 ? "decision" : "decisions"}`;
  if (!costly.length) return `${base}, none that cost 3+ points of win probability`;
  const top = costly[0];
  return `${base}; costliest: the ${top.team} chose to ${top.callWord} on ${top.situation.split(",")[0]} (${top.cost.toFixed(1)} pts)`;
}
