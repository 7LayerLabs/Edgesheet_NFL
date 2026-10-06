import { genLeaders } from "@/lib/generated";
import { LeadersClient } from "./LeadersClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leaders · EdgeSheet NFL",
  description: "Passing, rushing, receiving, and team efficiency leaders: EPA, success rate, explosive and negative plays, CPOE, pressure, and more.",
};

/**
 * Efficiency leaders from nflverse play-by-play (scripts/ingest-leaders.mjs). Server page picks the season; the
 * client table handles tabs, sorting, the team filter, and the qualified toggle.
 */
export default async function LeadersPage({ searchParams }: PageProps<"/leaders">) {
  const sp = await searchParams;
  const L = genLeaders();
  if (!L || !L.seasons.length) {
    return <p className="text-chalk-3">No leaders yet. Run npm run ingest to build them from play-by-play.</p>;
  }
  const want = Number(typeof sp.season === "string" ? sp.season : NaN);
  const season = L.seasons.includes(want) ? want : L.seasons[0];
  const board = L.boards[String(season)];
  return (
    <div>
      <p className="eyebrow">Leaders</p>
      <h1 className="display text-4xl font-bold text-chalk sm:text-5xl">Who is actually efficient</h1>
      <p className="mt-2 max-w-3xl text-sm text-chalk-2">
        Volume tells you who got the ball. These tell you what it was worth: EPA (expected points added) for value, success rate for consistency, explosive and negative plays for the shape of it, and charting and tracking for why. Sort any column; hover a header for what it means.
      </p>
      <p className="mt-1 max-w-3xl text-xs text-chalk-3">
        {season} regular season through {board.teamGames} team games. Play-by-play from nflverse with nflfastR&apos;s public models (success means EPA above zero; paid sites like TruMedia use their own models, so their percentages differ while yards, carries, and touchdowns match). Qualified: 6.25 carries, 1.875 targets, or 14 dropbacks per team game. Charting from PFR and tracking from NFL Next Gen Stats. Updated {new Date(L.asOf).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET.
      </p>
      <p className="mt-1 max-w-3xl text-xs text-chalk-3">
        Tested before trusting (npm run backtest:efficiency, 2022 to 2025): a back&apos;s first-half rush success barely predicts his second-half DraftKings points (correlation 0.05; his yards per carry 0.33, his points a game 0.59), and adding efficiency to the DraftKings projection did not lower its miss on 2024 and 2025. A quarterback&apos;s EPA a dropback is the stickiest of these (0.52 with second-half points). So these boards are context for why a player is producing, not a pick signal by themselves.
      </p>
      <div className="mt-5">
        <LeadersClient board={board} seasons={L.seasons} season={season} />
      </div>
    </div>
  );
}
