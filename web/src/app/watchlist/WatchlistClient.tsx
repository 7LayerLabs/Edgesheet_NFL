"use client";

import Link from "next/link";
import type { Game, Prospect } from "@/lib/types";
import { useWatchlist } from "@/lib/watchlist";
import { GameCard } from "@/components/GameCard";
import { FollowButton } from "@/components/FollowButton";
import { kickoffTime } from "@/lib/format";
import { Tier } from "@/components/badges";

export function WatchlistClient({ games }: { games: Game[] }) {
  const { list, ready } = useWatchlist();
  const followedGames = games.filter((g) => list.games.includes(g.id));
  const followedPlayers: { player: Prospect; game: Game }[] = [];
  for (const g of games) for (const p of g.prospects) if (list.players.includes(p.id)) followedPlayers.push({ player: p, game: g });
  const teamGames = games.filter((g) => list.teams.includes(g.home.short) || list.teams.includes(g.away.short));
  const idle = list.teams.filter((t) => !teamGames.some((g) => g.home.short === t || g.away.short === t));
  const playsToday = [...followedPlayers.map((p) => p.game.id), ...teamGames.map((g) => g.id)].filter((id) => !list.games.includes(id));
  const alsoGames = games.filter((g) => playsToday.includes(g.id));

  return (
    <div>
      <p className="eyebrow">Watchlist</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk">Your week</h1>

      {ready && followedGames.length + followedPlayers.length + list.teams.length === 0 && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">Nothing followed yet</p>
          <p className="mt-1 text-sm text-chalk-3">Follow teams from the standings, watch a game from its report, or follow a player.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/standings" className="inline-block rounded bg-navy px-4 py-2 text-sm font-semibold text-white">Standings</Link>
            <Link href="/" className="inline-block rounded border border-line-2 bg-white px-4 py-2 text-sm font-semibold text-chalk">Browse the slate</Link>
          </div>
        </div>
      )}

      {ready && list.teams.length > 0 && (
        <section className="mt-6">
          <h2 className="display text-2xl font-bold text-chalk">Teams you follow</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {list.teams.map((t) => {
              const g = teamGames.find((x) => x.home.short === t || x.away.short === t);
              const team = g ? (g.home.short === t ? g.home : g.away) : undefined;
              return (
                <span key={t} className="card flex items-center gap-2 py-1.5 pl-3 pr-1.5 text-sm text-chalk">
                  {team?.rank && <span className="text-flag">{team.rank}</span>}
                  {t}
                  {!g && <span className="text-xs text-chalk-3">(idle this week)</span>}
                  <FollowButton kind="teams" id={t} size="sm" />
                </span>
              );
            })}
          </div>
          {idle.length > 0 && idle.length === list.teams.length && (
            <p className="mt-2 text-xs text-chalk-3">None of your teams play this week.</p>
          )}
          <Link
            href={`/feed?${list.teams.map((t) => `team=${encodeURIComponent(t)}`).join("&")}`}
            className="mt-3 inline-block rounded border border-line-2 bg-white px-3 py-1.5 text-sm font-semibold text-chalk hover:bg-panel-2"
          >
            Beat feed for your teams
          </Link>
        </section>
      )}

      {followedPlayers.length > 0 && (
        <section className="mt-6">
          <h2 className="display text-2xl font-bold text-chalk">Players you follow</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {followedPlayers.map(({ player: p, game }) => (
              <div key={p.id} className="card flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/player/${p.id}`} className="display text-2xl font-bold text-chalk hover:text-flag">
                    <span className="mr-2 text-flag">#{p.jersey}</span>{p.name}
                  </Link>
                  <p className="mono mt-0.5 text-xs text-chalk-3">
                    {p.pos} · {p.team} · plays {kickoffTime(game.kickoff)} ET on {game.network}
                  </p>
                  <div className="mt-1.5"><Tier tier={p.tier} /></div>
                </div>
                <FollowButton kind="players" id={p.id} size="sm" />
              </div>
            ))}
          </div>
        </section>
      )}

      {(followedGames.length > 0 || alsoGames.length > 0) && (
        <section className="mt-6">
          <h2 className="display text-2xl font-bold text-chalk">Games</h2>
          <div className="mt-2 grid gap-2.5">
            {followedGames.map((g, i) => <GameCard key={g.id} game={g} index={i} />)}
            {alsoGames.length > 0 && <p className="eyebrow mt-2">Because of teams and players you follow</p>}
            {alsoGames.map((g, i) => <GameCard key={g.id} game={g} index={i} />)}
          </div>
        </section>
      )}

      {ready && list.games.length > followedGames.length && (
        <p className="mt-4 text-xs text-chalk-3">
          {list.games.length - followedGames.length} followed {list.games.length - followedGames.length === 1 ? "game is" : "games are"} not in this week&apos;s slate.
        </p>
      )}

      <section className="mt-8">
        <p className="eyebrow">Alerts</p>
        <p className="mt-1 text-sm text-chalk-3">
          Kickoff reminders, Hidden Gem alerts, weather changes, and line moves are opt-in by category. Notifications are not wired in this prototype.
        </p>
      </section>
    </div>
  );
}
