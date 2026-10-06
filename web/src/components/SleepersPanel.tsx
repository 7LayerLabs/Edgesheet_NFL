import Link from "next/link";
import type { FeedPlayer } from "@/lib/feed";
import { sleepersFor } from "@/lib/sleepers";
import type { Vacated } from "@/lib/vacated";
import { TERMS } from "@/lib/terms";
import { InfoTip } from "./InfoTip";

/** Sleepers by beat buzz for some teams (src/lib/sleepers.ts): who the beat is talking about more than his role suggests. */
export async function SleepersPanel({ teams, players, vacated }: { teams: string[]; players: FeedPlayer[]; vacated?: Record<string, Vacated[]> }) {
  const list = await sleepersFor(teams, players, vacated).catch(() => []);
  return (
    <div className="relative mb-4 rounded border border-line bg-panel-2 px-3 py-2">
      <p className="text-sm font-semibold text-chalk">
        Sleepers by beat buzz
        <InfoTip label="Sleepers by beat buzz" what={TERMS.sleepers} />
      </p>
      {list.length === 0 ? (
        <p className="mt-1 text-xs text-chalk-3">Nobody with a part-time role or new work has 2 or more posts in the last 3 days.</p>
      ) : (
        <ul className="mt-1 grid gap-1.5">
          {list.map((s) => (
            <li key={s.id} className="text-sm leading-snug">
              <Link href={`/player/${s.id}`} className="font-semibold text-chalk hover:text-sky">{s.name}</Link>
              <span className="mono ml-1.5 text-xs text-chalk-3">{s.pos} · {s.team}</span>
              {s.promoted && <span className="ml-1.5 rounded bg-turf px-1.5 py-0.5 text-[10px] font-bold text-white">moving up</span>}
              <span className="block text-xs text-chalk-2">{s.reasons.join("; ")}.</span>
              <span className="block text-xs">
                {s.sources.map((src, i) => (
                  <a key={src.url} href={src.url} target="_blank" rel="noopener noreferrer" className="mr-2 text-sky hover:underline">
                    {src.label || `source ${i + 1}`}
                  </a>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
