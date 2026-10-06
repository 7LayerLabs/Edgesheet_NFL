import Link from "next/link";
import Image from "next/image";
import type { Game } from "@/lib/types";
import { prospectCounts, scoreTag, scoutScore } from "@/lib/score";
import { weatherRisk, evaluateWeather } from "@/lib/weather";
import { kickoffTime, spreadText } from "@/lib/format";
import { sideTier, tierLabel, totalTier } from "@/lib/leans";
import { CoverageBadge, StatusPill } from "./badges";
import { ScoutScore } from "./ScoutScore";
import { LiveLine } from "./LiveLine";

/** `band`: a high or low game total for the season (the home page); `implied`: the implied team totals. */
export function GameCard({ game, index = 0, band, implied }: { game: Game; index?: number; band?: "high" | "low"; implied?: { home: number; away: number } }) {
  const score = scoutScore(game.scoreComponents);
  const tag = scoreTag(game);
  const { likely, future } = prospectCounts(game);
  const risk = weatherRisk(game.weather);
  const topFlag = game.weather ? evaluateWeather(game.weather).find((f) => f.level !== "note") : undefined;
  const projectionsKnown = game.source === "sample" || likely + future > 0;
  const topName = game.source === "live" ? game.prospects.find((p) => p.tier === "Rookie" || p.tier === "Breakout" || p.tier === "Matchup") : undefined;

  return (
    <Link
      href={`/game/${game.id}`}
      className={`card rise group block min-w-0 overflow-hidden p-4 transition-colors hover:bg-panel-2 ${game.status === "final" ? "final-card" : ""} ${band === "high" ? "border-l-4 border-l-turf" : ""}`}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className="flex gap-4">
        {/* Score column */}
        <div className="w-16 shrink-0 sm:w-20">
          <ScoutScore score={score} size="md" tag={undefined} />
          <div className={`eyebrow mt-1 ${tag === "Hidden Gem" ? "text-turf" : ""}`}>{tag}</div>
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mono text-xs text-chalk-2">{kickoffTime(game.kickoff)} ET</span>
            <span className="text-xs text-chalk-3">{game.network}</span>
            <StatusPill status={game.status} clock={game.score?.clock} />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <TeamLine team={game.away} score={game.score?.away} />
            <span className="text-chalk-3">@</span>
            <TeamLine team={game.home} score={game.score?.home} />
          </div>

          <LiveLine game={game} />

          <p className="mt-2 line-clamp-2 text-sm leading-snug text-chalk-2">{game.whyWatch}</p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            {projectionsKnown ? (
              <span className="text-chalk-2">
                <span className="text-chalk">{likely}</span> {game.source === "live" ? "to watch" : `likely ${likely === 1 ? "pick" : "picks"}`}
                {future > 0 && (
                  <>
                    , <span className="text-chalk">{future}</span> more
                  </>
                )}
                {topName && <span className="text-chalk-3"> · {topName.name} ({topName.pos}{topName.tier === "Rookie" ? ", rookie" : topName.tier === "Breakout" ? ", breakout" : ""})</span>}
              </span>
            ) : (
              <span className="text-chalk-3">Nobody on radar yet</span>
            )}
            <ModelCall game={game} />
            {topFlag && (
              <span className={risk === "high" ? "text-brick" : "text-warn"}>
                {risk === "high" ? "▲" : "△"} {topFlag.title}
              </span>
            )}
            {game.market.spread ? (
              <span className="mono text-sky">
                {spreadText(game.market.spread.team, game.market.spread.line)}
                {game.market.total ? ` · ${game.market.total.line}` : ""}
                {implied && (
                  <span className="text-chalk-3">
                    {" "}({game.away.abbr} {implied.away.toFixed(1)}, {game.home.abbr} {implied.home.toFixed(1)})
                  </span>
                )}
              </span>
            ) : (
              <span className="mono text-chalk-3">No line</span>
            )}
            {band && game.status !== "final" && (
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${band === "high" ? "bg-turf/10 text-turf" : "bg-ink-2 text-chalk-3"}`}>{band === "high" ? "High total" : "Low total"}</span>
            )}
            {game.coverage !== "Full" && <CoverageBadge level={game.coverage} />}
          </div>
        </div>
      </div>
    </Link>
  );
}

function TeamLine({ team, score }: { team: Game["home"]; score?: number }) {
  const hasScore = score !== undefined && Number.isFinite(score);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {team.logo ? (
        <Image src={team.logo} alt="" width={18} height={18} className="h-[18px] w-[18px] shrink-0 object-contain" unoptimized />
      ) : (
        <span className="inline-block h-3 w-1 shrink-0 rounded-sm" style={{ background: team.color }} aria-hidden />
      )}
      <span className="display truncate text-lg font-semibold text-chalk transition-colors group-hover:text-flag">
        {team.rank && (
          <span className="mr-1 text-sm text-flag" title={team.rankPoll}>
            {team.rankPoll && !/^AP/i.test(team.rankPoll) ? <span className="mono mr-0.5 text-[9px] uppercase tracking-wider text-chalk-3">{team.rankPoll.includes("FCS") ? "FCS" : team.rankPoll.includes("Division II") ? "DII" : team.rankPoll.includes("Division III") ? "DIII" : ""}</span> : null}
            {team.rank}
          </span>
        )}
        <span className="sm:hidden">{team.short.length > 14 ? team.abbr : team.short}</span>
        <span className="hidden sm:inline">{team.short}</span>
      </span>
      {team.record && <span className="mono whitespace-nowrap text-[11px] text-chalk-3">{team.record}</span>}
      {hasScore && <span className="mono ml-1 text-base text-chalk">{score}</span>}
    </span>
  );
}

/** The model's call in one line: the winner and margin, then any gap to the posted side or total. Live and final games carry the locked call. */
function ModelCall({ game }: { game: Game }) {
  const p = game.projection;
  if (!p) return null;
  const s = game.market.spread;
  const sTier = sideTier(p.sideGap ?? 0);
  const tTier = p.totalLean && p.totalLean !== "none" ? totalTier(p.totalGap ?? 0) : undefined;
  const sideLine = p.modelSide && s ? (p.modelSide === s.team ? s.line : -s.line) : undefined;
  return (
    <span className="text-chalk-2">
      <span className="font-semibold text-chalk">{game.status === "upcoming" ? "Model" : "Call"} {p.winner} by {p.margin.toFixed(1)}</span>
      {sTier && sideLine !== undefined && <span> · {tierLabel(sTier)} {p.modelSide} {sideLine > 0 ? "+" : ""}{sideLine}</span>}
      {tTier && <span> · {tierLabel(tTier)} {p.totalLean} {p.modelTotal}</span>}
    </span>
  );
}
