import { asOf } from "@/lib/format";
import { isUnavailable } from "@/lib/llm";
import { readReport, reportProvider, seasonOf } from "@/lib/report";
import type { Game } from "@/lib/types";
import { WriteReportButton } from "./WriteReportButton";

/** Server component. Reads the cached report from disk; never calls a model on page load. */
/** `bare` drops the section wrapper and label, for use inside a collapsible section that already carries the title. */
export function WrittenReport({ game, bare }: { game: Game; bare?: boolean }) {
  const d1 = true;
  const cached = d1 ? readReport(seasonOf(game.kickoff), game.id) : undefined;
  const provider = reportProvider();
  const stale = cached?.report && cached.pregame && game.status !== "upcoming";

  return (
    <section id={bare ? undefined : "report"} className={bare ? "" : "mt-10 scroll-mt-28"}>
      {!bare && <p className="eyebrow">Written report</p>}
      {cached?.report ? (
        <>
          <h2 className="display mt-1 text-3xl font-bold leading-tight text-chalk sm:text-4xl">{cached.report.headline}</h2>
          <div className="card mt-3 border-l-4 border-l-navy p-5">
            <p className="text-lg leading-relaxed text-chalk">{cached.report.openingParagraph}</p>
            {cached.report.sections.map((s) => (
              <div key={s.title} className="mt-5 border-t border-line pt-4">
                <h3 className="display text-2xl font-bold text-chalk">{s.title}</h3>
                {s.paragraphs.map((p, i) => (
                  <p key={i} className="mt-2 text-base leading-relaxed text-chalk-2">{p}</p>
                ))}
                {s.factIds.length > 0 && <p className="mono mt-2 text-[11px] text-chalk-3">Rests on evidence {s.factIds.join(", ")}</p>}
              </div>
            ))}
            <p className="mt-5 border-t border-line pt-3 text-base font-semibold text-chalk">{cached.report.oneLineForCard}</p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="mono text-xs text-chalk-3">
              Written by {cached.model} {asOf(cached.generatedAt)} from evidence as of {asOf(cached.evidenceAsOf)}{cached.pregame ? ", pregame" : ""}. Every name and number checked against the evidence packet ({cached.factCount} facts{cached.attempts > 1 ? `, ${cached.attempts} attempts` : ""}).
            </span>
            {!isUnavailable(provider) && <WriteReportButton id={game.id} label={stale ? "Rewrite with the final" : "Rewrite"} force />}
          </div>
          {stale && <p className="mt-1 text-xs text-warn">This report was written before kickoff. The game has moved on; rewrite it to include what the evidence shows now.</p>}
        </>
      ) : (
        <>
          <h2 className="display mt-1 text-3xl font-bold leading-tight text-chalk sm:text-4xl">{d1 ? "No report written yet" : "No report"}</h2>
          {d1 && (
            <div className="card mt-3 p-5">
              {isUnavailable(provider) ? (
                <p className="text-sm text-chalk-3">Reports need a model key. Add ANTHROPIC_API_KEY (or OPENAI_API_KEY as a fallback) to .env.local.</p>
              ) : (
                <>
                  <p className="text-base text-chalk-2">
                    A 250 to 450 word report built only from the evidence on this page: the matchups, the projection, the radar names, the style profiles, the forecast, and the market. The model explains and ranks the evidence; it cannot add a player, a stat, or a scheme that is not already here, and every name and number is checked before it shows.
                  </p>
                  {cached?.failed && (
                    <p className="mt-2 text-sm text-brick">Last attempt ({asOf(cached.generatedAt)}, {cached.model}) was rejected and not published: {cached.failed.reasons.join(" / ")}</p>
                  )}
                  <div className="mt-3">
                    <WriteReportButton id={game.id} force={Boolean(cached?.failed)} />
                  </div>
                  <p className="mono mt-2 text-[11px] text-chalk-3">Writer: {provider.model}. Reports are written on purpose, not for every game.</p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
