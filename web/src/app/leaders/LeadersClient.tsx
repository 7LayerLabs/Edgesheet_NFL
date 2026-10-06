"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { LeaderBoard } from "@/lib/generated";

type Tab = "passing" | "rushing" | "receiving" | "teams";
type Col = { key: string; label: string; help: string; fmt?: (v: number) => string; lowerBetter?: boolean; side?: "off" | "def" };

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const f3 = (v: number) => (v > 0 ? "+" : "") + v.toFixed(2);
const pc = (v: number) => `${v.toFixed(1)}%`;
const sg = (v: number) => (v > 0 ? "+" : "") + v.toFixed(1);

const COLS: Record<Exclude<Tab, "teams">, Col[]> = {
  passing: [
    { key: "games", label: "G", help: "Games with a dropback" },
    { key: "db", label: "Dropbacks", help: "Pass attempts, sacks, and scrambles" },
    { key: "yds", label: "Yds", help: "Passing yards" },
    { key: "td", label: "TD", help: "Passing touchdowns" },
    { key: "int", label: "INT", help: "Interceptions", lowerBetter: true },
    { key: "epa", label: "EPA", help: "Total expected points added on his dropbacks", fmt: f1 },
    { key: "epaPer", label: "EPA/DB", help: "EPA per dropback, sacks and scrambles included. The broadest single read on a passing game", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of dropbacks with EPA above zero: how often the play left the offense better off", fmt: pc },
    { key: "cpoe", label: "CPOE", help: "Completion % over expected (nflfastR model): completing harder throws than the depth and spot would predict", fmt: sg },
    { key: "adot", label: "aDOT", help: "Average depth of target in yards", fmt: f1 },
    { key: "sackRate", label: "Sack%", help: "Sacks per dropback", fmt: pc, lowerBetter: true },
    { key: "pressured", label: "Pressured%", help: "Dropbacks under pressure (PFR charting, a week behind)", fmt: pc, lowerBetter: true },
    { key: "p2s", label: "Press→Sack%", help: "Pressures that became sacks (PFR): pocket movement and getting rid of the ball", fmt: pc, lowerBetter: true },
    { key: "expl", label: "Expl%", help: "Dropbacks gaining 20+ yards", fmt: pc },
    { key: "neg", label: "Neg%", help: "Dropbacks that lost yards, were sacks, interceptions, or lost fumbles", fmt: pc, lowerBetter: true },
  ],
  rushing: [
    { key: "games", label: "G", help: "Games with a carry" },
    { key: "att", label: "Rush", help: "Designed runs (scrambles count as the quarterback's dropbacks)" },
    { key: "yds", label: "Yds", help: "Rushing yards" },
    { key: "ypc", label: "Yd/Rsh", help: "Yards per carry", fmt: f1 },
    { key: "td", label: "TD", help: "Rushing touchdowns" },
    { key: "epa", label: "EPA", help: "Total expected points added on his carries", fmt: f1 },
    { key: "epaPer", label: "EPA/Rsh", help: "EPA per carry", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of carries with EPA above zero: how often the run kept the offense on schedule. Steadier than yards per carry, which one long run can inflate", fmt: pc },
    { key: "expl", label: "Expl%", help: "Carries of 10+ yards", fmt: pc },
    { key: "stuff", label: "Stuff%", help: "Carries for zero or fewer yards", fmt: pc, lowerBetter: true },
    { key: "syPct", label: "Short%", help: "Third or fourth and 2 or fewer: share converted (3+ tries)", fmt: pc },
    { key: "ybc", label: "YBC/Rsh", help: "Yards before contact a carry (PFR): mostly the blocking", fmt: f1 },
    { key: "ryoe", label: "RYOE/Rsh", help: "Rush yards over expected a carry (NFL Next Gen tracking): mostly the runner", fmt: sg },
  ],
  receiving: [
    { key: "games", label: "G", help: "Games with a target" },
    { key: "tgt", label: "Tgt", help: "Targets" },
    { key: "rec", label: "Rec", help: "Catches" },
    { key: "yds", label: "Yds", help: "Receiving yards" },
    { key: "td", label: "TD", help: "Receiving touchdowns" },
    { key: "epa", label: "EPA", help: "Total expected points added on his targets", fmt: f1 },
    { key: "epaPer", label: "EPA/Tgt", help: "EPA per target", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of targets with EPA above zero", fmt: pc },
    { key: "tgtShare", label: "Tgt share", help: "His share of the team's targets", fmt: pc },
    { key: "airShare", label: "Air share", help: "His share of the team's intended air yards: who the downfield passing is built around", fmt: pc },
    { key: "adot", label: "aDOT", help: "Average depth of his targets in yards", fmt: f1 },
    { key: "catchPct", label: "Catch%", help: "Catches per target", fmt: pc },
    { key: "yacoe", label: "YACOE", help: "Yards after catch over expected per catch (nflfastR model)", fmt: sg },
    { key: "ydsSnap", label: "Yds/Snap", help: "Receiving yards per offensive snap, games with snap counts only (120+ snaps). Routes run are not in free data, so this stands in for yards per route run", fmt: f2 },
    { key: "sep", label: "Sep", help: "Average separation at the catch point in yards (NFL Next Gen, qualified players)", fmt: f1 },
    { key: "rz", label: "RZ tgt", help: "Targets inside the opponent's 20" },
  ],
};

const TEAM_COLS: Col[] = [
  { key: "epaPer", label: "EPA/Play", help: "Expected points added per play. Defense: lower is better", fmt: f3 },
  { key: "succ", label: "Success%", help: "Plays with EPA above zero", fmt: pc },
  { key: "expl", label: "Expl%", help: "Runs of 10+ and pass plays of 20+", fmt: pc },
  { key: "neg", label: "Neg%", help: "Plays that lost yards, sacks, interceptions, lost fumbles", fmt: pc },
  { key: "dbEpa", label: "DB EPA", help: "EPA per dropback", fmt: f3 },
  { key: "rushEpa", label: "Rush EPA", help: "EPA per designed run", fmt: f3 },
  { key: "rushSucc", label: "Rush Succ%", help: "Success rate on designed runs", fmt: pc },
  { key: "earlyEpa", label: "Early EPA", help: "EPA per play on first and second down, before obvious passing downs", fmt: f3 },
  { key: "sackRate", label: "Sack%", help: "Sacks per dropback (offense allowed, defense made)", fmt: pc },
];

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
