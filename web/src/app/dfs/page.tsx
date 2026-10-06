import Link from "next/link";
import { slateSim, type SlateLineup, type SlatePlayer, type SlateSim } from "@/lib/dfs-slate";
import { shiftDate } from "@/lib/slate";
import { InfoTip } from "@/components/InfoTip";
import { TERMS } from "@/lib/terms";

export const dynamic = "force-dynamic";

const POSITIONS = ["All", "QB", "RB", "WR", "TE", "DST"] as const;
const SORTS = { median: "Median", ceiling: "Ceiling", value: "Value", boom: "Boom" } as const;
type SortKey = keyof typeof SORTS;
const LINEUP_TITLE: Record<SlateLineup["kind"], [string, string]> = {
  cash: ["Cash", "best median total: the steadiest 50/50 and double-up lineup"],
  gpp: ["Tournament", "best 90th-percentile total: the ceiling a big field needs"],
  "gpp-bringback": ["Tournament, stacked", "a QB with a pass catcher and a player from the other side of his game"],
};
const SLOT = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"];
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default async function DfsPage({ searchParams }: PageProps<"/dfs">) {
  const sp = await searchParams;
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : undefined;
  const pos = (POSITIONS as readonly string[]).includes(String(sp.pos)) ? (String(sp.pos) as (typeof POSITIONS)[number]) : "All";
  const sort: SortKey = String(sp.sort) in SORTS ? (String(sp.sort) as SortKey) : "median";
  const sim = await slateSim(date);

  return (
    <div>
      <p className="eyebrow">DraftKings simulator</p>
      <h1 className="display mt-1 text-4xl font-extrabold text-chalk sm:text-6xl">The slate, 10,000 times</h1>
      <p className="mt-2 max-w-2xl text-sm text-chalk-2">
        Every player&apos;s range from real outcome shapes, with stacks and bring-backs moving together, and three lineups built from the simulated totals. A model, not a pick.
      </p>
      <DateLinks date={"date" in sim && sim.date ? sim.date : date} />

      {"note" in sim ? (
        <div className="card mt-6 p-6">
          <p className="display text-2xl text-chalk">No simulation for this date</p>
          <p className="mt-1 text-sm text-chalk-3">{sim.note}</p>
        </div>
      ) : (
        <Slate sim={sim} pos={pos} sort={sort} />
      )}
    </div>
  );
}

function DateLinks({ date }: { date?: string }) {
  if (!date) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      <Link href={`/dfs?date=${shiftDate(date, -7)}`} className="chip">Week before</Link>
      <span className="mono text-xs text-chalk-3">{new Date(`${date}T12:00:00-04:00`).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" })}</span>
      <Link href={`/dfs?date=${shiftDate(date, 7)}`} className="chip">Week after</Link>
    </div>
  );
}

