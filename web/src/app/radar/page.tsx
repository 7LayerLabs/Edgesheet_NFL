import Link from "next/link";
import { radarBoard, radarIndex, GROUP_LABEL, type PosGroup, type RadarTier } from "@/lib/radar";
import { generatedLoaded, genMeta } from "@/lib/generated";
import { gameIndexForWeek, radarToProspect } from "@/lib/slate";
import { nflTeams, logoUrl } from "@/lib/nfl";
import { asOf, kickoffTime } from "@/lib/format";
import { ProspectCard } from "@/components/ProspectCard";
import type { Team } from "@/lib/types";

export const dynamic = "force-dynamic";

const GROUPS: PosGroup[] = ["QB", "RB", "WR", "TE", "OL", "EDGE", "DL", "LB", "CB", "S"];
const LENSES: { key: RadarTier | "all"; label: string; blurb: string }[] = [
  { key: "all", label: "All", blurb: "Every rookie, breakout, and starter worth knowing, by Watch Score." },
  { key: "Rookie", label: "Rookies", blurb: "First-year players ranked against their draft slot: production percentile against the league at the position, and the pick that production looks like." },
  { key: "Breakout", label: "Breakouts", blurb: "Year 2 and 3 players whose target share is up 7 points or whose production per game is up 40% on last season." },
  { key: "Watch", label: "Watch", blurb: "Starters by depth chart or snap share with a Watch Score of 50 or better." },
];

