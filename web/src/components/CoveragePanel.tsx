import { coverageFile, coverageMatchup, coverageNote, type CoveragePlayer, type CoverageTeam } from "@/lib/coverage";

const pct = (x: number | null | undefined) => (x == null ? "?" : `${Math.round(x * 100)}%`);
const rank = (r?: number) => (r ? `No. ${r}` : "");

/**
 * Coverage, last season: each defense's safety shells (the read that carries over), man rate and pressure as context,
 * and how the other team's top three targets did against man and zone. Server component; renders nothing without
 * data/generated/coverage.json (node scripts/ingest-coverage.mjs).
 */
export function CoveragePanel({ away, home }: { away: string; home: string }) {
  const f = coverageFile();
  if (!f) return null;
  const sides: [string, string][] = [
    [home, away], // home defense against the away offense
    [away, home],
  ];
  const note = coverageNote();
  return (
    <div className="mt-4">
      <p className="eyebrow">Coverage, {f.season} season</p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {sides.map(([def, off]) => {
          const d = f.teams[def];
          if (!d) return null;
          // Top three targets on the offense's roster today, by last season's targets.
          const targets = coverageMatchup(off, def)?.targets ?? [];
          return <Side key={def} def={def} off={off} d={d} targets={targets} />;
        })}
      </div>
      <p className="mt-2 max-w-3xl text-xs leading-snug text-chalk-3">
        FTN charting via nflverse, regular season. nflverse posts it after a season ends, so this is last season, and rosters and coordinators change.
        {note ? ` ${note}` : ""}
      </p>
    </div>
  );
}

function Side({ def, off, d, targets }: { def: string; off: string; d: CoverageTeam; targets: CoveragePlayer[] }) {
  const x = d.def;
  return (
    <div className="card p-4">
      <p className="text-sm font-semibold text-chalk">{def} defense</p>
      <dl className="mono mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-chalk-2">
        <dt className="text-chalk-3">Two deep safeties</dt>
        <dd>
          {pct(x.twoHigh.value)} <span className="text-chalk-3">{rank(x.twoHigh.rank)}</span>
        </dd>
        <dt className="text-chalk-3">Man coverage</dt>
        <dd>
          {pct(x.man.value)} <span className="text-chalk-3">{rank(x.man.rank)}</span>
        </dd>
        <dt className="text-chalk-3">5+ rushers</dt>
        <dd>
          {pct(x.rush5.value)} <span className="text-chalk-3">{rank(x.rush5.rank)}</span>
        </dd>
        <dt className="text-chalk-3">Pressure rate</dt>
        <dd>
          {pct(x.pressure.value)} <span className="text-chalk-3">{rank(x.pressure.rank)}</span>
        </dd>
      </dl>
      <p className="mt-1 text-xs text-chalk-3">
        Shells: {x.shells.slice(0, 4).map((s) => `${s.shell} ${pct(s.pct)}`).join(", ")} · {x.charted.toLocaleString("en-US")} pass plays charted
      </p>
      <p className="mt-3 text-xs font-semibold text-chalk-2">{off} targets against man and zone</p>
      {targets.length === 0 ? (
        <p className="mt-1 text-xs text-chalk-3">No {off} receiver had 10 or more targets last season.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line text-xs">
          {targets.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 py-1">
              <span className="font-medium text-chalk">{p.name}</span>
              <span className="mono text-chalk-3">{p.pos}</span>
              {p.man.enough && p.zone.enough ? (
                <span className="mono ml-auto text-chalk-2">
                  zone {p.zone.ypt?.toFixed(1)} yds/tgt ({p.zone.tgt}) · man {p.man.ypt?.toFixed(1)} ({p.man.tgt})
                </span>
              ) : (
                <span className="mono ml-auto text-chalk-3">
                  not enough targets vs {!p.man.enough ? `man (${p.man.tgt})` : `zone (${p.zone.tgt})`}
                </span>
              )}
              {p.team && p.team !== off && <span className="w-full text-chalk-3">with the {p.team} last season</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
