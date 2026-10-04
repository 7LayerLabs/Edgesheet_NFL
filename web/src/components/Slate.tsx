"use client";

import { useMemo, useState } from "react";
import type { Game } from "@/lib/types";
import { scoutScore, scoreTag, prospectCounts } from "@/lib/score";
import { weatherRisk } from "@/lib/weather";
import { kickoffWindow, type Window } from "@/lib/format";
import { useWatchlist } from "@/lib/watchlist";
import { GameCard } from "./GameCard";
import { flipScore } from "@/lib/live";

type Quick = "All" | "Live" | "Flip to" | "Upcoming" | "Finished" | "Division games" | "Rookie Heavy" | "Hidden Gems" | "Watchlist" | "Prime time";
const QUICK: Quick[] = ["All", "Live", "Flip to", "Upcoming", "Finished", "Division games", "Rookie Heavy", "Hidden Gems", "Prime time", "Watchlist"];

type Group = "window" | "division" | "score";
const WINDOWS: Window[] = ["Noon", "Afternoon", "Prime time", "Late night"];
const confOf = (g: Game) => g.home.conference || g.away.conference || "Other";
const DIV_ORDER = ["AFC East", "AFC North", "AFC South", "AFC West", "NFC East", "NFC North", "NFC South", "NFC West"];

/** All 32 teams are one division: nothing to filter by level. Group by kickoff window, by the home team's division, or by Watch Score. */
export function Slate({ games }: { games: Game[] }) {
  const [quick, setQuick] = useState<Quick>("All");
  const [weatherOnly, setWeatherOnly] = useState(false);
  const [sort, setSort] = useState<"kickoff" | "score">("kickoff");
  const [group, setGroup] = useState<Group>("window");
  const [q, setQ] = useState("");
  const { list } = useWatchlist();

  const filtered = useMemo(() => {
    let out = games;
    switch (quick) {
      case "Live": out = out.filter((g) => g.status === "live"); break;
      case "Flip to": out = out.filter((g) => g.status === "live"); break;
      case "Upcoming": out = out.filter((g) => g.status === "upcoming"); break;
      case "Finished": out = out.filter((g) => g.status === "final"); break;
      case "Division games": out = out.filter((g) => g.divGame); break;
      case "Rookie Heavy": out = out.filter((g) => prospectCounts(g).likely >= 2); break;
      case "Hidden Gems": out = out.filter((g) => scoreTag(g) === "Hidden Gem"); break;
      case "Prime time": out = out.filter((g) => g.status === "live" || kickoffWindow(g.kickoff) === "Prime time" || kickoffWindow(g.kickoff) === "Late night"); break;
      case "Watchlist":
        out = out.filter(
          (g) =>
            list.games.includes(g.id) ||
            list.teams.includes(g.home.short) ||
            list.teams.includes(g.away.short) ||
            g.prospects.some((p) => list.players.includes(p.id)),
        );
        break;
    }
    if (weatherOnly) out = out.filter((g) => weatherRisk(g.weather) !== "none");
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter((g) =>
        [g.home.short, g.home.name, g.home.abbr, g.home.conference, g.away.short, g.away.name, g.away.abbr, g.away.conference, g.network, g.venue]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }
    if (quick === "Flip to") return [...out].sort((a, b) => flipScore(b) - flipScore(a) || a.kickoff.localeCompare(b.kickoff));
    out = [...out].sort((a, b) =>
      sort === "score"
        ? scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents)
        : a.kickoff.localeCompare(b.kickoff) || scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents),
    );
    return out;
  }, [games, quick, weatherOnly, sort, list, q]);

  const grouped = useMemo((): (readonly [string, Game[]])[] => {
    if (quick === "Flip to") return [["Flip to, best first", filtered] as const];
    const byKick = (a: Game, b: Game) => a.kickoff.localeCompare(b.kickoff) || scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents);
    const byScore = (a: Game, b: Game) => scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents);
    const within = sort === "score" ? byScore : byKick;

    if (group === "division") {
      const m = new Map<string, Game[]>();
      for (const g of filtered) m.set(confOf(g), [...(m.get(confOf(g)) ?? []), g]);
      const order = [...m.keys()].sort((a, b) => (DIV_ORDER.indexOf(a) === -1 ? 99 : DIV_ORDER.indexOf(a)) - (DIV_ORDER.indexOf(b) === -1 ? 99 : DIV_ORDER.indexOf(b)));
      return order.map((c) => [`${c} hosts`, m.get(c)!.sort(within)] as const);
    }
    if (group === "score" || sort === "score") return [["By Watch Score", [...filtered].sort(byScore)] as const];
    return WINDOWS.map((w) => [w, filtered.filter((g) => kickoffWindow(g.kickoff) === w).sort(byKick)] as const).filter(([, gs]) => gs.length);
  }, [filtered, sort, quick, group]);

  return (
    <div>
      {/* Search */}
      <label className="block">
        <span className="sr-only">Search teams, divisions, networks</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a team, division, or network"
          className="w-full rounded border border-line bg-white px-3 py-2 text-base text-chalk placeholder:text-chalk-3 focus:border-navy focus:outline-none"
        />
      </label>

      {/* Quick filters */}
      <div className="scroll-x -mx-4 mt-3 flex gap-2 px-4 pb-1">
        {QUICK.map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={quick === k} onClick={() => setQuick(k)}>
            {k === "Live" && <span className="live-dot" />}
            {k}
          </button>
        ))}
      </div>

      {/* Extras */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={weatherOnly}
          onClick={() => setWeatherOnly((v) => !v)}
          className="mono rounded border border-line px-2 py-1 text-[11px] tracking-wider text-chalk-3 aria-pressed:border-warn aria-pressed:text-warn"
        >
          Weather risk only
        </button>
      </div>

      {/* Group by + order */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <span className="eyebrow">Group by</span>
          <span className="seg">
            <button type="button" aria-pressed={group === "window"} onClick={() => setGroup("window")}>Window</button>
            <button type="button" aria-pressed={group === "division"} onClick={() => setGroup("division")}>Division</button>
            <button type="button" aria-pressed={group === "score"} onClick={() => setGroup("score")}>Watch Score</button>
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="eyebrow">Order</span>
          <span className="seg">
            <button type="button" aria-pressed={sort !== "score"} onClick={() => setSort("kickoff")}>Kickoff</button>
            <button type="button" aria-pressed={sort === "score"} onClick={() => setSort("score")}>Watch Score</button>
          </span>
        </span>
        <span className="text-xs text-chalk-3">{filtered.length} games shown</span>
      </div>

      {/* Groups */}
      {grouped.length === 0 && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-2xl text-chalk">Nothing matches</p>
          <p className="mt-1 text-sm text-chalk-3">
            {quick === "Watchlist" ? "Follow a team, a game, or a player and it shows up here." : "Loosen a filter. Every scheduled game is on the slate."}
          </p>
        </div>
      )}
      {grouped.map(([label, gs]) => (
        <section key={label} className="mt-6">
          <div className="mb-2 flex items-baseline gap-3">
            <h2 className="display text-2xl font-bold text-chalk">{label}</h2>
            <span className="mono text-xs text-chalk-3">{gs.length} {gs.length === 1 ? "game" : "games"}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="grid min-w-0 gap-2.5">
            {gs.map((g, i) => (
              <GameCard key={g.id} game={g} index={i} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
