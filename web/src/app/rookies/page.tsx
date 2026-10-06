import Link from "next/link";
import { genDraft, genExtras, genMeta, generatedLoaded } from "@/lib/generated";
import { radarIndex, GROUP_LABEL, pickForPercentile, type RadarPlayer } from "@/lib/radar";
import { Avatar } from "@/components/Avatar";
import { gameIndexForWeek } from "@/lib/slate";
import { nflTeams, logoUrl } from "@/lib/nfl";
import type { Game } from "@/lib/types";

export const dynamic = "force-dynamic";

const COLLEGE_URL = process.env.COLLEGE_EDGESHEET_URL || "http://localhost:3000/draft";

/**
 * Rookie class: every first-year player with a stat line, ranked by production
 * against his draft slot. The slot score runs 100 (pick 1) to 8 (undrafted); the
 * production score is the percentile against the league at his position group.
 * "Producing like pick No. N" is the pick whose slot score equals that percentile.
 */
export default async function RookiesPage({ searchParams }: PageProps<"/rookies">) {
  const sp = await searchParams;
  const loaded = generatedLoaded();
  const meta = genMeta();
  const season = meta?.season ?? new Date().getFullYear();
  const tab = sp.year === String(season - 1) ? season - 1 : sp.year === "incoming" ? "incoming" : season;
  const pos = typeof sp.pos === "string" ? sp.pos : undefined;

  const idx = loaded ? radarIndex() : undefined;
  const picks = genDraft();
  const games: Map<string, Game> = loaded ? await gameIndexForWeek() : new Map();

  const classOf = (yr: number): RadarPlayer[] =>
    (idx ? [...idx.byId.values()] : [])
      .filter((p) => p.draftClass === yr && p.classYear !== null && p.classYear <= 2 && p.production > 0)
      .filter((p) => !pos || p.group === pos)
      .map((p) => ({ ...p, vsSlot: p.vsSlot ?? p.production - p.pedigree, eqPick: p.eqPick ?? pickForPercentile(p.production) }))
      .sort((a, b) => (b.vsSlot ?? 0) - (a.vsSlot ?? 0) || b.score - a.score);
  const rows = typeof tab === "number" ? classOf(tab) : [];
  const groups = [...new Set((idx ? [...idx.byId.values()] : []).filter((p) => typeof tab === "number" && p.draftClass === tab && p.production > 0).map((p) => p.group))].sort();

  const classPicks = typeof tab === "number" ? picks.filter((p) => p.year === tab) : [];
  const byRound = new Map<number, number>();
  for (const p of classPicks) byRound.set(p.round, (byRound.get(p.round) ?? 0) + 1);
  const withLine = typeof tab === "number" ? rows.length : 0;
  const quiet = typeof tab === "number" ? classPicks.filter((p) => p.id && !idx?.byId.get(p.id)?.production).length : 0;

  return (
    <div>
      <p className="eyebrow">Rookie class{meta ? ` · stats as of ${new Date(meta.ingestedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">{tab === "incoming" ? "Incoming" : `${tab} class`}</h1>
      <p className="mt-2 max-w-3xl text-base text-chalk-3">
        Every drafted or undrafted first-year player with a stat line, ranked by production against his draft slot. The slot score runs 100 for pick 1 to 8 for an undrafted player; the production score is his percentile against the league at his position. A positive number means he is producing above where he was taken. Last year&apos;s class is scored on this season&apos;s production, so the question becomes who grew in year two.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="seg">
          <Link href="/rookies" aria-current={tab === season}>{season}</Link>
          <Link href={`/rookies?year=${season - 1}`} aria-current={tab === season - 1}>{season - 1} (year 2)</Link>
          <Link href="/rookies?year=incoming" aria-current={tab === "incoming"}>Incoming</Link>
        </span>
        {typeof tab === "number" && (
          <span className="scroll-x flex gap-1.5">
            <Link href={`/rookies${tab !== season ? `?year=${tab}` : ""}`} className="chip !py-1 !text-[11px]" aria-pressed={!pos}>All</Link>
            {groups.map((g) => (
              <Link key={g} href={`/rookies?${tab !== season ? `year=${tab}&` : ""}pos=${g}`} className="chip !py-1 !text-[11px]" aria-pressed={pos === g}>{g}</Link>
            ))}
          </span>
        )}
      </div>

      {!loaded && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-3xl text-chalk">Rookie data needs ingest</p>
          <p className="mt-1 text-base text-chalk-3">Run <code className="mono">npm run ingest</code> inside web/.</p>
        </div>
      )}

      {tab === "incoming" && (
        <section className="card mt-6 p-6">
          <p className="eyebrow">Next year&apos;s class</p>
          <h2 className="display mt-1 text-3xl font-bold text-chalk">The college EdgeSheet keeps the forecast board</h2>
          <p className="mt-2 max-w-2xl text-base text-chalk-2">
            Draft-eligible college players, the scouting radar, and the next-draft forecast live in the college app and are not duplicated here. One link, one source.
          </p>
          <a href={COLLEGE_URL} className="chip mt-4 inline-flex" target="_blank" rel="noreferrer">Open the college forecast board</a>
          <p className="mono mt-2 text-xs text-chalk-3">Set COLLEGE_EDGESHEET_URL in .env.local to point at the deployed college site. Default is the local dev server on port 3000.</p>
        </section>
      )}

      {typeof tab === "number" && loaded && (
        <>
          <section className="mt-6 grid gap-2 text-sm text-chalk-3 sm:grid-cols-3">
            <div className="card p-4">
              <p className="eyebrow">Class size</p>
              <p className="display mt-1 text-3xl font-bold text-chalk">{classPicks.length} picks</p>
              <p className="mt-1">{[...byRound].sort((a, b) => a[0] - b[0]).map(([r, n]) => `R${r} ${n}`).join(" · ")}</p>
            </div>
            <div className="card p-4">
              <p className="eyebrow">With a stat line{pos ? ` (${pos})` : ""}</p>
              <p className="display mt-1 text-3xl font-bold text-chalk">{withLine}</p>
              <p className="mt-1">drafted and undrafted, production above zero at the position</p>
            </div>
            <div className="card p-4">
              <p className="eyebrow">Drafted, no production yet</p>
              <p className="display mt-1 text-3xl font-bold text-chalk">{quiet}</p>
              <p className="mt-1">linemen, injured, or not yet playing; they are listed by pick below</p>
            </div>
          </section>

          <section className="mt-8">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="display text-4xl font-bold text-chalk">Production against the slot</h2>
              <span className="mono text-xs text-chalk-3">{rows.length} names · sorted by slot beaten</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <ol className="mt-3 grid gap-2 md:grid-cols-2">
              {rows.slice(0, 80).map((p, i) => (
                <RookieRow key={p.id} p={p} i={i} games={games} />
              ))}
            </ol>
            {rows.length === 0 && <p className="mt-3 text-sm text-chalk-3">No first-year player at this position has a stat line yet.</p>}
          </section>

          <section className="mt-10">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="display text-3xl font-bold text-chalk">Round 1, {tab}</h2>
              <span className="mono text-xs text-chalk-3">nflverse draft file</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <ol className="mt-3 grid gap-1 sm:grid-cols-2">
              {classPicks.filter((p) => p.round === 1).sort((a, b) => a.pick - b.pick).map((p) => {
                const r = p.id ? idx?.byId.get(p.id) : undefined;
                const nt = nflTeams().find((t) => t.short === p.nfl);
                return (
                  <li key={p.pick} className="card flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="display w-8 text-3xl font-extrabold text-navy">{p.pick}</span>
                    {nt && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoUrl(nt.abbr)} alt="" className="h-6 w-6 object-contain" />
                    )}
                    <span className="min-w-0 flex-1">
                      {r ? <Link href={`/player/${r.id}`} className="display block truncate text-xl font-bold text-chalk hover:text-sky">{p.name}</Link> : <span className="display block truncate text-xl font-bold text-chalk">{p.name}</span>}
                      <span className="mono text-[11px] text-chalk-3">{p.pos} · {p.college ?? "college n/a"} · {p.nfl}{r?.injury?.status ? ` · ${r.injury.status}` : ""}</span>
                    </span>
                    <span className="mono ml-auto text-right text-xs text-chalk-3">{r && r.production > 0 ? <>like No. {r.eqPick ?? pickForPercentile(r.production)}<br />{r.stat}</> : "no stat line yet"}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

function RookieRow({ p, i, games }: { p: RadarPlayer; i: number; games: Map<string, Game> }) {
  const g = games.get(p.team);
  const team = g ? (g.home.short === p.team ? g.home : g.away) : undefined;
  const nt = nflTeams().find((t) => t.short === p.team);
  const vs = p.vsSlot ?? 0;
  return (
    <li className="card flex items-center gap-3 px-3 py-2.5">
      <span className="display w-8 shrink-0 text-right text-2xl font-extrabold text-navy">{i + 1}</span>
      <Avatar jersey={p.jersey} color={team?.color ?? nt?.color ?? "#3b4658"} logo={team?.logo ?? (nt ? logoUrl(nt.abbr) : undefined)} size="sm" playerId={p.id} name={p.name} src={p.headshot ?? undefined} />
      <span className="min-w-0 flex-1">
        <Link href={`/player/${p.id}`} className="display block truncate text-xl font-bold text-chalk hover:text-sky">{p.name}</Link>
        <span className="mono text-[11px] text-chalk-3">
          {p.pos} · {p.team} · {p.cls}{p.height ? ` · ${Math.floor(p.height / 12)}-${p.height % 12}, ${p.weight}` : ""} · {GROUP_LABEL[p.group]}{p.college ? ` · ${p.college}` : ""}
        </span>
        <span className="block truncate text-xs text-chalk-2">{p.stat}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="mono text-[11px] font-semibold text-navy">{p.slot ? `Drafted No. ${p.slot}` : "Undrafted"}, producing like pick No. {p.eqPick}</span>
          {p.injury?.status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${p.injury.status === "Out" ? "bg-brick text-white" : "bg-ink-2 text-chalk-2"}`}>{p.injury.status}</span>}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${vs >= 20 ? "bg-turf text-white" : vs >= 0 ? "bg-navy text-white" : vs >= -20 ? "bg-ink-2 text-chalk" : "bg-ink-2 text-chalk-3"}`}>{vs >= 0 ? "+" : ""}{vs} vs slot</span>
        <span className="mono text-xs text-chalk-3" title="production percentile, then snap share">{p.production} · {p.usage}%</span>
      </span>
    </li>
  );
}

/** His combine numbers from nflverse (PFR), when he tested: 40, vertical, broad jump, 3-cone. */
function combineLine(id: string): string | undefined {
  const c = genExtras()?.players[id]?.combine;
  if (!c) return undefined;
  const bits = [c.forty && `40 ${c.forty}`, c.vert && `vertical ${c.vert} in`, c.broad && `broad ${c.broad} in`, c.cone && `3-cone ${c.cone}`].filter(Boolean);
  return bits.length ? bits.join(" · ") : undefined;
}
