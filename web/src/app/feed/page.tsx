import Link from "next/link";
import { Suspense } from "react";
import { radarForGame } from "@/lib/radar";
import { BeatFeed, BeatFeedFallback } from "@/components/BeatFeed";
import { SleepersPanel } from "@/components/SleepersPanel";
import type { FeedPlayer } from "@/lib/feed";

export const dynamic = "force-dynamic";

const MAX_TEAMS = 6;

/**
 * /feed?team=Bears&team=Packers
 * The watchlist lives in localStorage, so the watchlist page links here with the followed teams in the query.
 */
export default async function FeedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = sp.team;
  const teams = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TEAMS);

  const players: FeedPlayer[] = [];
  for (const t of teams) {
    try {
      for (const r of radarForGame(t, 6)) players.push({ id: r.id, name: r.name, team: r.team });
    } catch {}
  }

  return (
    <div>
      <p className="eyebrow">Beat feed</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk">{teams.length ? teams.join(", ") : "Pick teams"}</h1>
      <p className="mt-2 max-w-2xl text-sm text-chalk-2">
        The last 3 days of posts and headlines from Bluesky, Reddit, and Google News, tagged to radar players they name. Fan posts are opinion. Nothing here feeds the report.
      </p>

      {teams.length === 0 ? (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">No teams in the link</p>
          <p className="mt-1 text-sm text-chalk-3">
            Follow teams from the standings, then open the feed from your watchlist. Or add them to the address: /feed?team=Bears&amp;team=Packers
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/watchlist" className="inline-block rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Watchlist</Link>
            <Link href="/standings" className="inline-block rounded border border-line-2 bg-white px-4 py-2 text-sm font-semibold text-chalk">Standings</Link>
          </div>
        </div>
      ) : (
        <section className="mt-6">
          <div className="flex flex-wrap gap-2">
            {teams.map((t) => (
              <Link key={t} href={`/feed?team=${encodeURIComponent(t)}`} className="chip">
                {t}
              </Link>
            ))}
          </div>
          <Suspense fallback={<p className="mb-4 text-xs text-chalk-3">Reading the beat for sleepers.</p>}>
            <SleepersPanel teams={teams} players={players} />
          </Suspense>
          <Suspense fallback={<BeatFeedFallback />}>
            <BeatFeed schools={teams} players={players} />
          </Suspense>
        </section>
      )}
    </div>
  );
}
