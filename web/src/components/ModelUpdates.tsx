import Link from "next/link";
import { changelogLine, readChangelog, recentUpdate, shortDate } from "@/lib/changelog";

/**
 * "Model updates" on the Record page: every tuner entry, newest first, in one
 * line each: "Oct 6: edge threshold 20 to 25 (played-out rate 61% vs 54%, n=73)".
 * Applied changes are marked; the rest are proposals waiting on Derek.
 */
export function ModelUpdates() {
  const entries = readChangelog();
  return (
    <section className="mt-8" id="model-updates">
      <div className="flex items-baseline gap-3">
        <h2 className="display text-3xl font-bold text-chalk">Model updates</h2>
        <span className="mono text-xs text-chalk-3">npm run tune, Mondays 6 AM</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <p className="mt-1 max-w-3xl text-sm text-chalk-3">
        The tuner replays the graded archive against the current formulas every week. It changes a parameter only when at least 50 graded games
        say so and the gain survives a bootstrap. Anything else is a proposal.
      </p>
      {entries.length === 0 ? (
        <p className="card mt-3 px-4 py-3 text-sm text-chalk-3">No updates yet. The tuner needs 50 graded games before it changes anything.</p>
      ) : (
        <ul className="mt-3 grid gap-1.5">
          {entries.map((e, i) => (
            <li key={`${e.date}-${e.metric}-${i}`} className="card flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${e.applied ? "bg-turf text-white" : "bg-ink-2 text-chalk-2"}`}>{e.applied ? "applied" : "proposal"}</span>
              <span className="text-chalk">{changelogLine(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Tiny header note for the slate when a changelog entry landed in the last seven days. */
export function ModelUpdatedNote() {
  const e = recentUpdate(7);
  if (!e) return null;
  return (
    <Link href="/history#model-updates" className="mono text-[11px] text-chalk-3 hover:text-chalk" title={changelogLine(e)}>
      model {e.applied ? "updated" : "proposal"} {shortDate(e.date)}
    </Link>
  );
}
