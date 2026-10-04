import Link from "next/link";
import type { ArchiveEntry } from "@/lib/archive";
import { buildLedger, type BetResult } from "@/lib/ledger";
import { hasOddsKey } from "@/lib/odds";
import { asOf, spreadText } from "@/lib/format";
import { LEDGER_MIN, gated, type GatedValue } from "@/lib/gate";
import { Gated } from "@/components/Gated";

/**
 * Ledger: every graded game with a strong or moderate model lean, the number at
 * lock, the closing number, the result, closing-line value, and a flat-bet
 * simulation. Clearly labeled as a simulation; it is not advice.
 */
export function LedgerSection({ entries }: { entries: ArchiveEntry[] }) {
  const { rows, stats } = buildLedger(entries);
  const keyMissing = !hasOddsKey();
  const u = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}u`;
  const clvText = (n: number | undefined) => (n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(1)}`);
  const tone = (r: BetResult) => (r === "win" ? "text-turf" : r === "loss" ? "text-brick" : "text-chalk-3");

  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-3">
        <h2 className="display text-3xl font-bold text-chalk">Ledger</h2>
        <span className="mono text-xs text-chalk-3">simulation, not advice</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <p className="mt-1 max-w-3xl text-sm text-chalk-3">
        Every graded game where the model leaned at least 3 points off the posted spread or 4 off the total. The simulation stakes one flat unit on each strong lean (6 or more points)
        at standard -110 and does nothing else. Closing-line value is how many points the closing consensus moved toward the model&apos;s side after the lock; positive means the market
        agreed with the model by kickoff. Both numbers are tuning signals for the model, not a betting record.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <Tile label="Simulated units" value={stats.bets ? gated(stats.bets, LEDGER_MIN, u(stats.units)) : "–"} sub={stats.bets ? `${stats.wins}-${stats.losses}${stats.pushes ? `-${stats.pushes}` : ""} on ${stats.bets} strong leans${stats.bets >= LEDGER_MIN ? ` · ROI ${stats.roi}%` : ""}` : "no strong leans graded yet"} tone={stats.bets >= LEDGER_MIN ? (stats.units > 0 ? "good" : stats.units < 0 ? "bad" : undefined) : undefined} />
        <Tile label="With moderate leans" value={stats.betsAll ? gated(stats.betsAll, LEDGER_MIN, u(stats.unitsAll)) : "–"} sub={stats.betsAll ? `${stats.betsAll} bets at one unit${stats.betsAll >= LEDGER_MIN ? ` · ROI ${stats.roiAll}%` : ""}` : "none graded yet"} />
        <Tile label="CLV average" value={stats.clvAvg != null ? gated(stats.clvCount, LEDGER_MIN, `${stats.clvAvg > 0 ? "+" : ""}${stats.clvAvg.toFixed(2)}`) : "–"} sub={stats.clvCount ? `${stats.clvPositive} of ${stats.clvCount} legs beat the close${stats.clvCount >= LEDGER_MIN ? ` · side ${clvText(stats.sideClvAvg ?? undefined)}, total ${clvText(stats.totalClvAvg ?? undefined)}` : ""}` : keyMissing ? "needs ODDS_API_KEY for closing lines" : "no closing snapshots before kickoff yet"} tone={stats.clvAvg != null && stats.clvCount >= LEDGER_MIN ? (stats.clvAvg > 0 ? "good" : stats.clvAvg < 0 ? "bad" : undefined) : undefined} />
        <Tile label="Leans graded" value={String(stats.rows)} sub={`${stats.bets} strong, ${stats.betsAll - stats.bets} moderate legs`} />
      </div>
      {(stats.bets < LEDGER_MIN || stats.clvCount < LEDGER_MIN) && stats.rows > 0 && (
        <p className="mono mt-2 text-xs text-chalk-3">Units, ROI, and CLV averages show once {LEDGER_MIN} legs are staked or closed. The table below is the full record either way.</p>
      )}

      {keyMissing && (
        <p className="mt-2 text-xs text-warn">Add ODDS_API_KEY to .env.local and run odds:snapshot on a schedule so the closing columns fill in. Results and units grade from the archive without it.</p>
      )}

      {rows.length > 0 ? (
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="mono text-[10px] uppercase tracking-wider text-chalk-3">
                <th className="px-3 py-2 font-semibold">Game</th>
                <th className="px-3 py-2 font-semibold">Lean</th>
                <th className="px-3 py-2 font-semibold">At lock</th>
                <th className="px-3 py-2 font-semibold">Closing</th>
                <th className="px-3 py-2 font-semibold">CLV</th>
                <th className="px-3 py-2 font-semibold">Result</th>
                <th className="px-3 py-2 font-semibold">Units</th>
                <th className="px-3 py-2 font-semibold">Running</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((r) => {
                const legs: React.ReactNode[] = [];
                if (r.side) {
                  const s = r.side;
                  legs.push(
                    <tr key={`${r.gameId}-side`} className="border-t border-line align-top">
                      <td className="px-3 py-2">
                        <Link href={`/game/${r.gameId}`} className="display text-lg font-bold text-chalk hover:text-sky">{r.label}</Link>
                        <p className="mono text-xs text-chalk-3">{asOf(r.kickoff)} · final {r.score}</p>
                      </td>
                      <td className="mono px-3 py-2 text-chalk">{s.team} side <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${s.strength === "strong" ? "bg-brick text-white" : "bg-navy text-white"}`}>{s.strength}</span><br /><span className="text-xs text-chalk-3">model off by {s.gap}</span></td>
                      <td className="mono px-3 py-2 text-chalk">{spreadText(s.lockLine.team, s.lockLine.line)}</td>
                      <td className="mono px-3 py-2 text-chalk">{s.closing ? spreadText(s.closing.team, s.closing.line) : <span className="text-chalk-3">no snapshot</span>}</td>
                      <td className={`mono px-3 py-2 ${s.clv === undefined ? "text-chalk-3" : s.clv > 0 ? "text-turf" : s.clv < 0 ? "text-brick" : "text-chalk"}`}>{clvText(s.clv)}</td>
                      <td className={`mono px-3 py-2 font-semibold ${tone(s.result)}`}>{s.result}</td>
                      <td className={`mono px-3 py-2 ${tone(s.result)}`}>{s.strength === "strong" ? u(s.units) : <span className="text-chalk-3">{u(s.units)} (not staked)</span>}</td>
                      <td className="mono px-3 py-2 text-chalk">{r.total ? "" : u(r.runStrong)}</td>
                    </tr>,
                  );
                }
                if (r.total) {
                  const t = r.total;
                  legs.push(
                    <tr key={`${r.gameId}-total`} className={`align-top ${r.side ? "" : "border-t border-line"}`}>
                      <td className="px-3 py-2">
                        {!r.side && (
                          <>
                            <Link href={`/game/${r.gameId}`} className="display text-lg font-bold text-chalk hover:text-sky">{r.label}</Link>
                            <p className="mono text-xs text-chalk-3">{asOf(r.kickoff)} · final {r.score}</p>
                          </>
                        )}
                      </td>
                      <td className="mono px-3 py-2 text-chalk">{t.lean} <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${t.strength === "strong" ? "bg-brick text-white" : "bg-navy text-white"}`}>{t.strength}</span><br /><span className="text-xs text-chalk-3">model off by {t.gap}</span></td>
                      <td className="mono px-3 py-2 text-chalk">{t.lockTotal}</td>
                      <td className="mono px-3 py-2 text-chalk">{t.closingTotal !== undefined ? t.closingTotal : <span className="text-chalk-3">no snapshot</span>}</td>
                      <td className={`mono px-3 py-2 ${t.clv === undefined ? "text-chalk-3" : t.clv > 0 ? "text-turf" : t.clv < 0 ? "text-brick" : "text-chalk"}`}>{clvText(t.clv)}</td>
                      <td className={`mono px-3 py-2 font-semibold ${tone(t.result)}`}>{t.result}</td>
                      <td className={`mono px-3 py-2 ${tone(t.result)}`}>{t.strength === "strong" ? u(t.units) : <span className="text-chalk-3">{u(t.units)} (not staked)</span>}</td>
                      <td className="mono px-3 py-2 text-chalk">{u(r.runStrong)}</td>
                    </tr>,
                  );
                }
                return legs;
              })}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-chalk-3">Running column is strong leans only, oldest to newest, one unit each at -110. The number at lock is the CollegeFootballData consensus the model saw; the closing number is the Odds API consensus from the last snapshot before kickoff.</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-chalk-3">No graded game has carried a moderate or strong lean yet.</p>
      )}
    </section>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: GatedValue; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`display mt-1 text-4xl font-bold ${tone === "good" ? "text-turf" : tone === "bad" ? "text-brick" : "text-chalk"}`}><Gated value={value} /></p>
      {sub && <p className="mt-0.5 text-xs text-chalk-3">{sub}</p>}
    </div>
  );
}
