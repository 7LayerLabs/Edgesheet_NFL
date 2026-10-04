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
import { CoverageBadge, DivisionTag, StatusPill } from "@/components/badges";
import { ScoutScore } from "@/components/ScoutScore";
import { FollowButton } from "@/components/FollowButton";
import { ProspectCard } from "@/components/ProspectCard";
import { LineMovement } from "@/components/LineMovement";
import { PropsForRadar } from "@/components/PropsForRadar";
import { LivePanel } from "@/components/LivePanel";
import { LivePoller } from "@/components/LivePoller";
import { WrittenReport } from "@/components/WrittenReport";
import { ConsensusLine, ConsensusTable } from "@/components/ConsensusTable";
import { Suspense } from "react";
import { BeatFeed, BeatFeedFallback } from "@/components/BeatFeed";
import { SituationalCues, SituationsTable } from "@/components/Situations";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: PageProps<"/game/[id]">) {
  const { id } = await params;
  const game = await getGame(id);
  if (!game) notFound();

  const score = scoutScore(game.scoreComponents);
  const tag = scoreTag(game);
  const flags = game.weather ? evaluateWeather(game.weather) : [];
  const { likely, future } = prospectCounts(game);

  const TIERS: Prospect["tier"][] = ["Matchup", "Rookie", "Breakout", "Watch"];
  const byTier = new Map<Prospect["tier"], Prospect[]>();
  for (const p of game.prospects) byTier.set(p.tier, [...(byTier.get(p.tier) ?? []), p]);
  const tiers = TIERS.filter((t) => byTier.has(t));
  const TIER_TITLE: Record<Prospect["tier"], [string, string]> = { Matchup: ["On the spot", "the unit edges put these players in the game plan"], Rookie: ["Rookie class", "ranked against the draft slot"], Breakout: ["Breakout watch", "year 2 and 3 jumps against last season"], Watch: ["Watch", "starters worth knowing"] };

  return (
    <article className="rise">
      <Link href={game.source === "live" ? `/?date=${etDateOf(game.kickoff)}` : "/"} className="mono text-xs text-chalk-3 hover:text-chalk">← Slate</Link>

      {/* 1. Header */}
      <header className={`mt-3 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-start ${game.status === "final" ? "rounded border-l-4 border-brick pl-4" : ""}`}>
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <DivisionTag d={game.division} />
            <span className="mono text-xs text-chalk-2">{kickoffTime(game.kickoff)} ET</span>
            <span className="text-xs text-chalk-3">{game.network}</span>
            <StatusPill status={game.status} clock={game.score?.clock} />
            <LivePoller active={game.status === "live"} />
            <CoverageBadge level={game.coverage} />
          </div>
          <h1 className="display mt-2 text-5xl font-extrabold leading-none text-chalk sm:text-6xl">
            <TeamName t={game.away} score={game.score?.away} />
            <span className="mx-2 text-chalk-3 sm:mx-3">@</span>
            <TeamName t={game.home} score={game.score?.home} />
          </h1>
          <p className="mt-2 text-sm text-chalk-3">
            {game.venue} · {game.city}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <FollowButton kind="games" id={game.id} />
            {game.source === "live" && (
              <>
                <FollowButton kind="teams" id={game.away.short} label={`Follow ${game.away.short}`} size="sm" />
                <FollowButton kind="teams" id={game.home.short} label={`Follow ${game.home.short}`} size="sm" />
              </>
            )}
            <span className="mono text-xs text-chalk-3">Report as of {asOf(game.reportAsOf)}</span>
          </div>
        </div>
        <div className="sm:w-48">
          <ScoutScore score={score} tag={tag} size="lg" />
          <p className="mt-2 text-xs text-chalk-3">
            {game.source === "live"
              ? likely + future === 0
                ? "Nobody clears the radar yet"
                : `${likely} to watch · ${future} more on the radar`
              : `${likely} likely ${likely === 1 ? "pick" : "picks"} · ${future} future ${future === 1 ? "name" : "names"}`}
          </p>
        </div>
      </header>

      {game.gaps && game.gaps.length > 0 && (
        <aside className="card mt-6 border-chalk-3/40 p-4">
          <p className="eyebrow">Coverage {game.coverage} · what this report cannot say</p>
          <ul className="mt-2 grid gap-1 text-sm text-chalk-2 sm:grid-cols-2">
            {game.gaps.map((g) => (
              <li key={g} className="flex gap-2"><span className="text-chalk-3">–</span>{g}</li>
            ))}
          </ul>
        </aside>
      )}
      {/* Jump bar */}
      <nav className="jumpbar" aria-label="Sections">
        {[
          ["why", "Why watch"],
          ["report", "Report"],
          ["decided", "Decided by"],
          ["radar", "Watch radar"],
          ["eye", "Eye on"],
          ["showed", game.status === "upcoming" ? "Live" : "Who showed up"],
          ["style", "Team style"],
          ["conditions", "Conditions"],
          ["market", "Market"],
          ["storylines", "Storylines"],
          ["injuries", "Injuries"],
          ["feed", "Feed"],
          ["score", "Score"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`}>{label}</a>
        ))}
      </nav>

      {/* 2. Why watch */}
      <Section n="Why watch" id="why" title={game.whyWatch}>
        <ol className="mt-3 grid gap-2 sm:grid-cols-3">
          {game.whyWatchReasons.map((r, i) => (
            <li key={i} className="card p-4 text-base leading-snug text-chalk-2">
              <span className="display block text-3xl font-bold text-flag">{i + 1}</span>
              <span className="mt-1 block">{r}</span>
            </li>
          ))}
        </ol>
      </Section>

      {/* Written report (AI layer, cached on disk, never generated on page load) */}
      <WrittenReport game={game} />

      {/* 7. Matchups */}
      {game.matchups.length > 0 ? (
        <Section n="Matchups" id="decided" title="Where the game gets decided">
          <div className="card mt-3 border-l-4 border-l-navy p-5">
            <div className="flex items-center gap-3">
              <TeamMark team={game.away} state={game.matchups[0]?.edge === "even" ? "even" : (game.matchups[0]?.a.startsWith(game.away.short) ? game.matchups[0]?.edge === "offense" : game.matchups[0]?.edge === "defense") ? "win" : "lose"} />
              <TeamMark team={game.home} state={game.matchups[0]?.edge === "even" ? "even" : (game.matchups[0]?.a.startsWith(game.home.short) ? game.matchups[0]?.edge === "offense" : game.matchups[0]?.edge === "defense") ? "win" : "lose"} />
              <p className="eyebrow">Pressure point</p>
            </div>
            <p className="mt-2 text-lg leading-relaxed text-chalk">{game.pressurePoint}</p>
          </div>
          <p className="mt-4 max-w-3xl text-base text-chalk-3">
            Each offense against the opposing defense on the four axes that decide games. Ranks are inside the 32. The gap is in percentile points; 40 or more is a clear edge, 55 or more is a mismatch.
          </p>
          <div className="mt-3 grid gap-3">
            {game.matchups.map((m, i) => {
              const tone = m.edge === "offense" ? "border-l-4 border-l-turf" : m.edge === "defense" ? "border-l-4 border-l-sky" : "border-l-4 border-l-line-2";
              const label = m.strength === "dominant" ? "Mismatch" : m.strength === "clear" ? "Clear edge" : m.strength === "real" ? "Edge" : "Even";
              const labelTone = m.strength === "dominant" ? "bg-brick text-white" : m.strength === "clear" ? "bg-navy text-white" : m.strength === "real" ? "bg-ink-2 text-chalk" : "bg-ink-2 text-chalk-3";
              return (
                <div key={i} className={`card p-5 ${tone}`}>
                  {(() => {
                    const offTeam = m.a.startsWith(game.home.short) ? game.home : game.away;
                    const defTeam = offTeam === game.home ? game.away : game.home;
                    const winner = m.edge === "offense" ? offTeam : m.edge === "defense" ? defTeam : undefined;
                    return (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${labelTone}`}>{label}</span>
                        <TeamMark team={offTeam} state={winner ? (winner === offTeam ? "win" : "lose") : "even"} />
                        <span className="display text-2xl font-bold text-chalk">{m.a}</span>
                        <span className="text-chalk-3">vs</span>
                        <TeamMark team={defTeam} state={winner ? (winner === defTeam ? "win" : "lose") : "even"} />
                        <span className="display text-2xl font-bold text-chalk">{m.b}</span>
                        {winner && (
                          <span className={`ml-auto flex items-center gap-2 text-sm font-semibold ${m.edge === "offense" ? "text-turf" : "text-sky"}`}>
                            Advantage {winner.short}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <p className="mt-3 text-lg leading-relaxed text-chalk">{m.why}</p>
                  {m.watch && <p className="mt-2 text-base text-chalk-2"><span className="eyebrow mr-1">Watch for</span>{m.watch}</p>}
                  <p className="mono mt-2 text-xs text-chalk-3">Evidence: {m.evidence}</p>
                </div>
              );
            })}
          </div>
          {game.situations && <SituationalCues cues={game.situations.cues} />}
          {game.projection && <ProjectionBox game={game} />}
        </Section>
      ) : (
        <Section n="Matchups" id="decided" title="Not charted yet">
          <p className="mt-2 text-base text-chalk-3">{game.pressurePoint}</p>
          {game.projection && <ProjectionBox game={game} />}
        </Section>
      )}

      {/* 6. Prospects */}
      <Section n="Must watch" id="radar" title={game.prospects.length ? "Who to watch, by lens" : "Nobody clears the radar yet"}>
        {game.prospects.some((p) => p.radar) && (
          <p className="mt-1 max-w-3xl text-sm text-chalk-3">
            Radar entries rank evidence: production percentile against the league at the position, snap share, draft slot, and last season's line. Injury status is the official report. They are not grades.
            {game.statsAsOf ? ` Stats as of ${asOf(game.statsAsOf)}.` : ""}
          </p>
        )}
        {tiers.map((y) => (
          <div key={y} className="mt-5">
            <div className="flex items-baseline gap-3">
              <span className="display text-3xl font-bold text-chalk">{TIER_TITLE[y][0]}</span>
              <span className="mono text-xs text-chalk-3">{TIER_TITLE[y][1]}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="mt-2 grid gap-2.5 md:grid-cols-2">
              {byTier.get(y)!.map((p) => (
                <ProspectCard key={p.id} p={p} team={p.team === game.home.abbr ? game.home : game.away} />
              ))}
            </div>
          </div>
        ))}
        {game.odds && game.prospects.length > 0 && <PropsForRadar gameId={game.id} odds={game.odds} prospects={game.prospects} upcoming={game.status === "upcoming"} />}
        {game.prospects.length === 0 && (
          <p className="mt-2 text-sm text-chalk-3">No player on either roster clears the production or snap-share thresholds. See Keep an eye on below.</p>
        )}
      </Section>

      {/* 8. Keep an eye on */}
      {game.keepAnEyeOn.length > 0 && (
        <Section n="Keep an eye on" id="eye" title="More names on the radar">
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {game.keepAnEyeOn.map((k) => (
              <li key={k.name} className="card p-4">
                <span className="display text-2xl font-semibold text-chalk">{k.name}</span>
                <span className="mono ml-2 text-xs text-chalk-3">{k.team}</span>
                <p className="mt-1 text-base text-chalk-2">{k.note}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 10. Live / postgame */}
      <Section
        id="showed"
        n={game.status === "final" ? "Postgame" : "Live"}
        title={game.box ? (game.box.source === "espn" && game.status === "live" ? "Who is showing up" : "Who showed up") : game.status === "final" ? "Box score not published yet" : game.status === "live" ? (game.live ? "Live from the feed" : "Box score arrives when the game settles") : "Opens at kickoff"}
      >
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
                        <span className="mono w-16 shrink-0 text-[10px] uppercase tracking-wider text-chalk-3">{l.category === "interceptions" ? "INT" : l.category.slice(0, 7)}</span>
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
              Radar players above show their line from this game. Stock does not move automatically; one game is one data point.
            </p>
            {game.archive?.postgame && <Accountability entry={game.archive} />}
          </>
        ) : (
          <p className="mt-2 text-base text-chalk-3">
            {game.status === "upcoming"
              ? "Box score leaders and each radar player's line appear here once the game starts."
              : "The data feed posts player stats after the game settles. Check back in a few minutes."}
          </p>
        )}
        {game.status === "upcoming" && game.archive && (
          <p className="mono mt-3 text-xs text-chalk-3">
            Pregame call locked {asOf(game.archive.pregame.capturedAt)}: {game.archive.pregame.edges.length} matchup calls, {game.archive.pregame.prospects.length} radar names, Watch Score {game.archive.pregame.scoutScore}. It gets graded against the box score after the final. <Link href="/history" className="text-sky">See the record</Link>.
          </p>
        )}
      </Section>

      {/* 3. Team style */}
      <Section n="Team style" id="style" title={game.offense[game.home.abbr]?.sample === "unavailable" ? "Tendencies not charted yet" : "How each side wants to play"}>
        {game.statsAsOf && <p className="mono mt-1 text-xs text-chalk-3">Play-by-play through {asOf(game.statsAsOf)}. Ranks are inside the 32.</p>}
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
      </Section>

      {/* 4. Weather */}
      <Section n="Conditions" id="conditions" title={game.weather ? weatherHeadline(game) : "No forecast available"}>
        {game.weather && (
          <>
            <div className="mono mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-chalk-2">
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
                {game.weather.windMph > 0
                  ? `Wind ${game.weather.windDir} ${game.weather.windMph} mph`
                  : "Calm"}
                {game.weather.windComponent && game.weather.fieldBearing != null
                  ? `, ${componentPhrase(game.weather.windComponent)} (field runs ${axisLabel(game.weather.fieldBearing)}${game.weather.fieldBearingConfidence !== "high" ? ", from the stadium outline" : ""}).`
                  : game.weather.fieldBearing != null
                    ? `. Field runs ${axisLabel(game.weather.fieldBearing)}.`
                    : ". Field orientation is not on file for this venue, so the crosswind call is unmeasured."}
              </p>
            )}
            {game.climate ? (
              <p className="mt-1 text-sm text-chalk-2">{baselineLine(game.climate, game.weather)}</p>
            ) : (
              <p className="mt-1 text-sm text-chalk-3">No weather baseline on file for this venue.</p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {flags.length === 0 && (
                <p className="card p-4 text-sm text-chalk-2">No weather flag. Conditions are not expected to change play calling.</p>
              )}
              {flags.map((f) => (
                <div
                  key={f.key}
                  className={`card p-4 ${f.level === "elevated" ? "border-brick/60" : f.level === "flag" ? "border-warn/50" : ""}`}
                >
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
        {!game.weather && game.climate && <p className="mt-2 text-sm text-chalk-2">{baselineLine(game.climate)}</p>}
      </Section>

      {/* 5. Market */}
      <Section n="Market" id="market" title={game.market.spread ? `${spreadText(game.market.spread.team, game.market.spread.line)}, total ${game.market.total?.line}` : "No widely available line"}>
        {game.market.spread ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Stat label="Consensus spread" value={spreadText(game.market.spread.team, game.market.spread.line)} sub={moveText(game.market.spread.open, game.market.spread.line)} />
            {game.market.total && <Stat label="Total" value={String(game.market.total.line)} sub={moveText(game.market.total.open, game.market.total.line)} />}
            {game.market.moneyline ? (
              <Stat label="Moneyline" value={`${game.home.abbr} ${mlText(game.market.moneyline.home)} / ${game.away.abbr} ${mlText(game.market.moneyline.away)}`} sub={`one book; ${game.market.books} ${game.market.books === 1 ? "book" : "books"} on the spread`} />
            ) : (
              <Stat label="Books" value={String(game.market.books)} sub="consensus median" />
            )}
            <p className="mono text-xs text-chalk-3 sm:col-span-3">
              As of {asOf(game.market.asOf)}. Shown as game context, not a pick.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-chalk-3">No book we track lists this game. The report does not estimate a line.</p>
        )}
        {game.projection && (game.projection.vsMarket || game.projection.totalNote) && <ModelVsMarket game={game} />}
        {game.odds && <LineMovement odds={game.odds} home={game.home} away={game.away} />}
      </Section>

      {/* 9. Storylines */}
      <Section n="Storylines" id="storylines" title="Context that changes how you watch">
        {game.storylines.length === 0 && <p className="mt-2 text-sm text-chalk-3">Nothing on file beyond the schedule.</p>}
        <ul className="mt-3 grid gap-1.5">
          {game.storylines.map((s) => (
            <li key={s} className="flex gap-3 text-sm text-chalk-2">
              <span className="text-flag">—</span>
              {s}
            </li>
          ))}
        </ul>
      </Section>

      {/* Official injury report */}
      {game.injuryReport && game.injuryReport.length > 0 && (
        <Section n="Injury report" id="injuries" title={`Official report, week ${game.injuryReport[0].week}`}>
          <p className="mt-1 text-sm text-chalk-3">From the nflverse injuries file (the league's official practice and game status reports). Out, Doubtful, and Questionable only.</p>
          <div className="mt-3 grid gap-2.5 md:grid-cols-2">
            {[game.away, game.home].map((t) => (
              <div key={t.id} className="card p-4">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-4 w-1 rounded-sm" style={{ background: t.color }} />
                  <span className="display text-2xl font-bold">{t.short}</span>
                </div>
                <ul className="mt-2 grid gap-1 text-sm">
                  {game.injuryReport!.filter((i) => i.team === t.abbr).map((i) => (
                    <li key={i.id + i.name} className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${i.status === "Out" ? "bg-brick text-white" : i.status === "Doubtful" ? "bg-warn text-chalk" : "bg-ink-2 text-chalk-2"}`}>{i.status}</span>
                      <span className="font-medium text-chalk">{i.name}</span>
                      <span className="mono text-xs text-chalk-3">{i.pos}{i.injury ? ` · ${i.injury}` : ""}{i.practice ? ` · ${i.practice}` : ""}</span>
                    </li>
                  ))}
                  {game.injuryReport!.filter((i) => i.team === t.abbr).length === 0 && <li className="text-chalk-3">Nobody listed.</li>}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Beat feed: posts and headlines about both teams, tagged to radar players. Context only, never a source for the report. */}
      <Section n="Beat feed" id="feed" title={`What people are saying about ${game.away.short} and ${game.home.short}`}>
        <Suspense fallback={<BeatFeedFallback />}>
          <BeatFeed
            schools={[game.away.short, game.home.short]}
            players={game.prospects.map((p) => ({ id: p.id, name: p.name, team: p.team === game.home.abbr ? game.home.short : game.away.short }))}
          />
        </Suspense>
      </Section>

      {/* Score breakdown */}
      <Section n="Watch Score" id="score" title={`${score} out of 100`}>
        <div className="mt-3 grid gap-2">
          {COMPONENT_KEYS.map((k) => {
            const v = game.scoreComponents[k];
            return (
              <div key={k} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-xs sm:grid-cols-[12rem_1fr_3rem]">
                <span className={v === null ? "text-chalk-3" : "text-chalk-2"}>
                  {COMPONENT_LABELS[k]} <span className="text-chalk-3">{Math.round(WEIGHTS[k] * 100)}%</span>
                </span>
                {v === null ? (
                  <span className="mono text-[10px] text-chalk-3">not available, excluded</span>
                ) : (
                  <div className="meter"><span style={{ width: `${v}%` }} /></div>
                )}
                <span className="mono text-right text-chalk">{v === null ? "–" : v}</span>
              </div>
            );
          })}
          <p className="mt-1 text-xs text-chalk-3">
            Ranks viewing value, not team quality. Competitive expectation, unit mismatches, rookie and breakout density, stakes from the standings, and the broadcast window.
            {availableWeight(game.scoreComponents) < 0.999 && ` Scored on ${Math.round(availableWeight(game.scoreComponents) * 100)}% of the weights; excluded inputs are not ingested yet.`}
          </p>
        </div>
      </Section>

    </article>
  );
}

/* ---------------------------------------------------------------- bits */

function ModelVsMarket({ game }: { game: Game }) {
  const p = game.projection!;
  const sideTeam = p.modelSide ? (p.modelSide === game.home.abbr ? game.home : game.away) : undefined;
  const sideStrength = (p.sideGap ?? 0) >= 6 ? "strong" : (p.sideGap ?? 0) >= 3 ? "moderate" : (p.sideGap ?? 0) >= 2 ? "slight" : "none";
  const totalStrength = Math.abs(p.totalGap ?? 0) >= 6 ? "strong" : Math.abs(p.totalGap ?? 0) >= 4 ? "moderate" : Math.abs(p.totalGap ?? 0) >= 2.5 ? "slight" : "none";
  const tone = (s: string) => (s === "strong" ? "bg-brick text-white" : s === "moderate" ? "bg-navy text-white" : s === "slight" ? "bg-ink-2 text-chalk" : "bg-ink-2 text-chalk-3");
  const graded = game.archive?.postgame?.projectionResult;
  return (
    <div className="card mt-4 border-l-4 border-l-brick p-5">
      <p className="eyebrow">What the stats say against the posted numbers · a model, not a pick</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-line bg-panel-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">Side</span>
            <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone(sideStrength)}`}>{sideStrength === "none" ? "no lean" : `${sideStrength} lean`}</span>
          </div>
          {sideTeam && game.market.spread ? (
            <>
              <p className="display mt-1 flex items-center gap-2 text-3xl font-bold text-chalk">
                <TeamMark team={sideTeam} state={sideStrength === "none" ? "even" : "win"} />
                {sideTeam.short}
                <span className="mono text-base font-normal text-chalk-3">{spreadText(game.market.spread.team, game.market.spread.line)}</span>
              </p>
              <p className="mt-1 text-base text-chalk">{p.vsMarket}</p>
              <ConsensusLine game={game} />
            </>
          ) : (
            <p className="mt-1 text-base text-chalk-3">No posted spread to compare.</p>
          )}
        </div>
        <div className="rounded border border-line bg-panel-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">Total</span>
            <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone(totalStrength)}`}>{p.totalLean && p.totalLean !== "none" ? `${totalStrength} ${p.totalLean}` : "no lean"}</span>
          </div>
          {p.modelTotal !== undefined && game.market.total ? (
            <>
              <p className="display mt-1 text-3xl font-bold text-chalk">
                {p.totalLean && p.totalLean !== "none" ? p.totalLean.toUpperCase() : "Even"} <span className="mono text-base font-normal text-chalk-3">model {p.modelTotal} · posted {game.market.total.line}</span>
              </p>
              <p className="mt-1 text-base text-chalk">{p.totalNote}</p>
              {p.weatherTilt && <p className="mt-1 text-sm text-chalk-2"><span className="eyebrow mr-1">Weather</span>{p.weatherTilt}</p>}
            </>
          ) : p.modelTotal !== undefined ? (
            <p className="mt-1 text-base text-chalk">Model total {p.modelTotal}. No posted total to compare.</p>
          ) : (
            <p className="mt-1 text-base text-chalk-3">Total needs tendency data for both teams.</p>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-chalk-3">
        Side comes from the projected margin (Elo and unit edges) against the spread. Total comes from each offense&apos;s EPA per play against the other defense, over both teams&apos; pace, plus a weather tilt when the forecast is flagged. A lean under 2 points is noise. Both are locked pregame and graded on the Record page.
        {graded?.totalLeanRight !== undefined && ` Graded: total lean ${graded.totalLeanRight ? "right" : "wrong"}.`}
        {graded?.modelSideCovered !== undefined && ` Side ${graded.modelSideCovered ? "covered" : "did not cover"}.`}
      </p>
    </div>
  );
}

/** Team logo chip. The side with the advantage is full color with a ring; the other side is shaded. */
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

function ProjectionBox({ game }: { game: Game }) {
  const p = game.projection!;
  const winnerTeam = p.winner === game.home.abbr ? game.home : game.away;
  const graded = game.archive?.postgame?.projectionResult;
  const locked = game.archive?.pregame.projection;
  return (
    <div className="card mt-4 border-l-4 border-l-brick p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Projected outcome · a model, not a pick</p>
          <p className="display mt-1 flex flex-wrap items-center gap-x-3 text-4xl font-bold text-chalk sm:text-5xl">
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
          <p className="eyebrow">Confidence</p>
          <p className={`display text-3xl font-bold ${p.confidence === "high" ? "text-turf" : p.confidence === "medium" ? "text-chalk" : "text-chalk-3"}`}>{p.confidence}</p>
          <p className="text-[11px] text-chalk-3">{p.confidence === "high" ? "Elo and tendencies agree on inputs" : p.confidence === "medium" ? "Elo only; no tendency data" : "thin inputs"}</p>
        </div>
      </div>
      <p className="mt-3 text-base leading-relaxed text-chalk">{p.shape}</p>
      {p.vsMarket && (
        <p className="mt-2 rounded border border-line bg-panel-2 px-3 py-2 text-base text-chalk">
          <span className="eyebrow mr-1">vs the number</span>
          {p.vsMarket}
        </p>
      )}
      <ul className="mono mt-3 grid gap-0.5 text-xs text-chalk-3">
        {p.basis.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <ConsensusTable game={game} />
      <p className="mt-2 text-xs text-chalk-3">
        Margin is our pregame Elo (K 20, 48 points of home field, 25 Elo per point) plus 40% of the unit-edge adjustment, with the market total for the score line. Win probability assumes a 13.5-point standard deviation.
        {locked && !graded && ` Locked ${asOf(game.archive!.pregame.capturedAt)}; graded after the final.`}
        {graded && ` Graded: winner ${graded.winnerRight ? "right" : "wrong"}, margin off by ${graded.marginError.toFixed(0)}${graded.modelSideCovered !== undefined ? `, model side ${graded.modelSideCovered ? "covered" : "did not cover"}` : ""}.`}
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
      <ul className="mt-4 grid gap-2">
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
      {hasScore && <span className="text-flag">{score}</span>}
    </span>
  );
}

function Section({ n, id, title, children }: { n: string; id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-28">
      <p className="eyebrow">{n}</p>
      <h2 className="display mt-1 text-3xl font-bold leading-tight text-chalk sm:text-4xl">{title}</h2>
      {children}
    </section>
  );
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
      <dt className="text-chalk-3">{m.label}</dt>
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
