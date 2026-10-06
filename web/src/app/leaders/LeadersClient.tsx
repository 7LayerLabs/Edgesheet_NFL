"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { LeaderBoard } from "@/lib/generated";

import { COLS, TEAM_COLS, pc, sg, type Col, type Tab } from "@/lib/leader-cols";

export function LeadersClient({ board, seasons, season }: { board: LeaderBoard; seasons: number[]; season: number }) {
  const [tab, setTab] = useState<Tab>("rushing");
  const [sort, setSort] = useState<string>("succ");
  const [team, setTeam] = useState<string>("all");
  const [qualifiedOnly, setQualifiedOnly] = useState(true);
  const [side, setSide] = useState<"off" | "def">("off");

  const teamsList = useMemo(() => [...new Set(board.teams.map((t) => t.team))].sort(), [board]);
  const cols: Col[] = tab === "teams" ? [...TEAM_COLS, ...(side === "off" ? [{ key: "proe", label: "PROE", help: "Pass rate over expected (nflfastR): passing more (+) or less (-) than the situations call for. A tendency, not a grade", fmt: sg }] : [{ key: "hitRate", label: "Hit+Sack%", help: "QB hits plus sacks per dropback: pass rush that gets home", fmt: pc }])] : COLS[tab];
  const colOf = cols.find((c) => c.key === sort) ?? cols.find((c) => c.key === "epaPer")!;
  const defenseLower = tab === "teams" && side === "def" && colOf.key !== "sackRate" && colOf.key !== "hitRate" && colOf.key !== "neg";
  const lowerFirst = colOf.lowerBetter || defenseLower;

  const rows = useMemo(() => {
    if (tab === "teams") {
      const list = board.teams.filter((t) => team === "all" || t.team === team).map((t) => ({ id: t.code, name: t.team, team: t.team, games: t.games, ...t[side] }) as Record<string, unknown>);
      return list.sort((a, b) => cmp(a, b, colOf.key, lowerFirst));
    }
    const list = (board[tab] as unknown as Record<string, unknown>[]).filter((r) => (team === "all" || r.team === team) && (!qualifiedOnly || r.qualified));
    return [...list].sort((a, b) => cmp(a, b, colOf.key, lowerFirst));
  }, [board, tab, team, qualifiedOnly, colOf.key, lowerFirst, side]);

  const pickTab = (t: Tab) => {
    setTab(t);
    setSort(t === "passing" ? "epaPer" : t === "teams" ? "epaPer" : "succ");
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg">
          {(["passing", "rushing", "receiving", "teams"] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={() => pickTab(t)} className={tab === t ? "on" : ""} aria-pressed={tab === t}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {tab === "teams" && (
          <div className="seg">
            {(["off", "def"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)} className={side === s ? "on" : ""} aria-pressed={side === s}>
                {s === "off" ? "Offense" : "Defense"}
              </button>
            ))}
          </div>
        )}
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded border border-line bg-white px-2 py-1 text-sm" aria-label="Team">
          <option value="all">All teams</option>
          {teamsList.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {tab !== "teams" && (
          <label className="flex items-center gap-1.5 text-sm text-chalk-2">
            <input type="checkbox" checked={qualifiedOnly} onChange={(e) => setQualifiedOnly(e.target.checked)} />
            Qualified only
          </label>
        )}
        <span className="ml-auto flex gap-1 text-sm">
          {seasons.map((y) => (
            <Link key={y} href={`/leaders?season=${y}`} className={`rounded px-2 py-1 ${y === season ? "bg-navy text-white" : "border border-line text-chalk-2 hover:text-chalk"}`}>
              {y}
            </Link>
          ))}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto rounded border border-line bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line bg-panel-2 text-left text-xs text-chalk-3">
              <th className="px-2 py-2 font-semibold">#</th>
              <th className="px-2 py-2 font-semibold">{tab === "teams" ? "Team" : "Player"}</th>
              {cols.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-2 py-2 text-right font-semibold ${c.key === colOf.key ? "bg-sky/10 text-chalk" : ""}`} title={c.help}>
                  <button type="button" onClick={() => setSort(c.key)} className="hover:text-chalk">
                    {c.label}
                    {c.key === colOf.key ? (lowerFirst ? " ▲" : " ▼") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={String(r.id)} className="border-b border-line last:border-0 hover:bg-panel-2">
                <td className="mono px-2 py-1.5 text-chalk-3">{i + 1}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {tab === "teams" ? (
                    <span className="font-semibold text-chalk">{String(r.name)}</span>
                  ) : (
                    <>
                      <Link href={`/player/${String(r.id)}`} className="font-semibold text-chalk hover:text-sky">{String(r.name)}</Link>
                      <span className="mono ml-1.5 text-xs text-chalk-3">{String(r.pos ?? "")} · {String(r.team)}</span>
                      {!r.qualified && <span className="mono ml-1 text-[10px] text-chalk-3">(not qualified)</span>}
                    </>
                  )}
                </td>
                {cols.map((c) => {
                  const v = r[c.key];
                  return (
                    <td key={c.key} className={`mono whitespace-nowrap px-2 py-1.5 text-right ${c.key === colOf.key ? "bg-sky/10 font-semibold text-navy" : "text-chalk-2"}`}>
                      {typeof v === "number" ? (c.fmt ? c.fmt(v) : String(v)) : "–"}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 2} className="px-3 py-4 text-sm text-chalk-3">Nobody matches. Turn off Qualified only or pick another team.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 grid max-w-4xl gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {cols.map((c) => (
          <div key={c.key}>
            <dt className="inline font-semibold text-chalk">{c.label}: </dt>
            <dd className="inline text-chalk-3">{c.help}.</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function cmp(a: Record<string, unknown>, b: Record<string, unknown>, key: string, lowerFirst: boolean): number {
  const x = typeof a[key] === "number" ? (a[key] as number) : undefined;
  const y = typeof b[key] === "number" ? (b[key] as number) : undefined;
  if (x === undefined && y === undefined) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return lowerFirst ? x - y : y - x;
}