function href(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/radar?${s}` : "/radar";
}

export default async function RadarPage({ searchParams }: PageProps<"/radar">) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const loaded = generatedLoaded();
  const meta = genMeta();
  const idx = loaded ? radarIndex() : undefined;

  const lens = (LENSES.find((l) => l.key === str("lens"))?.key ?? "all") as RadarTier | "all";
  const group = GROUPS.includes(str("pos") as PosGroup) ? (str("pos") as PosGroup) : undefined;
  const team = nflTeams().find((t) => t.short === str("team"))?.short;
  const q = str("q");
  const sort = (["score", "production", "usage"].includes(str("sort") ?? "") ? str("sort") : "score") as "score" | "production" | "usage";
  const showAll = str("all") === "1";
  const base = { lens: lens === "all" ? undefined : lens, pos: group, team, q, sort: sort === "score" ? undefined : sort, all: showAll ? "1" : undefined };

  const pool = loaded ? radarBoard({ tier: lens === "all" ? undefined : lens, group, team, q, limit: 5000 }) : [];
  const sorted = sort === "score" ? pool : [...pool].sort((a, b) => (sort === "production" ? b.production - a.production || b.score - a.score : b.usage - a.usage || b.score - a.score));
  const players = showAll ? sorted : sorted.slice(0, 60);
  const games = loaded ? await gameIndexForWeek() : new Map();
  const counts = idx ? { Rookie: idx.all.filter((p) => p.tier === "Rookie").length, Breakout: idx.all.filter((p) => p.tier === "Breakout").length, Watch: idx.all.filter((p) => p.tier === "Watch").length } : undefined;

  return (
    <div>
      <p className="eyebrow">Watch radar{meta ? ` · stats as of ${asOf(meta.ingestedAt)}` : ""}</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">
        {lens === "all" ? "Who to watch" : LENSES.find((l) => l.key === lens)!.label} <span className="text-chalk-3">· {idx?.season ?? ""}</span>
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-chalk-3">{LENSES.find((l) => l.key === lens)!.blurb} Every number comes from nflverse weekly stats, snap counts, the draft file, the depth chart, and the official injury report. Matchup players are assigned per game on the game page.</p>

      {!loaded && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">Radar needs ingested data</p>
          <p className="mt-1 text-sm text-chalk-3">Run <code className="mono">npm run ingest</code> inside web/ to pull rosters, stats, snaps, injuries, and the draft file from nflverse.</p>
        </div>
      )}

      {/* Filters */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="seg">
          {LENSES.map((l) => (
            <Link key={l.key} href={href({ ...base, lens: l.key === "all" ? undefined : l.key })} aria-current={l.key === lens}>
              {l.label}{counts && l.key !== "all" ? ` ${counts[l.key as "Rookie" | "Breakout" | "Watch"]}` : ""}
            </Link>
          ))}
        </span>
        <span className="seg" title="Sort">
          {(["score", "production", "usage"] as const).map((k) => (
            <Link key={k} href={href({ ...base, sort: k === "score" ? undefined : k })} aria-current={k === sort}>{k === "score" ? "Watch Score" : k === "production" ? "Production" : "Snap share"}</Link>
          ))}
        </span>
        <form action="/radar" className="ml-auto flex items-center gap-2">
          {lens !== "all" && <input type="hidden" name="lens" value={lens} />}
          {sort !== "score" && <input type="hidden" name="sort" value={sort} />}
          {group && <input type="hidden" name="pos" value={group} />}
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, team, college"
            className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-chalk placeholder:text-chalk-3 focus:border-navy focus:outline-none"
          />
        </form>
      </div>
      <div className="scroll-x -mx-4 mt-2 flex gap-2 px-4 pb-1">
        <Link href={href({ ...base, pos: undefined })} className="chip" aria-pressed={!group}>All positions</Link>
        {GROUPS.map((g) => (
          <Link key={g} href={href({ ...base, pos: g })} className="chip" aria-pressed={g === group}>{g}</Link>
        ))}
      </div>
      <div className="scroll-x -mx-4 mt-2 flex gap-1.5 px-4 pb-1">
        <Link href={href({ ...base, team: undefined })} className="chip !py-1 !text-[11px]" aria-pressed={!team}>All teams</Link>
        {nflTeams().map((t) => (
          <Link key={t.code} href={href({ ...base, team: t.short })} className="chip !py-1 !text-[11px]" aria-pressed={t.short === team} title={t.name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl(t.abbr)} alt="" className="mr-1 inline-block h-3.5 w-3.5 object-contain" />
            {t.abbr}
          </Link>
        ))}
      </div>

      {loaded && players.length === 0 && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">Nothing on the radar here</p>
          <p className="mt-1 text-sm text-chalk-3">Try another lens, team, or position.</p>
        </div>
      )}

      <ol className="mt-5 grid gap-2.5 md:grid-cols-2">
        {players.map((r, i) => {
          const g = games.get(r.team);
          const nt = nflTeams().find((t) => t.short === r.team);
          const team: Team =
            g && g.home.short === r.team ? g.home : g && g.away.short === r.team ? g.away : { id: r.team, name: nt?.name ?? r.team, short: r.team, abbr: nt?.abbr ?? r.team.slice(0, 3).toUpperCase(), record: "", conference: r.conference ?? "", color: nt?.color ?? "#3a4957", logo: nt ? logoUrl(nt.abbr) : undefined };
          const p = radarToProspect(r, team.abbr);
          const label = g
            ? `${i + 1}. ${g.home.short === r.team ? "vs" : "at"} ${g.home.short === r.team ? g.away.short : g.home.short} · ${kickoffTime(g.kickoff)} ET${g.status === "final" ? " · Final" : ""}`
            : `${i + 1}. bye this week`;
          return (
            <li key={r.id}>
              <ProspectCard p={p} team={team} gameLabel={label} gameHref={g ? `/game/${g.id}` : "/radar"} compact />
            </li>
          );
        })}
      </ol>

      {loaded && pool.length > players.length && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm text-chalk-3">Showing {players.length} of {pool.length} on the radar for this lens, team, and position. Search finds anyone on a roster with a stat line.</span>
          <Link href={href({ ...base, all: "1" })} className="chip">Show all {pool.length}</Link>
        </div>
      )}
      {loaded && showAll && (
        <div className="mt-4">
          <Link href={href({ ...base, all: undefined })} className="chip">Show top 60</Link>
        </div>
      )}

      {loaded && (
        <section className="mt-10 grid gap-2 text-xs text-chalk-3 sm:grid-cols-2">
          <div className="card p-4">
            <p className="eyebrow">How the Watch Score works</p>
            <p className="mt-1 leading-relaxed">
              Production is a percentile against every player at the same position group across the league, per game where volume matters, blended half and half with an opponent-adjusted version when a game log exists. Snap share is the player&apos;s share of his unit&apos;s snaps from nflverse snap counts. The score is 50% production, 30% snap share, and 20% context: how far above his draft slot a rookie or second-year player is producing, a breakout against last season, or a starting job. Linemen have no box-score stats, so their score leans on the depth chart, snap share, and size, and the game page adds the unit&apos;s run game and pressure numbers.
            </p>
          </div>
          <div className="card p-4">
            <p className="eyebrow">What it is not</p>
            <p className="mt-1 leading-relaxed">
              It is not a grade and it does not know about film, scheme, or contracts. The draft slot comparison says what pick a player&apos;s production percentile corresponds to, nothing more. Injury status is the league&apos;s official report, read as published. Follow anyone here and their games land on your watchlist.
            </p>
          </div>
        </section>
      )}

      <p className="mt-6 text-xs text-chalk-3">
        Position groups: {GROUPS.map((g) => `${g} = ${GROUP_LABEL[g]}`).join(", ")}.
      </p>
    </div>
  );
}
