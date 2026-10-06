import type { PastGame, StoryGame } from "@/lib/player-history";
import { InfoTip } from "./InfoTip";

const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number | null) => (n === null ? "text-chalk-3" : n >= 3 ? "text-turf" : n <= -3 ? "text-brick" : "text-chalk-2");
const KIND_LABEL: Record<StoryGame["kind"], string> = { revenge: "Revenge games", hometown: "Birth city", college: "College state", "home-state": "Birth state" };

/** One past game: when, where, DK points, his average in his other games that season, and the difference. */
function Row({ g, label }: { g: PastGame; label?: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
      <span className="min-w-0 text-sm text-chalk-2">
        <span className="mono text-xs text-chalk-3">
          {g.season} {g.post ? "playoffs" : `W${g.wk}`} · {g.ha === "home" ? "home" : g.ha === "away" ? `at ${g.opp}` : "neutral"}
        </span>
        {label && <span className="ml-2">{label}</span>}
      </span>
      <span className="mono text-right text-sm">
        <span className="font-semibold text-chalk">{g.dk.toFixed(1)}</span>
        <span className="text-xs text-chalk-3"> DK</span>
        {g.diff !== null && <span className={`ml-2 text-xs ${tone(g.diff)}`}>{signed(g.diff)}</span>}
      </span>
    </li>
  );
}

const avgDiff = (gs: PastGame[]) => {
  const d = gs.map((g) => g.diff).filter((x): x is number => x !== null);
  return d.length ? Math.round((d.reduce((t, x) => t + x, 0) / d.length) * 10) / 10 : null;
};

/** Every game against this week's opponent since 2019, newest first, with the average against his own average. */
export function VsOpponent({ opp, games, meanDiff }: { opp: string; games: PastGame[]; meanDiff: number | null }) {
  if (!games.length) return <p className="mt-2 text-sm text-chalk-3">No games against the {opp} since 2019.</p>;
  const list = [...games].reverse();
  return (
    <div className="card mt-2 px-4 py-2">
      <p className="text-sm text-chalk-2">
        {games.length} {games.length === 1 ? "game" : "games"}
        {meanDiff !== null && (
          <>
            , on average <span className={`mono font-semibold ${tone(meanDiff)}`}>{signed(meanDiff)} DK</span> against his own average those seasons
          </>
        )}
        .
      </p>
      <ul className="mt-1 divide-y divide-line">
        {list.map((g) => (
          <Row key={g.g} g={g} />
        ))}
      </ul>
    </div>
  );
}

/** Every storyline game, grouped by kind, with how he did each time against his own average. */
export function StorylineGames({ stories, notes = {} }: { stories: StoryGame[]; notes?: Record<string, string | undefined> }) {
  if (!stories.length) return <p className="mt-2 text-sm text-chalk-3">No revenge, birth-city, birth-state, or college-state games since 2019.</p>;
  const kinds = (["revenge", "hometown", "college", "home-state"] as const).filter((k) => stories.some((s) => s.kind === k));
  return (
    <div className="mt-2 grid gap-2 md:grid-cols-2">
      {kinds.map((k) => {
        const list = stories.filter((s) => s.kind === k);
        const d = avgDiff(list.map((s) => s.game));
        return (
          <div key={k} className="card relative px-4 py-2">
            <p className="text-sm font-semibold text-chalk">
              {KIND_LABEL[k]}
              {notes[k] && <InfoTip label={KIND_LABEL[k]} what={notes[k]!} />}
              <span className="ml-2 font-normal text-chalk-2">
                {list.length} {list.length === 1 ? "game" : "games"}
                {d !== null && (
                  <>
                    , average <span className={`mono font-semibold ${tone(d)}`}>{signed(d)} DK</span>
                  </>
                )}
              </span>
            </p>
            <ul className="mt-1 divide-y divide-line">
              {list.slice(0, 6).map((s) => (
                <Row key={`${k}-${s.game.g}`} g={s.game} label={s.label} />
              ))}
            </ul>
            {list.length > 6 && (
              <details className="pb-1">
                <summary className="cursor-pointer text-xs font-semibold text-sky">Show {list.length - 6} more</summary>
                <ul className="divide-y divide-line">
                  {list.slice(6).map((s) => (
                    <Row key={`${k}-${s.game.g}`} g={s.game} label={s.label} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
