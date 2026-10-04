import type { GameOdds, PropRow } from "@/lib/odds";
import type { Prospect } from "@/lib/types";
import { asOf, mlText } from "@/lib/format";
import { PropsButton } from "./PropsButton";

const LABELS: Record<string, string> = {
  player_pass_yds: "pass yds",
  player_rush_yds: "rush yds",
  player_reception_yds: "rec yds",
  player_anytime_td: "anytime TD",
  player_tackles_assists: "tackles + ast",
  player_sacks: "sacks",
};

const BOOK: Record<string, string> = { draftkings: "DK", fanduel: "FD", betmgm: "MGM", caesars: "CZR", williamhill_us: "CZR", betrivers: "BR", espnbet: "ESPN", fanatics: "FAN", hardrockbet: "HR", bovada: "BOV", betonlineag: "BOL", pointsbetus: "PB", ballybet: "BALLY", fliff: "FLIFF" };
const bookShort = (k: string) => BOOK[k] ?? k.replace(/[^a-z]/g, "").slice(0, 4).toUpperCase();

/** "Jaxson Dart Jr." and "J. Dart" both reduce to something comparable. */
function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function initialKey(s: string): string {
  const t = nameKey(s).split(" ");
  return t.length >= 2 ? `${t[0][0]} ${t[t.length - 1]}` : t[0] ?? "";
}

interface Line {
  market: string;
  player: string;
  point?: number;
  books: number;
  at: string; // "DK" or "3 books"
  over?: number;
  under?: number;
  yes?: number;
}

/** Group rows by market and player; median point across books. */
function summarizeRows(rows: PropRow[]): Line[] {
  const groups = new Map<string, PropRow[]>();
  for (const r of rows) {
    const k = `${r.market}|${nameKey(r.player)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Line[] = [];
  for (const g of groups.values()) {
    const pts = g.map((r) => r.point).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
    const mid = Math.floor(pts.length / 2);
    const point = pts.length ? (pts.length % 2 ? pts[mid] : (pts[mid - 1] + pts[mid]) / 2) : undefined;
    const one = g.length === 1 ? g[0] : undefined;
    out.push({
      market: g[0].market,
      player: g[0].player,
      point,
      books: g.length,
      at: one ? bookShort(one.book) : `${g.length} books`,
      over: one?.overPrice,
      under: one?.underPrice,
      yes: one?.yesPrice ?? (g.length > 1 ? undefined : undefined),
    });
  }
  return out;
}

/**
 * Player props for this game beside the radar: each radar player's posted
 * lines ("Market: 245.5 pass yds at DK"), then every other listed player in
 * a collapsed list. Shows a fetch button when nothing is stored yet.
 */
export function PropsForRadar({ gameId, odds, prospects, upcoming }: { gameId: string; odds?: GameOdds; prospects: Prospect[]; upcoming: boolean }) {
  if (!odds) return null;
  if (odds.keyMissing) {
    return <p className="mt-4 text-xs text-chalk-3">Player props: add <span className="mono">ODDS_API_KEY</span> to <span className="mono">.env.local</span> to pull posted lines for the radar players.</p>;
  }
  const rows = odds.props?.rows ?? [];
  const lines = summarizeRows(rows);
  const byKey = new Map<string, Line[]>();
  for (const l of lines) {
    for (const k of [nameKey(l.player), initialKey(l.player)]) byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  const matched = new Set<Line>();
  const radar = prospects
    .map((p) => {
      const ls = byKey.get(nameKey(p.name)) ?? byKey.get(initialKey(p.name)) ?? [];
      ls.forEach((l) => matched.add(l));
      return { p, lines: ls };
    })
    .filter((x) => x.lines.length);
  const others = lines.filter((l) => !matched.has(l));
  const fmtLine = (l: Line) => {
    if (l.market === "player_anytime_td") return `anytime TD ${l.yes !== undefined ? mlText(l.yes) : ""} at ${l.at}`.replace(/\s+/g, " ");
    const price = l.over !== undefined && l.under !== undefined ? ` (o${mlText(l.over)} / u${mlText(l.under)})` : "";
    return `${l.point !== undefined ? l.point : "–"} ${LABELS[l.market] ?? l.market}${price} at ${l.at}`;
  };

  return (
    <div className="card mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Market props for the radar</p>
          <p className="mt-0.5 text-xs text-chalk-3">
            {odds.props ? `Pulled ${asOf(odds.props.at)} from US books. ${rows.length} prop lines, ${lines.length} player markets.` : "Nothing pulled yet. Props are fetched only when you ask, one game at a time."}
            {!odds.eventId && " This game is not matched to an Odds API event yet; take a slate snapshot first."}
          </p>
        </div>
        {upcoming && odds.eventId && <PropsButton id={gameId} hasProps={Boolean(odds.props)} />}
      </div>
      {radar.length > 0 && (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {radar.map(({ p, lines: ls }) => (
            <li key={p.id} className="rounded border border-line bg-panel-2 px-3 py-2 text-sm">
              <span className="display text-lg font-bold text-chalk">{p.name}</span> <span className="mono text-xs text-chalk-3">{p.pos} · {p.team}</span>
              <ul className="mono mt-0.5 text-xs text-chalk-2">
                {ls.map((l) => (
                  <li key={l.market}>Market: {fmtLine(l)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {odds.props && radar.length === 0 && <p className="mt-2 text-sm text-chalk-3">No radar player has a posted prop in this pull.</p>}
      {others.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-sky">{others.length} other listed player markets</summary>
          <ul className="mono mt-1 grid gap-0.5 text-xs text-chalk-2 sm:grid-cols-2">
            {others.map((l) => (
              <li key={`${l.market}|${l.player}`}>{l.player}: {fmtLine(l)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
