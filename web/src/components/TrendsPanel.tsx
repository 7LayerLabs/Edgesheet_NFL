"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { TeamTrends, TrendCell, TrendNote, TrendRoom } from "@/lib/trends";

type Metric = "snaps" | "targets" | "carries" | "air" | "dk";
const METRICS: { key: Metric; label: string }[] = [
  { key: "snaps", label: "Snaps" },
  { key: "targets", label: "Targets" },
  { key: "carries", label: "Carries" },
  { key: "air", label: "Air yards" },
  { key: "dk", label: "DK points" },
];
const ROOM_LABEL: Record<TrendRoom["key"], string> = { QB: "Quarterbacks", RB: "Backfield", "WR/TE": "Receivers and tight ends" };
const pct = (x: number | undefined) => (x === undefined ? "" : `${Math.round(x * 100)}%`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface TrendsTeam {
  name: string; // nickname
  abbr: string;
  color: string;
  /** Column headings, one per week: "W1 @PIT". */
  heads: string[];
  trends: TeamTrends;
}

/**
 * Usage by week for both teams: snap share, targets, carries, air yards share, DK points, any mix of them, with the reason
 * each big change happened listed under each room. One team at a time on a phone; the newest two weeks of notes show
 * first.
 */
export function TrendsPanel({ teams }: { teams: TrendsTeam[] }) {
  const [team, setTeam] = useState(0);
  const [on, setOn] = useState<Set<Metric>>(new Set(["snaps", "targets", "carries"]));
  const [allNotes, setAllNotes] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // On a phone the tables scroll sideways; start each at the newest week (the name column stays put).
  useEffect(() => {
    box.current?.querySelectorAll<HTMLElement>(".scroll-x").forEach((el) => {
      el.scrollLeft = el.scrollWidth;
    });
  }, [team, on]);
  const t = teams[team];
  if (!t) return null;
  const toggle = (m: Metric) =>
    setOn((cur) => {
      const next = new Set(cur);
      if (next.has(m)) {
        if (next.size > 1) next.delete(m);
      } else next.add(m);
      return next;
    });
  const weeks = t.trends.weeks;
  const recent = new Set(weeks.slice(-2).map((w) => w.wk));
  const unposted = weeks.filter((w) => !w.snapsPosted).map((w) => w.wk);

  return (
    <div ref={box} className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg" role="group" aria-label="Team">
          {teams.map((x, i) => (
            <button key={x.name} type="button" aria-pressed={i === team} onClick={() => setTeam(i)}>
              {x.abbr}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="What to show">
          {METRICS.map((m) => (
            <button key={m.key} type="button" className="chip" aria-pressed={on.has(m.key)} onClick={() => toggle(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {unposted.length > 0 && on.has("snaps") && (
        <p className="mt-2 text-xs text-chalk-3">
          Snap counts for week {unposted.join(" and ")} are not posted yet (nflverse posts them a day or two after the game).
        </p>
      )}

      {t.trends.calls.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-semibold text-chalk">Play calling</p>
          <div className="card scroll-x mt-1 px-3 py-1">
            <table className="mono min-w-max border-collapse text-xs">
              <thead>
                <tr className="text-left text-chalk-3">
                  <th className="sticky left-0 bg-panel py-1 pr-3 font-normal">&nbsp;</th>
                  {t.trends.calls.map((c) => (
                    <th key={c.wk} className="px-2 py-1 font-normal">
                      {t.heads[weeks.findIndex((w) => w.wk === c.wk)] ?? `W${c.wk}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-line">
                  <td className="sticky left-0 bg-panel py-1.5 pr-3 font-sans text-chalk-2">Pass rate</td>
                  {t.trends.calls.map((c) => (
                    <td key={c.wk} className="px-2 py-1.5 text-chalk">{Math.round(c.pass)}%</td>
                  ))}
                </tr>
                <tr className="border-t border-line">
                  <td className="sticky left-0 bg-panel py-1.5 pr-3 font-sans text-chalk-2">Against expected</td>
                  {t.trends.calls.map((c) => (
                    <td key={c.wk} className={`px-2 py-1.5 ${c.proe === null ? "text-chalk-3" : c.proe >= 5 ? "text-sky" : c.proe <= -5 ? "text-turf" : "text-chalk"}`}>
                      {c.proe === null ? "–" : `${c.proe > 0 ? "+" : ""}${Math.round(c.proe)} ${c.proe >= 5 ? "pass-heavy" : c.proe <= -5 ? "run-heavy" : "balanced"}`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-chalk-3">Against expected: how far the pass rate ran above or below what the down, distance, field position, and score usually call for (nflverse model).</p>
        </div>
      )}

      {t.trends.rooms
        .filter((r) => r.rows.length)
        .map((room) => {
          // Explained changes as notes; unexplained ones only in one muted line (the cell still marks them).
          const mine = t.trends.notes.filter((n) => n.room === room.key);
          const notes = mine.filter((n) => n.cause !== "none" && (allNotes || recent.has(n.wk)));
          const unexplained = mine.filter((n) => n.cause === "none" && (allNotes || recent.has(n.wk)));
          const hidden = mine.filter((n) => !recent.has(n.wk)).length;
          return (
            <div key={room.key} className="mt-5">
              <p className="text-sm font-semibold text-chalk">{ROOM_LABEL[room.key]}</p>
              <div className="card scroll-x mt-1 px-3 py-1">
                <table className="min-w-max border-collapse text-xs">
                  <thead>
                    <tr className="mono text-left text-chalk-3">
                      <th className="sticky left-0 z-10 bg-panel py-1 pr-3 font-normal">&nbsp;</th>
                      {t.heads.map((h) => (
                        <th key={h} className="px-2 py-1 font-normal">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {room.rows.map((row) => (
                      <tr key={row.id} className="border-t border-line align-top">
                        <td className="sticky left-0 z-10 max-w-[9.5rem] bg-panel py-1.5 pr-3">
                          <Link href={`/player/${row.id}`} className="block truncate font-semibold text-chalk hover:text-sky">{row.name}</Link>
                          <span className="mono text-[11px] text-chalk-3">{row.pos}{row.rookie ? " · rookie" : ""}</span>
                        </td>
                        {row.cells.map((c, i) => (
                          <Cell key={weeks[i].g} c={c} on={on} qb={room.key === "QB"} has={has(row.cells)} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {notes.length > 0 && (
                <ul className="mt-2 grid gap-1">
                  {notes.map((n) => (
                    <Note key={`${n.wk}-${n.id}`} n={n} />
                  ))}
                </ul>
              )}
              {unexplained.length > 0 && (
                <p className="mt-1 text-xs text-chalk-3">
                  Also moved, no clear cause in the data: {unexplained.map((n) => `${n.name} (W${n.wk} ${n.metric === "snaps" ? "snaps" : n.metric === "targets" ? "target share" : "carry share"} ${pct(n.from)} to ${pct(n.to)})`).join("; ")}.
                </p>
              )}
              {hidden > 0 && !allNotes && (
                <button type="button" onClick={() => setAllNotes(true)} className="mt-1 text-xs font-semibold text-sky hover:underline">
                  Show {hidden} earlier {hidden === 1 ? "change" : "changes"}
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** Which lines a row needs: a receiver with no carries all season skips the carries line (the same in every week, so
 *  the lines stay level across the row). */
function has(cells: TrendCell[]): { tgt: boolean; ra: boolean } {
  const played = cells.filter((c) => c.status === "played");
  return { tgt: played.some((c) => (c.tgt ?? 0) > 0), ra: played.some((c) => (c.ra ?? 0) > 0) };
}

function Cell({ c, on, qb, has }: { c: TrendCell; on: Set<Metric>; qb: boolean; has: { tgt: boolean; ra: boolean } }) {
  if (c.status === "none") return <td className="px-2 py-1.5 text-chalk-3" title="No game with the team yet">·</td>;
  if (c.status === "out")
    return (
      <td className="px-2 py-1.5 text-chalk-3" title="No offensive snap and no stat line: out, inactive, or special teams only">
        {c.moved ? `left (${c.moved})` : "did not play"}
        {c.listed && !c.moved && <span className="block text-[11px]">listed {c.listed.toLowerCase()}</span>}
      </td>
    );
  const ch = c.change;
  const tint = ch ? (ch.to > ch.from ? "bg-turf/10" : "bg-brick/10") : "";
  const arrow = (m: "snaps" | "targets" | "carries") => (ch?.metric === m ? <span className={ch.to > ch.from ? "text-turf" : "text-brick"}>{ch.to > ch.from ? " ▲" : " ▼"}</span> : null);
  return (
    <td className={`mono px-2 py-1.5 leading-tight text-chalk ${tint}`} title={ch ? sentence(ch.reason) : undefined}>
      {on.has("snaps") && (
        <span className="block">
          {c.snaps === undefined ? <span className="text-chalk-3" title="Snap counts not posted">n/a</span> : pct(c.snaps)}
          {arrow("snaps")}
        </span>
      )}
      {on.has("targets") && qb && <span className="block">{c.pa ?? 0} att</span>}
      {on.has("targets") && !qb && has.tgt && (
        <span className="block">
          {c.tgt ?? 0} tgt{c.tshare ? <span className="text-chalk-3"> {pct(c.tshare)}</span> : null}
          {arrow("targets")}
        </span>
      )}
      {on.has("carries") && has.ra && (
        <span className="block">
          {c.ra ?? 0} car{c.rshare ? <span className="text-chalk-3"> {pct(c.rshare)}</span> : null}
          {arrow("carries")}
        </span>
      )}
      {on.has("air") && !qb && <span className="block">{c.air ? `air ${pct(c.air)}` : <span className="text-chalk-3">air 0%</span>}</span>}
      {on.has("dk") && <span className="block">{(c.dk ?? 0).toFixed(1)} DK</span>}
    </td>
  );
}

function Note({ n }: { n: TrendNote }) {
  const what = n.metric === "snaps" ? "snaps" : n.metric === "targets" ? "target share" : "carry share";
  const up = n.to > n.from;
  return (
    <li className="text-sm leading-snug text-chalk-2">
      <span className="mono mr-1.5 text-xs text-chalk-3">W{n.wk}</span>
      <span className="font-semibold text-chalk">{n.name}</span>{" "}
      <span className={up ? "text-turf" : "text-brick"}>
        {what} {pct(n.from)} to {pct(n.to)}
      </span>
      . {sentence(n.reason)}.
    </li>
  );
}
