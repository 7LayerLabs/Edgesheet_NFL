import Link from "next/link";
import { backtestResults, type GradeRow } from "@/lib/backtest";
import { asOf } from "@/lib/format";

export const dynamic = "force-dynamic";

const pct = (v: number | null | undefined, d = 1) => (v == null ? "n/a" : `${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 1) => (v == null ? "n/a" : v.toFixed(d));

export default function BacktestPage() {
  const r = backtestResults();
  return (
    <div>
      <p className="eyebrow">Track record</p>
      <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">How the Elo did on past seasons</h1>
      <p className="mt-2 max-w-3xl text-base text-chalk-3">
        The Elo projection replayed on {r ? r.seasons.join(", ") : "past seasons"} and graded against real finals and the nflverse closing line. {r ? `Replay run ${asOf(r.ranAt)}.` : ""} The live <Link href="/history" className="text-sky">Record</Link> page grades this season&apos;s locked calls one game at a time.
      </p>

      {!r && (
        <div className="card mt-6 p-8 text-center">
          <p className="display text-3xl text-chalk">The replay has not been run</p>
          <p className="mt-1 text-base text-chalk-3">From the web folder, run <span className="mono">npm run backtest</span>. It needs the schedule digest from <span className="mono">npm run ingest</span> and no network.</p>
        </div>
      )}

      {r && (
        <>
          <section className="mt-8">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="display text-3xl font-bold text-chalk">Elo against the closing line</h2>
              <span className="mono text-xs text-chalk-3">home field {r.live.home} Elo, {r.live.perPoint} Elo per point, K {r.live.k}, regression {r.live.regress} each season</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <Tile label="Winner right" value={pct(r.overall.winnerRate)} sub={`${r.overall.winnerRight} of ${r.overall.winnerGraded} decided games · market ${pct(r.overall.marketWinnerRate)}`} />
              <Tile label="Margin error" value={num(r.overall.mae)} sub={`mean absolute, points · market ${num(r.overall.marketMae)} · bias ${num(r.overall.bias)}`} />
              <Tile label="Elo side covered" value={pct(r.overall.coverRate)} sub={`${r.overall.coverRight} of ${r.overall.coverGraded}, every game with a lean`} />
              <Tile label="4+ point lean covered" value={pct(r.overall.lean4CoverRate)} sub={`${r.overall.lean4Graded} games · 2+ lean ${pct(r.overall.lean2CoverRate)} of ${r.overall.lean2Graded}`} />
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-chalk-3">
                    <th className="py-1 pr-3 font-semibold">Season</th>
                    <th className="py-1 pr-3 text-right font-semibold">Games</th>
                    <th className="py-1 pr-3 text-right font-semibold">Elo winner</th>
                    <th className="py-1 pr-3 text-right font-semibold">Market winner</th>
                    <th className="py-1 pr-3 text-right font-semibold">Elo MAE</th>
                    <th className="py-1 pr-3 text-right font-semibold">Market MAE</th>
                    <th className="py-1 pr-3 text-right font-semibold">Cover</th>
                    <th className="py-1 pr-3 text-right font-semibold">2+ lean</th>
                    <th className="py-1 pr-3 text-right font-semibold">4+ lean</th>
                    <th className="py-1 text-right font-semibold">Fav covered</th>
                  </tr>
                </thead>
                <tbody>
                  {r.perSeason.map((s) => (
                    <Row key={s.season} label={String(s.season)} g={s.all} />
                  ))}
                  <Row label="All, regular season" g={r.overallRegular} strong />
                  <Row label="All, with playoffs" g={r.overall} strong />
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <p className="eyebrow">Calibration</p>
              <p className="mt-1 text-sm text-chalk-3">Games grouped by the Elo win probability of its pick, and how often that pick won.</p>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {r.overall.calibration.map((c) => (
                    <tr key={c.bucket} className="border-t border-line">
                      <td className="mono py-1 pr-3 text-chalk-2">{c.bucket}%</td>
                      <td className="mono py-1 pr-3 text-right text-chalk-3">{c.games} games</td>
                      <td className="mono py-1 text-right text-chalk">{pct(c.winRate, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mono mt-2 text-xs text-chalk-3">Home teams won {pct(r.overall.homeWinRate)} of the graded games.</p>
            </div>
            <div className="card p-4">
              <p className="eyebrow">Constant fit</p>
              <p className="mt-1 text-sm text-chalk-3">Grid over home field and Elo per point, scored by margin error on the regular season. The live constants stay until Derek changes them; the fit is written to data/weights.json.</p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-chalk-3">
                    <th className="py-1 pr-3 font-semibold">Home</th>
                    <th className="py-1 pr-3 font-semibold">Per point</th>
                    <th className="py-1 pr-3 text-right font-semibold">MAE</th>
                    <th className="py-1 pr-3 text-right font-semibold">Winner</th>
                    <th className="py-1 text-right font-semibold">4+ lean</th>
                  </tr>
                </thead>
                <tbody>
                  {r.fit.top.map((f) => (
                    <tr key={`${f.home}-${f.perPoint}`} className={`border-t border-line ${f === r.fit.top[0] ? "font-semibold text-chalk" : "text-chalk-2"}`}>
                      <td className="mono py-1 pr-3">{f.home}</td>
                      <td className="mono py-1 pr-3">{f.perPoint}</td>
                      <td className="mono py-1 pr-3 text-right">{num(f.mae, 2)}</td>
                      <td className="mono py-1 pr-3 text-right">{pct(f.winnerRate)}</td>
                      <td className="mono py-1 text-right">{pct(f.lean4CoverRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card mt-6 p-4 text-sm text-chalk-3">
            <p className="eyebrow">What this can and cannot claim</p>
            <ul className="mt-2 grid gap-1 pl-4">
              {r.notes.map((n) => (
                <li key={n} className="list-disc">{n}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, g, strong = false }: { label: string; g: GradeRow; strong?: boolean }) {
  return (
    <tr className={`border-t border-line ${strong ? "bg-panel font-semibold text-chalk" : "text-chalk-2"}`}>
      <td className="py-1.5 pr-3">{label}</td>
      <td className="mono py-1.5 pr-3 text-right">{g.games}</td>
      <td className="mono py-1.5 pr-3 text-right">{pct(g.winnerRate)}</td>
      <td className="mono py-1.5 pr-3 text-right">{pct(g.marketWinnerRate)}</td>
      <td className="mono py-1.5 pr-3 text-right">{num(g.mae)}</td>
      <td className="mono py-1.5 pr-3 text-right">{num(g.marketMae)}</td>
      <td className="mono py-1.5 pr-3 text-right">{pct(g.coverRate)}</td>
      <td className="mono py-1.5 pr-3 text-right">{pct(g.lean2CoverRate)} <span className="text-chalk-3">({g.lean2Graded})</span></td>
      <td className="mono py-1.5 pr-3 text-right">{pct(g.lean4CoverRate)} <span className="text-chalk-3">({g.lean4Graded})</span></td>
      <td className="mono py-1.5 text-right">{pct(g.favoriteCoverRate)}</td>
    </tr>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="display mt-1 text-3xl font-bold text-chalk">{value}</p>
      {sub && <p className="mt-1 text-xs text-chalk-3">{sub}</p>}
    </div>
  );
}
