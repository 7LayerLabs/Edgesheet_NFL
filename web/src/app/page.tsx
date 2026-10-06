import Link from "next/link";
import { getSlate, shiftDate, type Slate as SlateData } from "@/lib/slate";
import { scoutScore, scoreTag } from "@/lib/score";
import { Slate } from "@/components/Slate";
import { cardGame } from "@/lib/card";
import { LiveTicker } from "@/components/LiveTicker";
import type { Game } from "@/lib/types";
import { SendToTelegram } from "@/components/SendToTelegram";
import { telegramReady } from "@/lib/telegram";
import { impliedTotals } from "@/lib/implied";
import { slateDfs, type DfsPlay } from "@/lib/dfs";
import { evaluateWeather } from "@/lib/weather";
import { genSchedule } from "@/lib/generated";
import { kickoffTime } from "@/lib/format";
import { CleanSheet } from "@/components/CleanSheet";

export const dynamic = "force-dynamic";

function fmtDate(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00-04:00`).toLocaleDateString("en-US", { timeZone: "America/New_York", ...opts });
}

export default async function Today({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const dateParam = typeof sp.date === "string" ? sp.date : undefined;
  const slate = await getSlate(dateParam);
  const { games } = slate;
  const view = sp.view === "full" ? "full" : "clean";

  // The clean sheet (default): every game of the week, a short summary under each, click for the full breakdown.
  if (view === "clean") {
    const week = slate.weekGames.length ? slate.weekGames : games;
    const liveNow = week.filter((g) => g.status === "live").length;
    const left = week.filter((g) => g.status === "upcoming").length;
    return (
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">
              {slate.season}{slate.week ? ` · Week ${slate.week.week}` : ""} · the clean sheet
              {slate.source === "live" && <span className="ml-2 text-turf">● live data</span>}
            </p>
            <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">{slate.week ? `Week ${slate.week.week}` : "This week"}</h1>
            <p className="mt-1 max-w-2xl text-sm text-chalk-3">Every game, the line, the model, and what matters. Click a game for everything else.</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ViewToggle view={view} date={dateParam} />
            <div className="mono text-right text-xs text-chalk-3">
              {week.length} games · {liveNow ? `${liveNow} in progress` : left ? `${left} still to kick off` : "all final"}
            </div>
          </div>
        </div>
        <WeekStrip slate={slate} />
        <LiveTicker games={week} />
        <div className="mt-6">
          <CleanSheet games={week} />
        </div>
      </div>
    );
  }

  const live = games.filter((g) => g.status === "live").length;
  const upcoming = games.filter((g) => g.status === "upcoming").length;
  const sorted = [...games].sort((a, b) => scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents));
  const top = sorted[0];
  const gem = sorted.find((g) => scoreTag(g) === "Hidden Gem" && g !== top);

  // Slate at a glance: implied team totals, DraftKings value leaders, weather watch; cards banded by game total.
  const implied: Record<string, { home: number; away: number }> = {};
  for (const g of games) {
    const it = impliedTotals(g.home.abbr, g.market.spread, g.market.total?.line);
    if (it) implied[g.id] = it;
  }
  const upcomingGames = games.filter((g) => g.status === "upcoming");
  const dk = slate.source === "live" && upcomingGames.length ? await slateDfs(slate.date, upcomingGames).catch(() => undefined) : undefined;
  const showdownIds = new Set(dk?.showdown.flatMap((s) => s.plays.map((p) => p.gameId)) ?? []);
  const classicOn = Boolean(dk?.plays.some((p) => p.slate === "classic"));
  const dkSlate: Record<string, "main" | "showdown"> = classicOn ? Object.fromEntries(upcomingGames.map((g) => [g.id, showdownIds.has(g.id) ? "showdown" : "main"])) : {};
  const bands = totalBands(games, slate.season);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">
            {slate.week ? `${slate.season} · Week ${slate.week.week}` : "Sample slate"}
            {slate.source === "live" && <span className="ml-2 text-turf">● live data</span>}
          </p>
          <h1 className="display mt-1 text-5xl font-extrabold text-chalk sm:text-6xl">
            {fmtDate(slate.date, { weekday: "long", month: "long", day: "numeric" })}
          </h1>
        </div>
        <div className="mono text-right text-xs text-chalk-3">
          <div className="mb-2 flex justify-end"><ViewToggle view={view} date={dateParam} /></div>
          <div>{games.length} games on the slate</div>
          <div>{live ? `${live} in progress` : upcoming ? `${upcoming} still to kick off` : "all final"}</div>
          <div className="mt-1"><Link href="/ask" className="text-sky hover:underline">Ask the slate</Link></div>
          {slate.source === "live" && (
            <div className="mt-1.5 flex justify-end gap-1.5">
              <SendToTelegram type="slate" date={slate.date} enabled={telegramReady()} />
              <SendToTelegram type="leans" date={slate.date} enabled={telegramReady()} />
            </div>
          )}
        </div>
      </div>

      <DayStrip slate={slate} />

      <LiveTicker games={games} />

      {/* The best two games, wide screens only: on a phone the first cards below are the same games, one screen sooner. */}
      {games.length > 0 && (
        <div className="mt-5 hidden gap-2.5 sm:grid sm:grid-cols-2">
          <Callout label="Highest Watch Score" game={top} tone="flag" />
          {gem ? <Callout label="Hidden Gem" game={gem} tone="turf" /> : <Callout label="Next best" game={sorted[1] ?? top} tone="flag" />}
        </div>
      )}

      {slate.notes.length > 0 && (
        <details className="mt-4 text-xs text-chalk-3">
          <summary className="cursor-pointer select-none hover:text-chalk-2">What this slate cannot say yet</summary>
          <ul className="mt-1.5 grid gap-1 pl-4">
            {slate.notes.map((n) => (
              <li key={n} className="list-disc">{n}</li>
            ))}
          </ul>
        </details>
      )}

      {slate.source === "live" && <SlateGlance games={games} implied={implied} values={dk?.plays.filter((p) => p.slate === "classic").slice(0, 6) ?? []} />}

      <div className="mt-6">
        <Slate games={games.map(cardGame)} bands={bands} dkSlate={dkSlate} implied={implied} />
      </div>
    </div>
  );
}

/**
 * High and low game totals for the cards: this season's posted totals, top and bottom quarter. A high total is where the
 * points (and the DraftKings scoring) are expected.
 */
function totalBands(games: Game[], season: number): Record<string, "high" | "low"> {
  const totals = genSchedule()
    .filter((g) => g.season === season && g.totalLine !== null)
    .map((g) => g.totalLine!)
    .sort((a, b) => a - b);
  if (totals.length < 16) return {};
  const lo = totals[Math.floor(totals.length * 0.25)];
  const hi = totals[Math.floor(totals.length * 0.75)];
  const out: Record<string, "high" | "low"> = {};
  for (const g of games) {
    const t = g.market.total?.line;
    if (t === undefined) continue;
    if (t >= hi) out[g.id] = "high";
    else if (t <= lo) out[g.id] = "low";
  }
  return out;
}

/** Highest implied team totals, DraftKings value leaders, and the weather watch: one glance before the cards. */
function SlateGlance({ games, implied, values }: { games: Game[]; implied: Record<string, { home: number; away: number }>; values: DfsPlay[] }) {
  const teams = games
    .filter((g) => g.status === "upcoming" && implied[g.id])
    .flatMap((g) => [
      { abbr: g.home.abbr, opp: g.away.abbr, at: false, pts: implied[g.id].home, g },
      { abbr: g.away.abbr, opp: g.home.abbr, at: true, pts: implied[g.id].away, g },
    ])
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 6);
  const rank = { elevated: 0, flag: 1, note: 2 } as const;
  const weather = games
    .filter((g) => g.status !== "final" && g.weather)
    .map((g) => ({ g, f: evaluateWeather(g.weather!).filter((x) => x.level !== "note").sort((a, b) => rank[a.level] - rank[b.level])[0] }))
    .filter((x) => x.f)
    .sort((a, b) => rank[a.f!.level] - rank[b.f!.level])
    .slice(0, 4);
  if (!teams.length && !values.length && !weather.length) return null;
  return (
    <section aria-label="Slate at a glance" className="scroll-x -mx-4 mt-5 flex gap-2.5 px-4 pb-1 md:mx-0 md:grid md:grid-cols-3 md:px-0">
      {teams.length > 0 && (
        <div className="card w-72 shrink-0 p-3 md:w-auto">
          <p className="text-sm font-semibold text-chalk">Highest team totals</p>
          <ul className="mt-1 grid gap-0.5">
            {teams.map((t) => (
              <li key={`${t.g.id}-${t.abbr}`} className="flex items-baseline justify-between gap-2 text-sm">
                <Link href={`/game/${t.g.id}`} className="text-chalk hover:text-sky">
                  <span className="font-semibold">{t.abbr}</span> <span className="text-xs text-chalk-3">{t.at ? "@" : "v"} {t.opp}</span>
                </Link>
                <span className="mono text-chalk">{t.pts.toFixed(1)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-chalk-3">Points implied by the spread and total.</p>
        </div>
      )}
      {values.length > 0 && (
        <div className="card w-72 shrink-0 p-3 md:w-auto">
          <p className="text-sm font-semibold text-chalk">DraftKings value leaders</p>
          <ul className="mt-1 grid gap-0.5">
            {values.map((p) => (
              <li key={`${p.team}-${p.name}`} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-chalk">
                  <span className="mono mr-1 text-[11px] text-chalk-3">{p.pos}</span>
                  {p.name}
                </span>
                <span className="mono shrink-0 text-xs text-chalk-2">
                  ${(p.salary / 1000).toFixed(1)}k · <span className="font-semibold text-chalk">{p.value}x</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-chalk-3">
            Projected points per $1,000. <Link href="/dfs" className="text-sky hover:underline">Our price and value picks</Link>
          </p>
        </div>
      )}
      {weather.length > 0 && (
        <div className="card w-72 shrink-0 p-3 md:w-auto">
          <p className="text-sm font-semibold text-chalk">Weather watch</p>
          <ul className="mt-1 grid gap-1">
            {weather.map(({ g, f }) => (
              <li key={g.id} className="text-sm leading-snug">
                <Link href={`/game/${g.id}#conditions`} className="font-semibold text-chalk hover:text-sky">
                  {g.away.abbr} @ {g.home.abbr}
                </Link>
                <span className="mono ml-1 text-[11px] text-chalk-3">{kickoffTime(g.kickoff)}</span>
                <span className={`block text-xs ${f!.level === "elevated" ? "text-brick" : "text-chalk-2"}`}>{f!.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ViewToggle({ view, date }: { view: "clean" | "full"; date?: string }) {
  const q = (v: string) => {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (v === "full") p.set("view", "full");
    const t = p.toString();
    return `/${t ? `?${t}` : ""}`;
  };
  return (
    <span className="seg">
      <Link href={q("clean")} aria-current={view === "clean"}>Clean sheet</Link>
      <Link href={q("full")} aria-current={view === "full"}>Full slate</Link>
    </span>
  );
}

/** Previous and next week on the clean sheet. */
function WeekStrip({ slate }: { slate: SlateData }) {
  if (slate.source !== "live") return null;
  return (
    <div className="mt-4 flex items-center gap-1.5">
      <Link href={`/?date=${shiftDate(slate.date, -7)}`} className="chip !py-1 !text-[11px]">← Previous week</Link>
      <Link href={`/?date=${shiftDate(slate.date, 7)}`} className="chip !py-1 !text-[11px]">Next week →</Link>
    </div>
  );
}

function DayStrip({ slate }: { slate: SlateData }) {
  if (slate.source !== "live") return null;
  const prev = shiftDate(slate.date, -7);
  const next = shiftDate(slate.date, 7);
  return (
    <div className="scroll-x -mx-4 mt-4 flex items-center gap-1.5 px-4 pb-1">
      <Link href={`/?date=${prev}&view=full`} className="chip !py-1 !text-[11px]" title="Previous week">
        ← wk
      </Link>
      {slate.days.map((d) => (
        <Link key={d.date} href={`/?date=${d.date}&view=full`} className="chip" aria-pressed={d.date === slate.date}>
          {fmtDate(d.date, { weekday: "short" })} {fmtDate(d.date, { day: "numeric" })}
          <span className="ml-1.5 mono text-[10px] opacity-70">{d.count}</span>
        </Link>
      ))}
      <Link href={`/?date=${next}&view=full`} className="chip !py-1 !text-[11px]" title="Next week">
        wk →
      </Link>
    </div>
  );
}

function Callout({ label, game, tone }: { label: string; game: Game; tone: "flag" | "turf" }) {
  const s = scoutScore(game.scoreComponents);
  return (
    <Link href={`/game/${game.id}`} className="card flex items-center gap-4 p-4 hover:bg-panel-2">
      <span className={`display text-5xl font-extrabold ${tone === "flag" ? "text-flag" : "text-turf"}`}>{s}</span>
      <span className="min-w-0">
        <span className={`eyebrow ${tone === "turf" ? "text-turf" : ""}`}>{label}</span>
        <span className="display mt-0.5 block truncate text-2xl font-semibold text-chalk">
          {game.away.short} @ {game.home.short}
        </span>
        <span className="line-clamp-1 text-xs text-chalk-3">{game.whyWatch}</span>
      </span>
    </Link>
  );
}
