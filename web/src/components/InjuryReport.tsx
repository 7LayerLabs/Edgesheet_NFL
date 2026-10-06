import Link from "next/link";
import type { GameInjuries, InjuryRow } from "@/lib/injuries";
import type { Team } from "@/lib/types";

const badge = (s: string) =>
  /^out|inactive|suspen|reserve|^ir$|pup/i.test(s) ? "bg-brick text-white" : /doubt/i.test(s) ? "bg-warn text-chalk" : "bg-ink-2 text-chalk-2";
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "");

/** Both teams' injury lists, starters first, with the latest news line and what the model charges for each absence. */
export function InjuryReport({ data, away, home }: { data: GameInjuries; away: Team; home: Team }) {
  return (
    <div>
      <div className="grid gap-2.5 md:grid-cols-2">
        {([[away, data.away], [home, data.home]] as const).map(([t, ti]) => (
          <div key={t.id} className="card p-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-4 w-1 rounded-sm" style={{ background: t.color }} />
              <span className="display text-2xl font-bold">{t.short}</span>
            </div>
            <ul className="mt-2 divide-y divide-line">
              {ti.rows.map((r) => (
                <Row key={r.id} r={r} />
              ))}
              {ti.rows.length === 0 && <li className="py-1.5 text-sm text-chalk-3">Nobody on the injury list.</li>}
            </ul>
            {ti.reserve.length > 0 && (
              <p className="mt-2 border-t border-line pt-2 text-xs text-chalk-3">
                <span className="font-semibold text-chalk-2">Also on reserve lists (backups): </span>
                {ti.reserve.map((x) => `${x.name} (${x.pos})`).join(", ")}.
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-chalk-3">
        Status and news: ESPN&apos;s injury feed{data.espnAt ? ` (checked ${new Date(data.espnAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET)` : ""}. Injury and practice: the league&apos;s official report{data.reportWeek ? `, week ${data.reportWeek}` : ""}. Starter: first on the depth chart or 60%+ of his side&apos;s snaps. Points: what the projection charges for the absence (see Who&apos;s playing).
        {data.notes.length ? ` ${data.notes.join(" ")}` : ""}
      </p>
    </div>
  );
}

function Row({ r }: { r: InjuryRow }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${badge(r.status)}`}>{r.status}</span>
        <Link href={`/player/${r.id}`} className="font-semibold text-chalk hover:text-sky">{r.name}</Link>
        <span className="mono text-xs text-chalk-3">
          {r.pos}
          {r.starter ? " · starter" : ""}
          {r.snap ? ` · ${r.snap}% of snaps` : ""}
        </span>
        {r.impact !== undefined && (
          <span className={`mono ml-auto text-sm font-semibold ${r.impact <= -1 ? "text-brick" : "text-chalk-2"}`} title={r.impactWhy}>
            {signed(r.impact)} pts
          </span>
        )}
      </div>
      {(r.injury || r.practice) && (
        <p className="mono mt-0.5 text-xs text-chalk-3">
          {[r.injury, r.practice].filter(Boolean).join(" · ")}
        </p>
      )}
      {r.note && (
        <p className="mt-0.5 text-sm leading-snug text-chalk-2">
          {r.note}
          {r.noteDate ? <span className="mono ml-1 text-xs text-chalk-3">({day(r.noteDate)})</span> : null}
        </p>
      )}
      {r.impactWhy && r.impact !== undefined && r.impactWhy !== "his absence in the projection" && <p className="mono mt-0.5 text-xs text-chalk-3">{r.impactWhy}: {signed(r.impact)} pts to the margin</p>}
    </li>
  );
}
