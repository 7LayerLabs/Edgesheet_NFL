import Link from "next/link";
import type { Prospect, Team } from "@/lib/types";
import { Tier } from "./badges";
import { Avatar } from "./Avatar";
import { FollowButton } from "./FollowButton";

/**
 * One prospect, in the game report or on the radar board. Everything shown is
 * evidence with a source: production, draft slot, size, snap share, breakout,
 * and the official injury report. The score ranks evidence; it is not a grade.
 */
export function ProspectCard({ p, team, gameLabel, gameHref, compact = false }: { p: Prospect; team: Team; gameLabel?: string; gameHref?: string; compact?: boolean }) {
  const r = p.radar;
  return (
    <div className="card flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <Avatar jersey={p.jersey} color={team.color} logo={team.logo} size={compact ? "sm" : "md"} playerId={p.id} name={p.name} src={p.headshot} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link href={`/player/${p.id}`} className="display truncate text-2xl font-bold leading-none text-chalk hover:text-flag">
              {p.name}
            </Link>
            {r && <RadarScore score={r.score} />}
          </div>
          <p className="mono mt-1 text-xs text-chalk-3">
            {p.pos} · {team.abbr} · {p.cls}{p.ht ? ` · ${p.ht}, ${p.wt}` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <Tier tier={p.tier} />
            <span className="text-chalk">{p.projected}</span>
            {p.injury?.status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${p.injury.status === "Out" ? "bg-brick text-white" : p.injury.status === "Doubtful" ? "bg-warn text-chalk" : "border border-line bg-white text-chalk-2"}`} title={`Week ${p.injury.week} official report${p.injury.injury ? `: ${p.injury.injury}` : ""}`}>{p.injury.status}{p.injury.injury ? ` · ${p.injury.injury}` : ""}</span>}
          </div>
        </div>
      </div>

      {p.lensNote && <p className="rounded border border-[#e8415b]/40 bg-[#e8415b]/5 px-3 py-2 text-sm leading-snug text-chalk">{p.lensNote}</p>}
      {r ? (
        <ul className="grid gap-1 text-sm">
          {r.evidence.filter((e) => e.kind !== "matchup").slice(0, compact ? 2 : 4).map((e) => (
            <li key={e.kind + e.label} className="flex gap-2 leading-snug">
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${e.kind === "production" ? "bg-flag" : e.kind === "pedigree" ? "bg-sky" : e.kind === "breakout" ? "bg-turf" : e.kind === "injury" ? "bg-brick" : e.kind === "size" ? "bg-turf" : "bg-chalk-3"}`} />
              <span className="text-chalk-2">
                {e.label}
                {e.note && <span className="text-chalk-3"> · {e.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {p.traits.map((t) => (
            <span key={t} className="rounded border border-line bg-ink-2 px-2 py-0.5 text-xs text-chalk-2">{t}</span>
          ))}
        </div>
      )}

      {p.lines && p.lines.length > 0 && (
        <div className="rounded-md border border-turf/40 bg-turf/10 px-3 py-2 text-xs">
          <span className="eyebrow text-turf">In this game</span>
          <ul className="mono mt-1 grid gap-0.5 text-chalk">
            {p.lines.map((l) => (
              <li key={l.category}>{l.headline}</li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (
        <p className="text-sm leading-snug text-chalk-2">
          <span className="eyebrow mr-1">Watch for</span>
          {p.watchFor}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        {gameLabel && gameHref ? (
          <Link href={gameHref} className="mono truncate text-xs text-sky hover:text-chalk">{gameLabel}</Link>
        ) : (
          <span className="mono truncate text-xs text-chalk-3">{p.stat}</span>
        )}
        <FollowButton kind="players" id={p.id} size="sm" />
      </div>
    </div>
  );
}

export function RadarScore({ score, size = "sm" }: { score: number; size?: "sm" | "lg" }) {
  const tone = score >= 75 ? "text-flag" : score >= 55 ? "text-chalk" : "text-chalk-3";
  return (
    <span className={`display shrink-0 font-extrabold leading-none ${tone} ${size === "lg" ? "text-6xl" : "text-2xl"}`} title="Radar score: ranks evidence, not a draft grade">
      {score}
    </span>
  );
}
