import Link from "next/link";
import { gameDfs, type DefProp, type DfsPlay, type GameDfs } from "@/lib/dfs";
import { NOT_A_PICK } from "@/lib/digests";
import type { Game, Team } from "@/lib/types";
import { PropsButton } from "./PropsButton";

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const odds = (n?: number) => (n === undefined ? "" : n > 0 ? `+${n}` : String(n));

/**
 * DraftKings and props for one game: each side's best DraftKings plays by projected
 * points (salary, our DK average, matchup rank, next man up) and the defenders worth
 * a tackle or sack prop. Server component; DraftKings salaries are cached 20 minutes.
 */
export async function DfsPanel({ game }: { game: Game }) {
  let data: GameDfs;
  try {
    data = await gameDfs(game);
  } catch (err) {
    return <p className="mt-3 text-sm text-chalk-3">DraftKings lens unavailable: {(err as Error).message}</p>;
  }
  const sides: Team[] = [game.away, game.home];
  const hasProps = Boolean(game.odds?.props);
  const showdown = data.plays.some((p) => p.slate === "showdown");

  return (
    <div className="mt-3">
      {data.vacancies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.vacancies.map((v) => (
            <span key={`${v.team}-${v.name}`} className="chip chip-wrap text-xs">
              <span className="font-semibold text-brick">{v.status}</span>
              <span className="text-chalk">{v.name}</span>
              <span className="mono text-chalk-3">
                {v.pos} · {v.avg} DK pts a game
              </span>
            </span>
          ))}
        </div>
      )}
      {data.note && <p className="mt-2 text-sm text-chalk-3">{data.note}</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {sides.map((t) => {
          const plays = data.plays.filter((p) => p.team === t.short).slice(0, 6);
          const tackles = data.defense.filter((d) => d.team === t.short && d.kind === "tackles").slice(0, 2);
          const rush = data.defense.filter((d) => d.team === t.short && d.kind === "pass rush").slice(0, 2);
          return (
            <div key={t.short} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <p className="display text-2xl font-bold text-chalk">{t.short}</p>
                <p className="mono text-xs text-chalk-3">{t === game.away ? `at ${game.home.abbr}` : `vs ${game.away.abbr}`}</p>
              </div>
              <p className="eyebrow mt-3">DraftKings</p>
              {plays.length === 0 ? (
                <p className="mt-1 text-sm text-chalk-3">No salaried skill player with a 2026 line.</p>
              ) : (
                <ul className="mt-1 divide-y divide-line">
                  {plays.map((p) => (
                    <PlayRow key={p.name} p={p} />
                  ))}
                </ul>
              )}
              <p className="eyebrow mt-4">Defensive props</p>
              {tackles.length + rush.length === 0 ? (
                <p className="mt-1 text-sm text-chalk-3">No defender clears 5 tackles or 1 QB hit a game on at least half the snaps.</p>
              ) : (
                <ul className="mt-1 divide-y divide-line">
                  {[...tackles, ...rush].map((d) => (
                    <DefRow key={`${d.kind}-${d.id}`} d={d} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {game.status === "upcoming" && game.odds?.eventId && <PropsButton id={game.id} hasProps={hasProps} />}
        {!hasProps && <span className="text-xs text-chalk-3">Posted prop lines show next to each name once props are pulled for this game.</span>}
      </div>

      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-chalk-3">
        {data.source ? `${data.source}. ` : ""}
        DK pts are scored from the nflverse game lines with DraftKings Classic rules (two-point conversions are not in the file).
        Proj is our average blended with last season (worth 3 games), times a quarter of the matchup factor (DK points the opponent allows to the position against the league; backtests showed more weight hurt), plus half of a new Out or Doubtful teammate&apos;s average for the next man up.
        {showdown ? " Showdown salaries run higher than Classic, so value here reads lower than on a Classic slate." : ""} Value is projected points per $1,000. {NOT_A_PICK}
      </p>
    </div>
  );
}

function PlayRow({ p }: { p: DfsPlay }) {
  const strong = p.slate === "classic" && p.value >= 4;
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="mono w-7 text-xs text-chalk-3">{p.pos}</span>
        {p.id ? (
          <Link href={`/player/${p.id}`} className="display text-lg font-semibold text-chalk hover:text-sky">
            {p.name}
          </Link>
        ) : (
          <span className="display text-lg font-semibold text-chalk">{p.name}</span>
        )}
        {p.status && <span className="mono text-xs font-semibold text-warn">{p.status}</span>}
        <span className="mono ml-auto text-sm text-chalk-2">{money(p.salary)}</span>
      </div>
      <div className="mono mt-0.5 flex flex-wrap gap-x-3 pl-9 text-xs text-chalk-3">
        <span>
          proj <span className="font-semibold text-chalk">{p.proj}</span>
        </span>
        <span>
          value <span className={`font-semibold ${strong ? "text-turf" : "text-chalk"}`}>{p.value}x</span>
        </span>
        {p.avg !== undefined && <span>avg {p.avg}</span>}
        {p.high !== undefined && <span>high {p.high}</span>}
        {p.oppRank !== undefined && (
          <span title="Rank of the DK points this defense allows to the position; 1 is the softest matchup">
            {p.pos} matchup <span className={p.oppRank <= 8 ? "font-semibold text-turf" : p.oppRank >= 25 ? "font-semibold text-brick" : ""}>{p.oppRank} of 32</span>
          </span>
        )}
        {p.prop?.point !== undefined && (
          <span className="text-sky">
            {p.prop.market.replace("player_", "").replace(/_/g, " ")} {p.prop.point}
            {p.prop.over !== undefined ? ` (o ${odds(p.prop.over)})` : ""}
          </span>
        )}
      </div>
      <p className="mt-0.5 pl-9 text-sm leading-snug text-chalk-2">{p.why}</p>
    </li>
  );
}

function DefRow({ d }: { d: DefProp }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="mono w-7 text-xs text-chalk-3">{d.pos}</span>
        <Link href={`/player/${d.id}`} className="display text-lg font-semibold text-chalk hover:text-sky">
          {d.name}
        </Link>
        <span className="mono text-xs uppercase tracking-wide text-chalk-3">{d.kind}</span>
        {d.line?.point !== undefined && (
          <span className="mono ml-auto text-sm text-sky">
            {d.kind === "tackles" ? "tkl+ast" : "sacks"} {d.line.point}
            {d.line.over !== undefined ? ` (o ${odds(d.line.over)})` : ""}
          </span>
        )}
      </div>
      <p className="mt-0.5 pl-9 text-sm leading-snug text-chalk-2">{d.why}</p>
    </li>
  );
}