function Slate({ sim, pos, sort }: { sim: SlateSim; pos: (typeof POSITIONS)[number]; sort: SortKey }) {
  const value = (p: SlatePlayer) => p.median / (p.play.salary / 1000);
  const by: Record<SortKey, (p: SlatePlayer) => number> = { median: (p) => p.median, ceiling: (p) => p.ceiling, value, boom: (p) => p.boom };
  const rows = sim.players.filter((p) => pos === "All" || p.play.pos === pos).sort((a, b) => by[sort](b) - by[sort](a)).slice(0, 80);
  const lineups = sim.lineups.filter((l, i) => !sim.lineups.slice(0, i).some((m) => m.keys.join() === l.keys.join()));
  const qs = (next: Partial<{ pos: string; sort: string }>) => {
    const p = new URLSearchParams({ date: sim.date, pos, sort, ...next });
    if (p.get("pos") === "All") p.delete("pos");
    if (p.get("sort") === "median") p.delete("sort");
    return `/dfs?${p.toString()}`;
  };
  const uncertain = sim.players.filter((p) => p.pPlay < 1 && p.play.pos !== "DST");

  return (
    <>
      <p className="mono mt-3 text-xs text-chalk-3">
        {sim.source} · {sim.players.length} players · {sim.n.toLocaleString("en-US")} simulations{sim.jevCalls ? ` · Jev read the news on ${sim.jevCalls}` : ""}
      </p>

      <section className="mt-6">
        <h2 className="display text-3xl font-bold text-chalk">Lineups</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {lineups.map((l) => (
            <LineupCard key={l.kind} l={l} />
          ))}
        </div>
        {lineups.length === 0 && <p className="mt-2 text-sm text-chalk-3">Not enough salaried players across two games to build a legal lineup.</p>}
      </section>

      {uncertain.length > 0 && (
        <section className="mt-8">
          <h2 className="display text-3xl font-bold text-chalk">Might not play</h2>
          <p className="mt-1 max-w-3xl text-sm text-chalk-3">
            Each sits in the share of simulations shown, and his backups take half his projection in those draws. With fresh news, Jev reads it into the play chance and the role; a Jev answer near 50/50 keeps the injury-status number.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {uncertain.map((p) => (
              <li key={p.key} className="card p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-chalk">{p.play.name} <span className="mono text-xs font-normal text-chalk-3">{p.play.pos} · {p.play.teamAbbr}</span></span>
                  <span className="mono text-xs text-chalk-2">plays {pct(p.pPlay)} <span className="text-chalk-3">({p.pPlaySource === "jev" ? "Jev" : "status"})</span></span>
                </div>
                <p className="mt-1 text-xs text-chalk-3">
                  {p.play.status}
                  {p.jev ? ` · Jev, ${p.jev.posts} news item${p.jev.posts === 1 ? "" : "s"}: role ${p.jev.role}${p.jev.jevPlay !== undefined ? `, ${pct(p.jev.jevPlay)} to play` : ""}` : ""}
                  {p.backups?.length ? ` · if he sits: ${p.backups.join(", ")}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="display relative text-3xl font-bold text-chalk">
          Players
          <InfoTip label="What the columns mean" what={TERMS.dfs} />
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {POSITIONS.map((p) => (
            <Link key={p} href={qs({ pos: p })} className="chip" aria-current={p === pos ? "true" : undefined} aria-pressed={p === pos}>{p}</Link>
          ))}
          <span className="ml-2 text-xs text-chalk-3">Sort</span>
          {(Object.keys(SORTS) as SortKey[]).map((k) => (
            <Link key={k} href={qs({ sort: k })} className="chip" aria-pressed={k === sort}>{SORTS[k]}</Link>
          ))}
        </div>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-chalk-3">
                <th className="px-3 py-2 font-semibold">Player</th>
                <th className="px-2 py-2 text-right font-semibold">Salary</th>
                <th className="px-2 py-2 text-right font-semibold" title="Our projection, after any Jev role change">Proj</th>
                <th className="px-2 py-2 text-right font-semibold" title="10th percentile of the simulations">Floor</th>
                <th className="px-2 py-2 text-right font-semibold">Median</th>
                <th className="px-2 py-2 text-right font-semibold" title="90th percentile of the simulations">Ceiling</th>
                <th className="px-2 py-2 text-right font-semibold" title="Share of simulations at 5x salary per $1,000 or more">Boom</th>
                <th className="px-2 py-2 text-right font-semibold" title="Share of simulations under 2x salary per $1,000">Bust</th>
                <th className="px-2 py-2 text-right font-semibold" title="Median points per $1,000 of salary">Value</th>
                <th className="px-3 py-2 text-right font-semibold">Plays</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <span className="mono mr-2 inline-block w-8 text-xs text-chalk-3">{p.play.pos}</span>
                    {p.play.id ? <Link href={`/player/${p.play.id}`} className="font-semibold text-chalk hover:text-sky">{p.play.name}</Link> : <span className="font-semibold text-chalk">{p.play.name}</span>}
                    <span className="mono ml-2 text-xs text-chalk-3">{p.play.teamAbbr} v {p.play.oppAbbr}</span>
                  </td>
                  <td className="mono px-2 py-2 text-right text-chalk-2">{money(p.play.salary)}</td>
                  <td className="mono px-2 py-2 text-right text-chalk-2">{p.proj}</td>
                  <td className="mono px-2 py-2 text-right text-chalk-3">{p.floor}</td>
                  <td className="mono px-2 py-2 text-right font-semibold text-chalk">{p.median}</td>
                  <td className="mono px-2 py-2 text-right text-chalk">{p.ceiling}</td>
                  <td className="mono px-2 py-2 text-right text-chalk-2">{pct(p.boom)}</td>
                  <td className="mono px-2 py-2 text-right text-chalk-3">{pct(p.bust)}</td>
                  <td className="mono px-2 py-2 text-right text-chalk-2">{(p.median / (p.play.salary / 1000)).toFixed(1)}x</td>
                  <td className={`mono px-3 py-2 text-right ${p.pPlay < 1 ? "text-warn" : "text-chalk-3"}`}>{p.pPlay < 1 ? pct(p.pPlay) : "yes"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 max-w-3xl text-xs leading-relaxed text-chalk-3">
        <h2 className="display text-xl font-bold text-chalk">How it works</h2>
        <p className="mt-1">
          Each simulation draws a scoring shock for every game (both teams share it), an offense shock and a pass-or-run tilt for every team, and a link between each quarterback and each of his pass catchers. A player&apos;s draw becomes points through his outcome shape: what players at his position and projection actually scored against projections like his, 2022 to 2025 (14,855 player-weeks and 1,918 defense-weeks). Defenses come from sacks, takeaways, and the opponent&apos;s implied team total. Lineups are scored on the summed simulations, so a stack&apos;s shared upside is counted, not assumed.
        </p>
        <p className="mt-1">
          Checks: holding out each season, the 10th, 50th, and 90th percentiles land within a point of nominal on average for every position. In a single season the league&apos;s scoring level moves every range together by up to {Math.max(...Object.values(sim.calibration.worstSeasonOff), 0).toFixed(1)} points (2022 scored low, 2024 high). Ownership is not modeled, and contest results are not backtested: there is no free history of DraftKings salaries and payouts. Projection is the DraftKings lens; Median is lower for top-tier players because their past projections ran high.
        </p>
      </section>
    </>
  );
}

function LineupCard({ l }: { l: SlateLineup }) {
  const [title, sub] = LINEUP_TITLE[l.kind];
  return (
    <div className="card p-4">
      <p className="display text-2xl font-bold text-chalk">{title}</p>
      <p className="text-xs text-chalk-3">{sub}</p>
      <ul className="mt-3 grid gap-1 text-sm">
        {l.players.map((p, i) => (
          <li key={p.key} className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
            <span className="mono text-xs text-chalk-3">{SLOT[i]}</span>
            <span className="truncate text-chalk">{p.play.name} <span className="mono text-xs text-chalk-3">{p.play.teamAbbr}</span></span>
            <span className="mono text-xs text-chalk-2">{money(p.play.salary)}</span>
          </li>
        ))}
      </ul>
      <div className="mono mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2 text-xs">
        <span><span className="text-chalk-3">salary</span><br />{money(l.salary)}</span>
        <span><span className="text-chalk-3">median</span><br /><span className="font-semibold text-chalk">{l.median}</span></span>
        <span><span className="text-chalk-3">90th pct</span><br /><span className="font-semibold text-chalk">{l.p90}</span></span>
      </div>
    </div>
  );
}
