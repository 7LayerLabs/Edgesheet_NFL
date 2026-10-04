import type { Game } from "@/lib/types";
import { spreadText } from "@/lib/format";

/**
 * Compact "Other systems" table under the EdgeSheet projection. Every row is a
 * projected home margin from a rating system (ESPN FPI, our Elo, our EPA model)
 * or our own blended model, with the posted line as a reference row and the
 * consensus sentence beneath. Server component, plain props.
 */
export function ConsensusTable({ game }: { game: Game }) {
  const c = game.consensus;
  if (!c) return null;
  const teamOf = (abbr?: string) => (abbr === game.home.abbr ? game.home : abbr === game.away.abbr ? game.away : undefined);
  const fmt = (margin: number, fav?: string) => `${teamOf(fav)?.short ?? fav ?? ""} by ${Math.abs(margin).toFixed(1)}`;
  const mkt = c.marketMargin;
  const graded = game.archive?.postgame?.consensusResult;
  return (
    <div className="mt-3 rounded border border-line bg-panel-2 p-3">
      <p className="eyebrow">Other systems · FPI from ESPN, Elo and the EPA model from this site</p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-chalk-3">
            <th className="py-1 pr-2 font-semibold">System</th>
            <th className="py-1 pr-2 font-semibold">Projects</th>
            <th className="py-1 pr-2 text-right font-semibold">Win prob</th>
            <th className="hidden py-1 text-right font-semibold sm:table-cell">vs number</th>
          </tr>
        </thead>
        <tbody>
          {c.systems.map((s) => {
            const lean = s.available && mkt !== undefined ? s.margin! - mkt : undefined;
            const leanTeam = lean === undefined ? undefined : lean >= 0 ? game.home : game.away;
            return (
              <tr key={s.key} className={`border-t border-line ${s.ours ? "bg-panel font-semibold text-chalk" : "text-chalk-2"}`}>
                <td className="py-1 pr-2">
                  {s.system}
                  {s.ours && <span className="ml-1.5 rounded bg-navy px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">ours</span>}
                  <span className="block text-[11px] font-normal text-chalk-3">{s.available ? s.note : s.source}</span>
                </td>
                {s.available ? (
                  <>
                    <td className="mono py-1 pr-2 whitespace-nowrap">{fmt(s.margin!, s.favorite)}</td>
                    <td className="mono py-1 pr-2 text-right">{s.winProb !== undefined ? `${Math.round(s.winProb * 100)}%` : "n/a"}</td>
                    <td className="mono hidden py-1 text-right whitespace-nowrap sm:table-cell">
                      {lean === undefined ? "no line" : Math.abs(lean) < 0.5 ? "on the number" : `${leanTeam!.abbr} ${lean >= 0 ? "+" : ""}${lean.toFixed(1)}`}
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="py-1 text-chalk-3">{s.note ?? "not available"}</td>
                )}
              </tr>
            );
          })}
          <tr className="border-t border-line text-chalk-3">
            <td className="py-1 pr-2">Market line<span className="block text-[11px] text-chalk-3">reference, not a system</span></td>
            {game.market.spread ? (
              <>
                <td className="mono py-1 pr-2 whitespace-nowrap">{spreadText(game.market.spread.team, game.market.spread.line)}</td>
                <td className="mono py-1 pr-2 text-right">{mkt !== undefined ? `${Math.round(impliedProb(mkt) * 100)}%` : ""}</td>
                <td className="hidden py-1 text-right sm:table-cell">0.0</td>
              </>
            ) : (
              <td colSpan={3} className="py-1">No posted spread.</td>
            )}
          </tr>
          {c.median !== undefined && (
            <tr className="border-t-2 border-line text-chalk">
              <td className="py-1 pr-2 font-semibold">Consensus<span className="block text-[11px] font-normal text-chalk-3">median of {c.available} available</span></td>
              <td className="mono py-1 pr-2 whitespace-nowrap font-semibold">{fmt(c.median, c.favorite)}</td>
              <td className="mono py-1 pr-2 text-right">{c.winProb !== undefined ? `${Math.round(c.winProb * 100)}%` : ""}</td>
              <td className="mono hidden py-1 text-right whitespace-nowrap sm:table-cell">
                {mkt === undefined ? "no line" : `${(c.median - mkt >= 0 ? game.home : game.away).abbr} ${c.median - mkt >= 0 ? "+" : ""}${(c.median - mkt).toFixed(1)}`}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-chalk">{c.summary}</p>
      <p className="mt-1 text-[11px] text-chalk-3">
        FPI is ESPN&apos;s rating difference plus 2 points of home field. Elo is ours from results (K 20, 48 Elo points of home field, 25 per point of spread). The EPA model is each offense&apos;s EPA per play against the other defense over the game&apos;s pace. Win probability for each uses the same 13.5-point normal as the model.
        {graded && ` Graded: consensus winner ${graded.winnerRight ? "right" : "wrong"}, margin off by ${graded.marginError.toFixed(0)}${graded.sideCovered !== undefined ? `, consensus side ${graded.sideCovered ? "covered" : "did not cover"}` : ""}.`}
      </p>
    </div>
  );
}

/** One line for the Market section: how many systems sit on which side of the number. */
export function ConsensusLine({ game }: { game: Game }) {
  const c = game.consensus;
  if (!c || c.side === undefined || c.sideCount === undefined) return null;
  const team = c.side === game.home.abbr ? game.home : game.away;
  return (
    <p className="mt-1 text-sm text-chalk-2">
      <span className="eyebrow mr-1">Consensus</span>
      {c.sideCount} of {c.available} systems lean {team.short} against the number{c.onNumber ? `, ${c.onNumber} on the number` : ""}{c.modelAgrees !== undefined ? `, the EdgeSheet model ${c.modelAgrees ? "with them" : "against them"}` : ""}.
    </p>
  );
}

/** Market-implied favorite probability from a spread, same 13.5-point normal as the model. */
function impliedProb(margin: number): number {
  const x = Math.abs(margin) / (13.5 * Math.SQRT2);
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return 0.5 * (1 + s * y);
}
