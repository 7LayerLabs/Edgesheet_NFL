import { genExtras, genPlayers, type GenExtraPlayer } from "@/lib/generated";

const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;

type Row = { label: string; now?: string; last?: string; note?: string };

/**
 * Charting and tracking for one player from the extras feed (scripts/ingest-extras.mjs): PFR advanced stats, NFL Next
 * Gen Stats, expected fantasy points, and the combine. This season next to last season, by position. Server component;
 * renders nothing when the player has none of it.
 */
export function AdvancedPanel({ id }: { id: string }) {
  const ex = genExtras();
  const e = ex?.players[id];
  const pl = genPlayers().find((p) => p.id === id);
  if (!ex || !e || !pl) return null;
  const y = ex.season;
  const rows = rowsFor(e, pl.pg ?? "", y, pl);
  const c = e.combine;
  const combine = c ? [c.forty && `40 ${c.forty}`, c.vert && `vertical ${c.vert} in`, c.broad && `broad ${c.broad} in`, c.bench && `bench ${c.bench}`, c.cone && `3-cone ${c.cone}`, c.shuttle && `shuttle ${c.shuttle}`].filter(Boolean).join(" · ") : "";
  if (!rows.length && !combine) return null;
  return (
    <section className="mt-8">
      <p className="eyebrow">Charting and tracking</p>
      {rows.length > 0 && (
        <table className="mt-2 w-full max-w-2xl text-sm">
          <thead>
            <tr className="text-left text-xs text-chalk-3">
              <th className="py-1 pr-3 font-semibold">Stat</th>
              <th className="py-1 pr-3 font-semibold">{y}</th>
              <th className="py-1 pr-3 font-semibold">{y - 1}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="py-1.5 pr-3 text-chalk-2">
                  {r.label}
                  {r.note && <span className="block text-xs text-chalk-3">{r.note}</span>}
                </td>
                <td className="mono py-1.5 pr-3 text-chalk">{r.now ?? "not available"}</td>
                <td className="mono py-1.5 pr-3 text-chalk-2">{r.last ?? "not available"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {combine && (
        <p className="mono mt-2 text-xs text-chalk-2">
          Combine{c?.yr ? ` ${c.yr}` : ""}: {combine}
        </p>
      )}
      <p className="mt-2 max-w-2xl text-xs text-chalk-3">
        PFR charting (Pro Football Reference, a week behind), NFL Next Gen Stats (qualified players only), and expected fantasy points (ffverse: what his targets, carries, and field position were worth in PPR scoring), all through nflverse.
      </p>
    </section>
  );
}

function rowsFor(e: GenExtraPlayer, pg: string, y: number, pl: { s: Record<string, number> | null; ps: Record<string, number> | null }): Row[] {
  const rows: Row[] = [];
  const both = (f: (season: number) => string | undefined) => ({ now: f(y), last: f(y - 1) });
  const adv = (s: number) => e.adv?.[String(s)];
  const ngs = (s: number) => e.ngs?.[String(s)];

  // Usage against scoring, same scoring on both sides (PPR, no DraftKings bonuses).
  if (e.xfp?.length) {
    const avg = (s: number, k: 2 | 3) => {
      const xs = e.xfp!.filter((l) => l[0] === s);
      return xs.length ? `${r1(xs.reduce((a, b) => a + b[k], 0) / xs.length)} (${xs.length} g)` : undefined;
    };
    rows.push({ label: "Expected fantasy points a game", ...both((s) => avg(s, 2)), note: "What his usage was worth" });
    rows.push({ label: "Fantasy points a game", ...both((s) => avg(s, 3)), note: "What he scored, same scoring" });
  }
  if (pg === "QB") {
    rows.push({ label: "Pressured", ...both((s) => {
      const p = adv(s)?.pass;
      const st = s === y ? pl.s : pl.ps;
      const db = (st?.pa ?? 0) + (st?.sks ?? 0);
      return p?.press !== undefined && db ? `${pct(p.press / db)} of dropbacks` : undefined;
    }) });
    rows.push({ label: "Bad throws", ...both((s) => (adv(s)?.pass?.bad !== undefined ? String(adv(s)!.pass!.bad) : undefined)) });
    rows.push({ label: "Time to throw", ...both((s) => (ngs(s)?.pass?.ttt !== undefined ? `${r1(ngs(s)!.pass!.ttt!)} s` : undefined)) });
    rows.push({ label: "Completion % over expected", ...both((s) => (ngs(s)?.pass?.cpoe !== undefined ? `${ngs(s)!.pass!.cpoe! > 0 ? "+" : ""}${r1(ngs(s)!.pass!.cpoe!)}` : undefined)) });
    rows.push({ label: "Aggressive throws (into tight windows)", ...both((s) => (ngs(s)?.pass?.agg !== undefined ? `${r1(ngs(s)!.pass!.agg!)}%` : undefined)) });
  } else if (pg === "RB") {
    rows.push({ label: "Yards before contact a carry", note: "Mostly the blocking", ...both((s) => {
      const r = adv(s)?.rush;
      return r?.att && r.ybc !== undefined ? String(r1(r.ybc / r.att)) : undefined;
    }) });
    rows.push({ label: "Yards after contact a carry", note: "Mostly the runner", ...both((s) => {
      const r = adv(s)?.rush;
      return r?.att && r.yac !== undefined ? String(r1(r.yac / r.att)) : undefined;
    }) });
    rows.push({ label: "Broken tackles", ...both((s) => (adv(s)?.rush ? String((adv(s)!.rush!.brk ?? 0) + (adv(s)!.rush!.rbrk ?? 0)) : undefined)) });
    rows.push({ label: "Rush yards over expected a carry", ...both((s) => (ngs(s)?.rush?.ryoePer !== undefined ? `${ngs(s)!.rush!.ryoePer! > 0 ? "+" : ""}${r1(ngs(s)!.rush!.ryoePer!)}` : undefined)) });
    rows.push({ label: "Runs into 8+ defenders in the box", ...both((s) => (ngs(s)?.rush?.box8 !== undefined ? `${r1(ngs(s)!.rush!.box8!)}%` : undefined)) });
  } else if (pg === "WR" || pg === "TE") {
    rows.push({ label: "Separation at the catch point", ...both((s) => (ngs(s)?.rec?.sep !== undefined ? `${r1(ngs(s)!.rec!.sep!)} yds` : undefined)) });
    rows.push({ label: "Share of the team's intended air yards", ...both((s) => (ngs(s)?.rec?.airShare !== undefined ? `${r1(ngs(s)!.rec!.airShare!)}%` : undefined)) });
    rows.push({ label: "Yards after catch over expected", ...both((s) => (ngs(s)?.rec?.yacx !== undefined ? `${ngs(s)!.rec!.yacx! > 0 ? "+" : ""}${r1(ngs(s)!.rec!.yacx!)}` : undefined)) });
    rows.push({ label: "Drops", ...both((s) => (adv(s)?.rec ? String(adv(s)!.rec!.drops ?? 0) : undefined)) });
    rows.push({ label: "Broken tackles", ...both((s) => (adv(s)?.rec ? String(adv(s)!.rec!.brk ?? 0) : undefined)) });
  } else if (pg === "DL" || pg === "LB" || pg === "DB") {
    const d = (s: number) => adv(s)?.def;
    rows.push({ label: "Pressures", note: "Hurries, QB hits, and sacks", ...both((s) => (d(s)?.press !== undefined ? `${d(s)!.press} in ${d(s)!.g} g` : undefined)) });
    rows.push({ label: "Sacks / QB hits / hurries", ...both((s) => (d(s) ? `${d(s)!.sk ?? 0} / ${d(s)!.hit ?? 0} / ${d(s)!.hurry ?? 0}` : undefined)) });
    rows.push({ label: "Missed tackles", ...both((s) => {
      const x = d(s);
      return x?.mtk !== undefined && x.tk !== undefined && x.tk + x.mtk > 0 ? `${x.mtk} of ${x.tk + x.mtk} (${pct(x.mtk / (x.tk + x.mtk))})` : undefined;
    }) });
    rows.push({ label: "In coverage: targets, catches, yards", ...both((s) => {
      const x = d(s);
      return x?.tgt ? `${x.tgt} tgt, ${x.cmp ?? 0} caught, ${x.yds ?? 0} yds (${r1((x.yds ?? 0) / x.tgt)} a target), ${x.td ?? 0} TD` : undefined;
    }) });
  }
  return rows.filter((r) => r.now !== undefined || r.last !== undefined);
}
