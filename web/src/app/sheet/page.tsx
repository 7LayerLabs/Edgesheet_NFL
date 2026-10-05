import Link from "next/link";
import { buildSheet, type Sheet } from "@/lib/sheet";
import { LEAN_BACKTEST_NOTE } from "@/lib/digests";
import { telegramReady } from "@/lib/telegram";
import { SheetActions } from "@/components/SheetActions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: PageProps<"/sheet">) {
  const sp = await searchParams;
  const date = typeof sp.date === "string" ? sp.date : undefined;
  return { title: `EdgeSheet${date ? `, ${date}` : ""}`, description: "The one-page Sunday sheet: games that matter, unit edges, model leans, radar names, kickoff windows, weather flags." };
}

/**
 * The Sunday sheet. One Letter page, light, dense. Built entirely from the
 * app's own data via buildSheet(). `?print=1` hides the site chrome so the
 * headless Chrome screenshot (src/lib/render.ts) captures only the sheet.
 */
export default async function SheetPage({ searchParams }: PageProps<"/sheet">) {
  const sp = await searchParams;
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : undefined;
  const chromeless = sp.print === "1";
  // The PNG goes out as two Letter pages: part 1 is games, edges, leans; part 2 is DraftKings, props, windows, weather.
  const part = sp.part === "1" ? 1 : sp.part === "2" ? 2 : 0;
  const sheet = await buildSheet(date);

  return (
    <div className={`sheet-root ${chromeless ? "sheet-chromeless" : ""}`}>
      <style>{SHEET_CSS}</style>
      {!chromeless && (
        <div className="sheet-actions mb-3 flex flex-wrap items-center justify-between gap-2">
          <Link href={`/?date=${sheet.date}`} className="mono text-xs text-chalk-3 hover:text-chalk">← Slate</Link>
          <SheetActions date={sheet.date} telegramEnabled={telegramReady()} />
        </div>
      )}
      <article className="sheet">
        <Header s={sheet} part={part} />
        {part !== 2 && (
          <>
            <GamesThatMatter s={sheet} />
            <div className="sheet-cols">
              <Edges s={sheet} />
              <Leans s={sheet} />
            </div>
          </>
        )}
        {part !== 1 && (
          <>
            <DkPlays s={sheet} />
            <DefenseProps s={sheet} />
            <div className="sheet-cols">
              <Windows s={sheet} />
              <Weather s={sheet} />
            </div>
          </>
        )}
        <footer className="sheet-foot">
          <span>{sheet.notAPick} Elo, unit edges, and who is playing against the posted number, graded on the Record page after every final.</span>
          {part !== 2 && <span>{LEAN_BACKTEST_NOTE}</span>}
          {part !== 1 && sheet.dfs.source && <span>{sheet.dfs.source}. DK pts scored from nflverse game lines with Classic rules (no two-point conversions). Proj = our average blended with last season (worth 3 games), times a quarter of the matchup factor, plus half of a new Out teammate&apos;s average. Value = proj per $1,000.</span>}
          <span>
            Schedule and lines from nflverse and The Odds API. Forecasts from the National Weather Service. Stats as of {sheet.statsAsOf ? sheet.statsAsOf.slice(0, 10) : "not available"}. Built {new Date(sheet.builtAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET.
          </span>
        </footer>
      </article>
    </div>
  );
}

/* ----------------------------------------------------------- sections */

function Header({ s, part }: { s: Sheet; part: number }) {
  return (
    <header className="sheet-head">
      <div>
        <p className="eyebrow">
          {s.season}
          {s.week ? ` · Week ${s.week}` : ""} · NFL
        </p>
        <h1 className="display sheet-title">{s.dateLong}</h1>
      </div>
      <div className="sheet-brand">
        <div className="display sheet-logo">EdgeSheet</div>
        <div className="mono sheet-counts">
          {s.counts.d1} games · {s.counts.divGames} division games{part ? ` · page ${part} of 2` : ""}
        </div>
      </div>
    </header>
  );
}

function SectionTitle({ n, children, note }: { n: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="sheet-sec">
      <span className="sheet-sec-n mono">{n}</span>
      <span className="display sheet-sec-t">{children}</span>
      {note && <span className="sheet-sec-note">{note}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="sheet-empty">{children}</p>;
}

function GamesThatMatter({ s }: { s: Sheet }) {
  return (
    <section>
      <SectionTitle n="01" note="top 8 by Watch Score">Games that matter</SectionTitle>
      {!s.games.length ? (
        <Empty>{s.notes[0] ?? "No games on this date."}</Empty>
      ) : (
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="w-8">Score</th>
              <th>Game</th>
              <th className="w-16 sheet-hide-sm">Kick</th>
              <th className="w-14 sheet-hide-sm">TV</th>
              <th className="w-20">Line</th>
              <th className="w-8">O/U</th>
              <th className="w-24">Model lean</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {s.games.map((g) => (
              <tr key={g.id}>
                <td className="mono sheet-score">{g.score}</td>
                <td className="sheet-game">
                  <Link href={`/game/${g.id}`}>
                    {g.away} <span className="text-chalk-3">at</span> {g.home}
                  </Link>
                  {g.status !== "upcoming" && <span className={`sheet-status ${g.status === "live" ? "text-turf" : "text-brick"}`}>{g.status}</span>}
                </td>
                <td className="mono sheet-hide-sm">{g.kickoff}</td>
                <td className="sheet-hide-sm">{g.network || "no TV listed"}</td>
                <td className="mono">{g.line ?? "no line"}</td>
                <td className="mono" data-label="O/U">{g.total ?? "–"}</td>
                <td className="mono" data-label="Model">{g.lean ?? "no model"}</td>
                <td className="sheet-why">{g.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Edges({ s }: { s: Sheet }) {
  return (
    <section>
      <SectionTitle n="02" note="biggest unit mismatch per game, percentile gap">Edges</SectionTitle>
      {!s.edges.length ? (
        <Empty>No charted unit edges on this slate. Advanced stats are not ingested for these teams.</Empty>
      ) : (
        <ol className="sheet-list">
          {s.edges.map((e) => (
            <li key={`${e.gameId}-${e.title}`}>
              <span className="mono sheet-gap">+{Math.round(e.gap)}</span>
              <span>
                <b>{e.winner}</b> <span className="text-chalk-3">{e.strength} edge</span>
                <br />
                <span className="sheet-sub">{e.title}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Leans({ s }: { s: Sheet }) {
  return (
    <section>
      <SectionTitle n="03" note="gaps to the posted number, not picks">Leans</SectionTitle>
      {!s.leans.length ? (
        <Empty>No side or total gap clears the lean threshold (2 points side, 2.5 points total).</Empty>
      ) : (
        <ol className="sheet-list">
          {s.leans.map((l) => (
            <li key={`${l.gameId}-${l.kind}`}>
              <span className={`sheet-strength ${l.strength === "strong" ? "sheet-strong" : ""}`}>{l.strength === "strong" ? "big gap" : "gap"}</span>
              <span>
                <b>{l.kind === "side" ? "Side" : "Total"}</b> {l.text}
                <br />
                <span className="sheet-sub">{l.matchup}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DkPlays({ s }: { s: Sheet }) {
  const plays = s.dfs.plays;
  return (
    <section>
      <SectionTitle n="04" note="best value by projected DK points per $1,000">DraftKings plays</SectionTitle>
      {!plays.length ? (
        <Empty>{s.dfs.note ?? "No DraftKings salaries for the games still to play."}</Empty>
      ) : (
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="w-8">Pos</th>
              <th>Player</th>
              <th className="w-12">Team</th>
              <th className="w-14">Salary</th>
              <th className="w-10">Proj</th>
              <th className="w-10">Value</th>
              <th>Why</th>
              <th className="w-24 sheet-hide-sm">Game</th>
              <th className="w-16 sheet-hide-sm">Kick</th>
            </tr>
          </thead>
          <tbody>
            {plays.map((p) => (
              <tr key={`${p.gameId}-${p.name}`}>
                <td className="mono">{p.pos}</td>
                <td className="sheet-game">
                  {p.id ? <Link href={`/player/${p.id}`}>{p.name}</Link> : p.name}
                  {p.status ? <span className="sheet-status sheet-elevated">{p.status}</span> : null}
                </td>
                <td>{p.teamAbbr}</td>
                <td className="mono">
                  ${p.salary.toLocaleString("en-US")}
                  {p.slate === "showdown" ? " SD" : ""}
                </td>
                <td className="mono sheet-score" data-label="Proj">{p.proj}</td>
                <td className={`mono ${p.slate === "classic" && p.value >= 4 ? "sheet-good" : ""}`} data-label="Value">{p.value}x</td>
                <td className="sheet-why">{p.why}</td>
                <td className="mono sheet-hide-sm">{p.matchup}</td>
                <td className="mono sheet-hide-sm">{p.kickoff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.dfs.showdown.map((g) => (
        <p key={g.matchup} className="sheet-showdown">
          <strong>Showdown only, {g.matchup} {g.kickoff}:</strong>{" "}
          {g.plays.map((p, i) => (
            <span key={p.name}>
              {i ? "; " : ""}
              {p.name} {p.pos} ${p.salary.toLocaleString("en-US")}, proj {p.proj}
              {p.bump && p.pos !== "QB" && p.bump.pts ? ` (+${p.bump.pts}, ${p.bump.from} ${p.bump.status})` : p.bump && p.pos === "QB" ? ` (starts for ${p.bump.from})` : ""}
            </span>
          ))}
        </p>
      ))}
    </section>
  );
}

function DefenseProps({ s }: { s: Sheet }) {
  const col = (title: string, note: string, rows: Sheet["dfs"]["tackles"], market: string) => (
    <div>
      <p className="sheet-sub-h">
        {title} <span className="sheet-sub">{note}</span>
      </p>
      {!rows.length ? (
        <Empty>No defender clears the bar on this slate.</Empty>
      ) : (
        <ul className="sheet-list">
          {rows.map((d) => (
            <li key={`${d.kind}-${d.id}`}>
              <span className="sheet-gap">{d.kind === "tackles" ? d.tkpg : d.hits}</span>
              <span>
                <strong>{d.name}</strong> <span className="sheet-sub">{d.pos} · {d.teamAbbr} vs {d.oppAbbr} · {d.kickoff}</span>
                {d.line?.point !== undefined && (
                  <span className="sheet-line">
                    {" "}
                    {market} {d.line.point}
                  </span>
                )}
                <br />
                <span className="sheet-sub">{d.why}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <section>
      <SectionTitle n="05" note="tackle volume against play volume, pass rush against pressure allowed">Defensive names for props</SectionTitle>
      <div className="sheet-cols">
        {col("Tackles", "a game with assists, ranked vs opponent play volume", s.dfs.tackles, "tkl+ast")}
        {col("Pass rush", "QB hits, ranked vs pressure the opponent allows", s.dfs.rush, "sacks")}
      </div>
    </section>
  );
}

function Windows({ s }: { s: Sheet }) {
  return (
    <section>
      <SectionTitle n="06" note={s.counts.ranked ? "ranked games by hour, ET" : "top games by hour, ET"}>Kickoff windows</SectionTitle>
      {!s.windows.length ? (
        <Empty>No games to place on the timeline.</Empty>
      ) : (
        <div className="sheet-timeline">
          {s.windows.map((w) => (
            <div key={w.hour} className="sheet-slot">
              <div className="mono sheet-hour">{w.hour}</div>
              <div className="sheet-slot-games">
                {w.games.map((g) => (
                  <div key={g.id} className="sheet-slot-game">
                    <span className="mono sheet-slot-score">{g.score}</span>
                    <span>{g.label}</span>
                    <span className="text-chalk-3">{g.network}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Weather({ s }: { s: Sheet }) {
  return (
    <section>
      <SectionTitle n="07" note="NWS forecast through the rules engine">Weather flags</SectionTitle>
      {!s.weather.length ? (
        <Empty>No flags. Every forecast is inside normal ranges or the game is indoors.</Empty>
      ) : (
        <ul className="sheet-list">
          {s.weather.slice(0, 8).map((w, i) => (
            <li key={`${w.gameId}-${w.title}-${i}`}>
              <span className={`sheet-strength ${w.level === "elevated" ? "sheet-elevated" : ""}`}>{w.level}</span>
              <span>
                <b>{w.title}</b> <span className="text-chalk-3">{w.matchup}, {w.kickoff}</span>
                <br />
                <span className="sheet-sub">{w.effect}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- css */

const SHEET_CSS = `
.sheet-root { max-width: 8.5in; margin: 0 auto; }
.sheet { background: #fff; border: 1px solid var(--line); border-radius: 4px; padding: 0.38in 0.42in; color: var(--chalk); font-size: 9.5px; line-height: 1.3; }
.sheet section { margin-top: 10px; break-inside: avoid; }
.sheet a { color: inherit; text-decoration: none; }
.sheet-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid var(--navy); padding-bottom: 6px; }
.sheet-title { font-size: 30px; line-height: 1; margin-top: 2px; }
.sheet-brand { text-align: right; }
.sheet-logo { font-size: 22px; line-height: 1; color: var(--navy); }
.sheet-counts { font-size: 8.5px; color: var(--chalk-3); margin-top: 3px; }
.sheet-sec { display: flex; align-items: baseline; gap: 6px; border-bottom: 1px solid var(--line); padding-bottom: 2px; margin-bottom: 4px; }
.sheet-sec-n { font-size: 8px; color: var(--chalk-3); }
.sheet-sec-t { font-size: 14px; color: var(--navy); }
.sheet-sec-note { font-size: 8px; color: var(--chalk-3); margin-left: auto; text-transform: uppercase; letter-spacing: 0.04em; }
.sheet-table { width: 100%; border-collapse: collapse; }
.sheet-table th { text-align: left; font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--chalk-3); font-weight: 600; padding: 1px 4px 2px 0; }
.sheet-table td { padding: 2.5px 4px 2.5px 0; border-top: 1px solid var(--ink-2); vertical-align: top; }
.sheet-table tr:first-child td { border-top: 0; }
.sheet-score { font-weight: 600; font-size: 11px; color: var(--navy); }
.sheet-game { font-weight: 600; font-size: 10px; white-space: nowrap; }
.sheet-status { margin-left: 4px; font-size: 7.5px; text-transform: uppercase; font-weight: 700; }
.sheet-why { color: var(--chalk-2); }
.sheet-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sheet-list { list-style: none; margin: 0; padding: 0; }
.sheet-list li { display: flex; gap: 6px; padding: 2.5px 0; border-top: 1px solid var(--ink-2); }
.sheet-list li:first-child { border-top: 0; }
.sheet-gap { min-width: 24px; font-weight: 600; font-size: 11px; color: var(--turf); }
.sheet-sub { color: var(--chalk-3); }
.sheet-strength { min-width: 46px; font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; color: var(--chalk-3); padding-top: 1px; }
.sheet-strong { color: var(--navy); }
.sheet-good { color: var(--turf); font-weight: 700; }
.sheet-showdown { margin-top: 4px; padding-top: 3px; border-top: 1px solid var(--ink-2); color: var(--chalk-2); }
.sheet-line { color: var(--sky); font-weight: 600; }
.sheet-sub-h { font-weight: 700; color: var(--navy); font-size: 10px; margin: 2px 0 1px; }
.sheet-elevated { color: var(--brick); }
.sheet-empty { color: var(--chalk-3); padding: 2px 0; }
.sheet-timeline { display: flex; flex-direction: column; gap: 3px; }
.sheet-slot { display: grid; grid-template-columns: 44px 1fr; gap: 6px; border-top: 1px solid var(--ink-2); padding-top: 3px; }
.sheet-slot:first-child { border-top: 0; padding-top: 0; }
.sheet-hour { font-weight: 600; color: var(--navy); }
.sheet-slot-games { display: flex; flex-direction: column; gap: 1px; }
.sheet-slot-game { display: flex; gap: 5px; white-space: nowrap; }
.sheet-slot-score { min-width: 16px; font-weight: 600; color: var(--chalk-2); }
.sheet-foot { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 4px; display: flex; flex-direction: column; gap: 2px; font-size: 7.5px; color: var(--chalk-3); }
.sheet-chromeless + *, body:has(.sheet-chromeless) .topbar, body:has(.sheet-chromeless) .tabbar, body:has(.sheet-chromeless) footer:not(.sheet-foot) { display: none !important; }
body:has(.sheet-chromeless) main { padding: 0 !important; max-width: none !important; }
body:has(.sheet-chromeless) .sheet-root { max-width: none; }
body:has(.sheet-chromeless) .sheet { border: 0; border-radius: 0; }
/* Phones: the letter-size tables become one line of numbers per row with the "why" on its own line under it. */
@media screen and (max-width: 639px) {
  .sheet-table thead { display: none; }
  .sheet-table tr { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; border-top: 1px solid var(--ink-2); padding: 4px 0; }
  .sheet-table tr:first-child { border-top: 0; }
  .sheet-table td { border-top: 0; padding: 0; }
  .sheet-table td.sheet-why { flex-basis: 100%; }
  .sheet-table td[data-label]::before { content: attr(data-label) " "; color: var(--chalk-3); }
  .sheet-hide-sm { display: none; }
}
@media print {
  @page { size: letter; margin: 0.3in; }
  .topbar, .tabbar, .sheet-actions, body > footer { display: none !important; }
  main { padding: 0 !important; max-width: none !important; }
  .sheet-root { max-width: none; }
  .sheet { border: 0; padding: 0; }
  .sheet section { page-break-inside: avoid; }
  .sheet a { color: inherit; }
}
`;
