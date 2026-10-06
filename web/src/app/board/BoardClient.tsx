"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export interface BoardRow {
  id: string;
  name: string;
  team: string;
  pos: string;
  group: string;
  cls: string;
  draftClass: number | null;
  games: number;
  avgGrade: number;
  myScore: number;
  radar: number | null;
  tier: string | null;
  band: string | null;
  estPick: number | null;
  delta: number | null;
  lastDate: string;
  notes: { date: string; gameId: string; grade: number; note: string }[];
}

type SortKey = "mine" | "blend" | "radar" | "delta";
const BLEND_KEY = "board:blend";

function blended(r: BoardRow, w: number): number {
  if (r.radar === null) return r.myScore;
  return Math.round(w * r.myScore + (1 - w) * r.radar);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function BoardClient({ rows }: { rows: BoardRow[] }) {
  const [pos, setPos] = useState<string>("all");
  const [cls, setCls] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("mine");
  const [blend, setBlend] = useState(50);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(BLEND_KEY));
      // The saved blend is read after mount on purpose: localStorage does not exist on the server, and reading it
      // during render would make the server and browser markup disagree. One extra render on load is the cost.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Number.isFinite(v) && v >= 0 && v <= 100 && localStorage.getItem(BLEND_KEY) !== null) setBlend(v);
    } catch {}
  }, []);
  function setBlendPersist(v: number) {
    setBlend(v);
    try {
      localStorage.setItem(BLEND_KEY, String(v));
    } catch {}
  }

  const groups = useMemo(() => [...new Set(rows.map((r) => r.group).filter(Boolean))].sort(), [rows]);
  const classes = useMemo(() => [...new Set(rows.map((r) => r.draftClass).filter((c): c is number => c !== null))].sort(), [rows]);
  const w = blend / 100;

  const shown = useMemo(() => {
    const list = rows.filter((r) => (pos === "all" || r.group === pos) && (cls === "all" || String(r.draftClass) === cls));
    const key = (r: BoardRow) => (sort === "mine" ? r.myScore : sort === "blend" ? blended(r, w) : sort === "radar" ? (r.radar ?? -1) : Math.abs(r.delta ?? -1));
    return list.sort((a, b) => key(b) - key(a) || b.games - a.games || a.name.localeCompare(b.name));
  }, [rows, pos, cls, sort, w]);

  function exportCsv() {
    const header = ["player", "id", "team", "pos", "class", "draft class", "games graded", "my grade (avg of 5)", "my score", "my notes", "radar", "forecast", "est pick", "delta", "blend score", "blend weight"];
    const lines = [header.join(",")];
    for (const r of shown) {
      const notes = r.notes.map((n) => `${n.date} ${n.grade}/5${n.note ? ` ${n.note}` : ""}`).join(" | ");
      lines.push([r.name, r.id, r.team, r.pos, r.cls, r.draftClass ?? "", r.games, r.avgGrade, r.myScore, notes, r.radar ?? "", r.band ?? "", r.estPick ?? "", r.delta ?? "", blended(r, w), blend].map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `my-board-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const deltaTone = (d: number | null) => (d === null ? "text-chalk-3" : d >= 15 ? "text-turf" : d <= -15 ? "text-brick" : "text-chalk-2");
  const deltaText = (d: number | null) => (d === null ? "no radar score" : d === 0 ? "even with the model" : `you have him ${Math.abs(d)} points ${d > 0 ? "above" : "below"} the model`);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="scroll-x flex items-center gap-1.5">
          <button type="button" className="chip" aria-pressed={pos === "all"} onClick={() => setPos("all")}>All pos</button>
          {groups.map((g) => (
            <button key={g} type="button" className="chip" aria-pressed={pos === g} onClick={() => setPos(g)}>{g}</button>
          ))}
        </div>
        {classes.length > 1 && (
          <div className="flex items-center gap-1.5">
            <button type="button" className="chip" aria-pressed={cls === "all"} onClick={() => setCls("all")}>All classes</button>
            {classes.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={cls === String(c)} onClick={() => setCls(String(c))}>{c}</button>
            ))}
          </div>
        )}
        <div className="seg ml-auto text-xs">
          {(["mine", "blend", "radar", "delta"] as SortKey[]).map((k) => (
            <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>
              {k === "mine" ? "My score" : k === "blend" ? "Blend" : k === "radar" ? "Radar" : "Biggest gap"}
            </button>
          ))}
        </div>
      </div>

      <div className="card mt-3 flex flex-wrap items-center gap-3 px-4 py-3">
        <label htmlFor="blend" className="eyebrow">Blend</label>
        <span className="mono text-xs text-chalk-3">radar</span>
        <input id="blend" type="range" min={0} max={100} step={5} value={blend} onChange={(e) => setBlendPersist(Number(e.target.value))} className="w-40 accent-[#0d1f3c] sm:w-64" />
        <span className="mono text-xs text-chalk-3">mine</span>
        <span className="mono text-sm text-chalk">{blend}% mine, {100 - blend}% radar</span>
        <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded border border-line-2 bg-white px-3 py-1.5 text-xs font-semibold text-chalk hover:border-chalk-2">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
          Export CSV ({shown.length})
        </button>
      </div>

      <div className="card mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="mono text-[10px] uppercase tracking-wider text-chalk-3">
              <th className="px-3 py-2 font-semibold">#</th>
              <th className="px-3 py-2 font-semibold">Player</th>
              <th className="px-3 py-2 text-right font-semibold">Mine</th>
              <th className="px-3 py-2 text-right font-semibold">Radar</th>
              <th className="px-3 py-2 text-right font-semibold">Blend</th>
              <th className="px-3 py-2 font-semibold">Delta</th>
              <th className="px-3 py-2 font-semibold">Forecast</th>
              <th className="px-3 py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const isOpen = open.has(r.id);
              const firstNote = r.notes.find((n) => n.note)?.note ?? "";
              return (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="mono px-3 py-2 text-chalk-3">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/player/${r.id}`} className="display text-lg font-bold leading-none text-chalk hover:text-sky">{r.name}</Link>
                    <p className="mono mt-0.5 text-xs text-chalk-3">
                      {r.pos}{r.team ? ` · ${r.team}` : ""}{r.cls ? ` · ${r.cls}` : ""}{r.draftClass ? ` · ${r.draftClass} class` : ""}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="display text-2xl font-extrabold text-chalk">{r.myScore}</span>
                    <p className="mono text-[10px] text-chalk-3">{r.avgGrade} of 5 · {r.games} g</p>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.radar === null ? <span className="text-xs text-chalk-3">not on radar</span> : <span className="display text-2xl font-bold text-chalk-2">{r.radar}</span>}
                    {r.tier && <p className="mono text-[10px] text-chalk-3">{r.tier}</p>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="display text-2xl font-bold text-navy">{blended(r, w)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`mono text-base font-semibold ${deltaTone(r.delta)}`}>{r.delta === null ? "–" : `${r.delta > 0 ? "+" : ""}${r.delta}`}</span>
                    <p className={`max-w-[11rem] text-xs leading-snug ${deltaTone(r.delta)}`}>{deltaText(r.delta)}</p>
                  </td>
                  <td className="px-3 py-2">
                    {r.band ? (
                      <>
                        <span className="text-chalk">{r.band}</span>
                        {r.estPick !== null && <p className="mono text-[10px] text-chalk-3">est. pick {r.estPick}</p>}
                      </>
                    ) : (
                      <span className="text-xs text-chalk-3">not on the forecast board</span>
                    )}
                  </td>
                  <td className="max-w-[18rem] px-3 py-2">
                    {r.notes.some((n) => n.note) || r.notes.length > 1 ? (
                      <div>
                        {isOpen ? (
                          <ul className="grid gap-1 text-xs text-chalk-2">
                            {r.notes.map((n) => (
                              <li key={n.gameId || n.date}>
                                <span className="mono text-chalk-3">{n.date} · {n.grade}/5</span>
                                {n.note ? ` ${n.note}` : <span className="text-chalk-3"> (no note)</span>}
                                {n.gameId && <Link href={`/game/${n.gameId}`} className="ml-1 text-sky">game</Link>}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="truncate text-xs text-chalk-2" title={firstNote}>{firstNote || <span className="text-chalk-3">no note</span>}</p>
                        )}
                        <button type="button" onClick={() => toggle(r.id)} className="mono mt-0.5 text-[10px] text-sky hover:underline">
                          {isOpen ? "collapse" : `expand (${r.notes.length})`}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-chalk-3">no note</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-chalk-3">
        Blend score = {blend}% your score + {100 - blend}% radar. Players without a radar score use your score alone. The slider is remembered on this device.
      </p>
    </div>
  );
}
