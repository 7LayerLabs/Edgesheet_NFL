import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlayer } from "@/lib/slate";
import { asOf, kickoffTime } from "@/lib/format";
import { genMeta } from "@/lib/generated";
import { GROUP_LABEL } from "@/lib/radar";
import { Confidence, Tier } from "@/components/badges";
import { FollowButton } from "@/components/FollowButton";
import { Avatar } from "@/components/Avatar";
import { RadarScore } from "@/components/ProspectCard";
import { Suspense } from "react";
import { PlayerNews } from "@/components/PlayerNews";
import { BeatFeedFallback } from "@/components/BeatFeed";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: PageProps<"/player/[id]">) {
  const { id } = await params;
  const hit = await getPlayer(id);
  if (!hit) notFound();
  const { player: p, game } = hit;
  const team = game ? (p.team === game.home.abbr ? game.home : game.away) : undefined;
  const r = p.radar;
  const meta = genMeta();

  return (
    <article className="rise">
      {game ? (
        <Link href={`/game/${game.id}`} className="mono text-xs text-chalk-3 hover:text-chalk">
          ← {game.away.short} @ {game.home.short}
        </Link>
      ) : (
        <Link href="/radar" className="mono text-xs text-chalk-3 hover:text-chalk">← Radar</Link>
      )}

      <header className="mt-3 flex items-start gap-4">
        <Avatar jersey={p.jersey} color={team?.color ?? "#3a4957"} logo={team?.logo} size="lg" playerId={p.id} name={p.name} src={p.headshot} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-chalk-2">{team?.name ?? r?.team ?? p.team}</span>
            <Tier tier={p.tier} />
            {p.injury?.status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${p.injury.status === "Out" ? "bg-brick text-white" : p.injury.status === "Doubtful" ? "bg-warn text-chalk" : "border border-line bg-white text-chalk-2"}`}>{p.injury.status}{p.injury.injury ? ` · ${p.injury.injury}` : ""}</span>}
          </div>
          <h1 className="display mt-1 text-5xl font-extrabold leading-none text-chalk sm:text-6xl">{p.name}</h1>
          <p className="mono mt-2 text-sm text-chalk-3">
            {p.pos}{r ? ` (${GROUP_LABEL[r.group]})` : ""} · {p.cls}{p.ht ? ` · ${p.ht}, ${p.wt} lb` : ""}{r?.college ? ` · ${r.college}` : ""}{r?.depth ? ` · depth chart ${r.depth.pos} No. ${r.depth.rank}` : ""}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <FollowButton kind="players" id={p.id} />
            {r && <span className="mono text-xs text-chalk-3">Stats as of {asOf(meta?.ingestedAt ?? new Date().toISOString())}</span>}
          </div>
        </div>
        {r && (
          <div className="text-right">
            <RadarScore score={r.score} size="lg" />
            <p className="eyebrow mt-1">Watch Score</p>
          </div>
        )}
      </header>

      <section className="mt-8 grid gap-2 sm:grid-cols-3">
        <Box label="Draft slot">
          <span className="display text-4xl font-bold text-chalk">{r?.slot ? `No. ${r.slot}` : "UDFA"}</span>
          <span className="text-xs text-chalk-3">{r?.eligibilityNote ?? p.projected}</span>
        </Box>
        <Box label={r?.vsSlot !== null && r?.vsSlot !== undefined ? "Against the slot" : "Lens"}>
          {r && r.vsSlot !== null && r.eqPick !== null ? (
            <>
              <span className="display text-4xl font-bold text-chalk">{r.vsSlot >= 0 ? "+" : ""}{r.vsSlot}</span>
              <span className="text-xs text-chalk-3">{r.slot ? `Drafted No. ${r.slot}` : "Undrafted"}, producing like pick No. {r.eqPick}. Production percentile minus the slot score.</span>
            </>
          ) : (
            <>
              <span className="text-lg font-semibold text-chalk">{p.tier === "Breakout" && r?.breakout ? r.breakout.label : `${p.tier} radar`}</span>
              <Confidence level={p.projectionConfidence} />
              <span className="text-xs text-chalk-3">Not a grade. Ranks production, snap share, and context.</span>
            </>
          )}
        </Box>
        <Box label="Injury report">
          {p.injury?.status ? (
            <>
              <span className={`display text-4xl font-bold ${p.injury.status === "Out" ? "text-brick" : p.injury.status === "Doubtful" ? "text-warn" : "text-chalk"}`}>{p.injury.status}</span>
              <span className="text-xs text-chalk-3">{p.injury.injury ? `${p.injury.injury}. ` : ""}{p.injury.practice ? `${p.injury.practice}. ` : ""}Week {p.injury.week} official report.</span>
            </>
          ) : r?.injury?.practice ? (
            <>
              <span className="display text-4xl font-bold text-chalk-3">Listed</span>
              <span className="text-xs text-chalk-3">{r.injury.injury ? `${r.injury.injury}. ` : ""}{r.injury.practice}. No game status. Week {r.injury.week} report.</span>
            </>
          ) : (
            <>
              <span className="display text-4xl font-bold text-chalk-3">Not listed</span>
              <span className="text-xs text-chalk-3">Not on the latest official injury report.</span>
            </>
          )}
        </Box>
      </section>

      {r && (
        <section className="mt-8 grid gap-2 sm:grid-cols-4">
          <Meter label="Production" value={r.production} note={`percentile vs NFL ${r.group}${r.qocLabel !== "unmeasured" ? `, ${r.qocLabel} schedule` : ""}`} />
          <Meter label="Snap share" value={r.usage} note={r.snapShare !== null ? `${Math.round(r.snapShare * 100)}% of unit snaps` : "no snap counts yet"} />
          <Meter label="Draft slot" value={r.pedigree} note={r.slot ? `pick No. ${r.slot}, ${r.draftClass}` : "undrafted"} />
          <Meter label="Size" value={r.size === null ? 40 : r.size ? 100 : 0} note={r.size === null ? "unknown" : r.size ? "meets NFL norms" : "under NFL norms"} />
        </section>
      )}

      {r?.breakout && (
        <section className="card mt-8 border-l-4 border-l-turf p-4">
          <p className="eyebrow">Breakout</p>
          <p className="display mt-1 text-3xl font-bold text-chalk">{r.breakout.label}</p>
          <p className="mt-1 text-sm text-chalk-2">{r.breakout.metric === "target share" ? `Target share is his share of the team's targets in games he played, averaged by week.` : `Production per game uses the same formula as the radar, this season against last.`}{r.lastSeason ? ` Last season: ${r.lastSeason}.` : ""}</p>
        </section>
      )}

      <section className="mt-8">
        <p className="eyebrow">{r ? "Season line" : "Traits"}</p>
        {r && r.statLine.length > 0 ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {r.statLine.map((s) => (
              <div key={s.label} className="card px-3 py-2">
                <dt className="eyebrow">{s.label}</dt>
                <dd className="mono mt-0.5 text-xl text-chalk">{s.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {p.traits.map((t) => (
              <span key={t} className="rounded bg-panel px-3 py-1.5 text-sm text-chalk">{t}</span>
            ))}
            {p.weakness && <span className="rounded bg-panel px-3 py-1.5 text-sm text-brick">{p.weakness}</span>}
            {r && <span className="text-sm text-chalk-3">No box-score stats for this position. {r.evidence.map((e) => e.label).join(" · ")}</span>}
          </div>
        )}
        {r && r.gamesPlayed ? <p className="mono mt-2 text-xs text-chalk-3">{r.gamesPlayed} games with a stat line this season.{r.lastSeason ? ` Last season: ${r.lastSeason}.` : ""}</p> : null}
      </section>

      {p.lines && p.lines.length > 0 && (
        <section className="mt-8">
          <p className="eyebrow text-turf">This week&apos;s game</p>
          <ul className="mono mt-2 grid gap-1 text-sm text-chalk">
            {p.lines.map((l) => (
              <li key={l.category}>{l.headline}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <p className="eyebrow">What to watch</p>
        <p className="mt-2 max-w-3xl text-lg leading-snug text-chalk">{p.watchFor}</p>
        {p.weakness && <p className="mt-2 text-sm text-brick">{p.weakness}</p>}
      </section>

      <section className="mt-8">
        <p className="eyebrow">This week</p>
        {game ? (
          <Link href={`/game/${game.id}`} className="card mt-2 flex items-center justify-between gap-3 p-4 hover:bg-panel-2">
            <span className="display text-2xl font-bold text-chalk">
              {game.away.short} @ {game.home.short}
            </span>
            <span className="mono text--right text-xs text-chalk-3">{kickoffTime(game.kickoff)} ET · {game.network}</span>
          </Link>
        ) : (
          <p className="mt-2 text-sm text-chalk-3">No game on this week&apos;s schedule for the {r?.team ?? p.team} (bye).</p>
        )}
      </section>

      {/* Beat feed items that name this player, plus a highlights link. Context only. */}
      <section className="mt-8">
        <p className="eyebrow">In the news</p>
        <Suspense fallback={<BeatFeedFallback />}>
          <PlayerNews player={{ id: p.id, name: p.name, team: team?.short ?? r?.team ?? p.team }} />
        </Suspense>
      </section>
    </article>
  );
}

function Box({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card flex flex-col gap-1 p-4">
      <p className="eyebrow">{label}</p>
      {children}
    </div>
  );
}

function Meter({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">{label}</p>
        <span className="mono text-sm text-chalk">{value}</span>
      </div>
      <div className="meter mt-2"><span style={{ width: `${value}%` }} /></div>
      <p className="mt-1 text-[11px] text-chalk-3">{note}</p>
    </div>
  );
}
