import Link from "next/link";
import { asOf } from "@/lib/format";
import { howItWent, readGuide, type WatchGuide as Guide } from "@/lib/watchguide";
import { seasonOf } from "@/lib/report";
import type { Game } from "@/lib/types";
import { Avatar } from "./Avatar";

/**
 * Server component. The viewing guide for the Why watch section: a hook, three things to
 * look for (who, what, when), and after kickoff a one-line "How it went" per player item
 * from the box score. Reads the cached guide from disk; never calls a model on page load.
 * Renders nothing when no guide is published, so the page can fall back to the old cards.
 */
export function WatchGuide({ game, guide }: { game: Game; guide: Guide }) {
  const cached = readGuide(seasonOf(game.kickoff), game.id);
  const stale = cached?.status === "upcoming" && game.status === "final";
  return (
    <div className="mt-3">
      <p className="text-lg leading-snug text-chalk">{guide.hook}</p>
      <ol className="mt-3 grid gap-2 sm:grid-cols-3">
        {guide.items.map((it, i) => {
          const p = it.whoPlayerId ? game.prospects.find((x) => x.id === it.whoPlayerId) : undefined;
          const team = p ? (p.team === game.home.abbr ? game.home : game.away) : undefined;
          const went = howItWent(it, game);
          return (
            <li key={i} className="card flex flex-col p-4">
              <div className="flex items-center gap-3">
                {p && team ? (
                  <Link href={`/player/${p.id}`} className="shrink-0">
                    <Avatar jersey={p.jersey} color={team.color} logo={team.logo} size="md" playerId={p.id} name={p.name} />
                  </Link>
                ) : (
                  <span className="display flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-navy text-2xl font-bold text-white">{i + 1}</span>
                )}
                <div className="min-w-0">
                  <p className="eyebrow truncate">{p ? <Link href={`/player/${p.id}`} className="hover:text-flag">{it.who}</Link> : it.who}</p>
                  <h3 className="display text-2xl font-bold leading-none text-chalk">{it.title}</h3>
                </div>
              </div>
              <p className="mt-3 text-base leading-snug text-chalk-2">{it.what}</p>
              <p className="mono mt-2 text-xs text-chalk-3">When: {it.when}</p>
              {went && (
                <p className="mt-2 border-t border-line pt-2 text-sm text-chalk">
                  <span className="eyebrow mr-1">How it went</span>
                  {went}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {cached && (
        <p className="mono mt-2 text-[11px] text-chalk-3">
          Guide by {cached.model} {asOf(cached.generatedAt)}, ranked by {cached.ranker === "jev" ? "Jev" : "fixed priority"} from {cached.candidateCount} sourced things to watch. Every name and number checked against the source{cached.attempts > 1 ? `, ${cached.attempts} attempts` : ""}.
          {stale ? " Written before kickoff." : ""}
        </p>
      )}
    </div>
  );
}
