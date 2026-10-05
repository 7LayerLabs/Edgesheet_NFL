import Link from "next/link";
import { getSlate, shiftDate, type Slate as SlateData } from "@/lib/slate";
import { scoutScore, scoreTag } from "@/lib/score";
import { Slate } from "@/components/Slate";
import { cardGame } from "@/lib/card";
import { LiveTicker } from "@/components/LiveTicker";
import type { Game } from "@/lib/types";
import { SendToTelegram } from "@/components/SendToTelegram";
import { telegramReady } from "@/lib/telegram";

export const dynamic = "force-dynamic";

function fmtDate(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00-04:00`).toLocaleDateString("en-US", { timeZone: "America/New_York", ...opts });
}

export default async function Today({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const dateParam = typeof sp.date === "string" ? sp.date : undefined;
  const slate = await getSlate(dateParam);
  const { games } = slate;

  const live = games.filter((g) => g.status === "live").length;
  const upcoming = games.filter((g) => g.status === "upcoming").length;
  const sorted = [...games].sort((a, b) => scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents));
  const top = sorted[0];
  const gem = sorted.find((g) => scoreTag(g) === "Hidden Gem" && g !== top);

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

      <div className="mt-6">
        <Slate games={games.map(cardGame)} />
      </div>
    </div>
  );
}

function DayStrip({ slate }: { slate: SlateData }) {
  if (slate.source !== "live") return null;
  const prev = shiftDate(slate.date, -7);
  const next = shiftDate(slate.date, 7);
  return (
    <div className="scroll-x -mx-4 mt-4 flex items-center gap-1.5 px-4 pb-1">
      <Link href={`/?date=${prev}`} className="chip !py-1 !text-[11px]" title="Previous week">
        ← wk
      </Link>
      {slate.days.map((d) => (
        <Link key={d.date} href={`/?date=${d.date}`} className="chip" aria-pressed={d.date === slate.date}>
          {fmtDate(d.date, { weekday: "short" })} {fmtDate(d.date, { day: "numeric" })}
          <span className="ml-1.5 mono text-[10px] opacity-70">{d.count}</span>
        </Link>
      ))}
      <Link href={`/?date=${next}`} className="chip !py-1 !text-[11px]" title="Next week">
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
