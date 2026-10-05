/**
 * NFL schedule, teams, standings, venues, Elo, and ESPN FPI. Replaces the
 * CollegeFootballData client: everything here reads the nflverse digests that
 * scripts/ingest.mjs writes (schedule.json, elo.json) plus the static team table
 * in data/nfl-teams.json. The only network calls are ESPN (FPI, broadcasts),
 * both optional and cached.
 */
import { smallLogo } from "./images";
import { readFileSync } from "node:fs";
import path from "node:path";
import { memo, memoSync } from "./memo";
import { genElo, genSchedule, scheduleStamp, type GenGame } from "./generated";

/* ------------------------------------------------------------- teams */

export interface Venue {
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  /** nflverse roof values: outdoors, dome, retractable (closed/open on game day comes from the schedule row). */
  roof: string;
  surface: string;
  elevationFt: number;
  tz: string;
  /** True when the National Weather Service covers the venue (US only). */
  nws: boolean;
}

export interface NflTeam {
  code: string; // nflverse code (LA, WAS)
  abbr: string; // ESPN abbreviation (LAR, WSH), shown on cards
  espnId: string;
  name: string;
  short: string; // nickname, the join key
  location: string;
  conf: string;
  div: string;
  color: string;
  subreddit: string;
  stadium: Omit<Venue, "nws">;
}

interface TeamFile {
  teams: NflTeam[];
  neutralVenues: (Omit<Venue, "nws"> & { match: string })[];
}

const teamFile = (): TeamFile => memoSync("nfl:teamfile", 86400, () => JSON.parse(readFileSync(path.join(process.cwd(), "data", "nfl-teams.json"), "utf8")) as TeamFile);

export const nflTeams = (): NflTeam[] => teamFile().teams;
const byShort = () => memoSync("nfl:byShort", 86400, () => new Map(nflTeams().map((t) => [t.short, t])));
const byCode = () => memoSync("nfl:byCode", 86400, () => new Map(nflTeams().map((t) => [t.code, t])));
export const teamByShort = (short: string): NflTeam | undefined => byShort().get(short);
export const teamByCode = (code: string): NflTeam | undefined => byCode().get(code);
export const logoUrl = smallLogo;
export const headshotUrl = (espnId: string | number) => `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`;
export const DIVISIONS = ["East", "North", "South", "West"] as const;
export const CONFERENCES = ["AFC", "NFC"] as const;

/* ---------------------------------------------------------- schedule */

export const scheduleLoaded = () => genSchedule().length > 0;

export interface NflWeek {
  season: number;
  week: number;
  seasonType: "regular" | "postseason";
  /** Window start, Tuesday 00:00 ET two days before the first kickoff; windows are contiguous. */
  startDate: string;
  endDate: string;
  firstGameStart: string;
  lastGameStart: string;
  label: string; // "Week 5", "Wild Card"
}

const ROUND_LABEL: Record<string, string> = { WC: "Wild Card", DIV: "Divisional", CON: "Conference championships", SB: "Super Bowl" };
const ET = "America/New_York";
export const etDateOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Midnight ET of a YYYY-MM-DD, shifted by days, as ISO. */
function etMidnight(date: string, shiftDays = 0): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  const ymd = d.toISOString().slice(0, 10);
  // Find the UTC instant of 00:00 ET on that day by probing both offsets.
  for (const off of ["-04:00", "-05:00"]) {
    const t = new Date(`${ymd}T00:00:00${off}`);
    if (etDateOf(t.toISOString()) === ymd && new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", hour12: false }).format(t).startsWith("0")) return t.toISOString();
  }
  return new Date(`${ymd}T04:00:00Z`).toISOString();
}

export function calendar(season: number): NflWeek[] {
  return memoSync(`nfl:cal:${season}:${scheduleStamp()}`, 3600, () => {
    const games = genSchedule().filter((g) => g.season === season);
    const byKey = new Map<string, GenGame[]>();
    for (const g of games) {
      const k = `${g.type}:${g.week}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(g);
    }
    const weeks: NflWeek[] = [...byKey.values()]
      .map((gs) => {
        const sorted = [...gs].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        return {
          season,
          week: first.week,
          seasonType: first.type === "REG" ? ("regular" as const) : ("postseason" as const),
          startDate: etMidnight(etDateOf(first.kickoff), -2),
          endDate: "",
          firstGameStart: first.kickoff,
          lastGameStart: last.kickoff,
          label: first.type === "REG" ? `Week ${first.week}` : ROUND_LABEL[first.round] ?? `Week ${first.week}`,
        };
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    // Never start before the day after the previous week's last game: a Wednesday opener (Christmas, Thanksgiving
    // eve) would otherwise swallow the Monday night game two days earlier.
    for (let i = 1; i < weeks.length; i++) {
      const after = etMidnight(etDateOf(weeks[i - 1].lastGameStart), 1);
      if (after > weeks[i].startDate) weeks[i].startDate = after;
    }
    for (let i = 0; i < weeks.length; i++) {
      weeks[i].endDate = i + 1 < weeks.length ? weeks[i + 1].startDate : etMidnight(etDateOf(weeks[i].lastGameStart), 2);
    }
    return weeks;
  });
}

export function gamesForWeek(season: number, week: number, seasonType: "regular" | "postseason"): GenGame[] {
  const type = seasonType === "regular" ? "REG" : "POST";
  return genSchedule().filter((g) => g.season === season && g.week === week && g.type === type);
}

export function gameById(id: string): GenGame | undefined {
  return memoSync(`nfl:byId:${scheduleStamp()}`, 3600, () => new Map(genSchedule().map((g) => [g.id, g]))).get(id);
}

export function gamesForTeam(season: number, short: string): GenGame[] {
  return genSchedule().filter((g) => g.season === season && (g.home === short || g.away === short)).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

/* ---------------------------------------------------------- standings */

export interface Standing {
  team: NflTeam;
  w: number;
  l: number;
  t: number;
  pct: number;
  pf: number;
  pa: number;
  divW: number;
  divL: number;
  divT: number;
  confW: number;
  confL: number;
  confT: number;
  streak: string; // "W3", "L1"
  games: number;
  /** 1..4 inside the division by pct, then division record, then point differential. */
  divRank: number;
  /** Seed inside the conference under the same simple ordering (division winners first). */
  seed: number;
  record: string;
}

/** Finals ESPN has posted that the ingested schedule may not have yet, by game id. */
export type Finals = Record<string, { home: number; away: number }>;

/** `finals` folds in games that went final after the last ingest, so a record never lags the score beside it. */
export function standings(season: number, finals: Finals = {}): Standing[] {
  return memoSync(`nfl:standings:${season}:${scheduleStamp()}:${Object.keys(finals).sort().join(",")}`, 300, () => {
    const rows = new Map<string, Standing>();
    for (const t of nflTeams()) rows.set(t.short, { team: t, w: 0, l: 0, t: 0, pct: 0, pf: 0, pa: 0, divW: 0, divL: 0, divT: 0, confW: 0, confL: 0, confT: 0, streak: "", games: 0, divRank: 0, seed: 0, record: "0-0" });
    const last = new Map<string, ("W" | "L" | "T")[]>();
    const games = genSchedule()
      .filter((g) => g.season === season && g.type === "REG" && (g.played || finals[g.id]))
      .map((g) => (g.played ? g : { ...g, hs: finals[g.id].home, as: finals[g.id].away }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    for (const g of games) {
      const h = rows.get(g.home);
      const a = rows.get(g.away);
      if (!h || !a || g.hs == null || g.as == null) continue;
      const sameConf = h.team.conf === a.team.conf;
      const res = g.hs > g.as ? "H" : g.hs < g.as ? "A" : "T";
      for (const [row, won, lost, pf, pa] of [
        [h, res === "H", res === "A", g.hs, g.as],
        [a, res === "A", res === "H", g.as, g.hs],
      ] as const) {
        row.games++;
        row.pf += pf;
        row.pa += pa;
        const r: "W" | "L" | "T" = won ? "W" : lost ? "L" : "T";
        if (r === "W") row.w++;
        else if (r === "L") row.l++;
        else row.t++;
        if (g.divGame) {
          if (r === "W") row.divW++;
          else if (r === "L") row.divL++;
          else row.divT++;
        }
        if (sameConf) {
          if (r === "W") row.confW++;
          else if (r === "L") row.confL++;
          else row.confT++;
        }
        (last.get(row.team.short) ?? last.set(row.team.short, []).get(row.team.short)!).push(r);
      }
    }
    for (const row of rows.values()) {
      row.pct = row.games ? (row.w + row.t / 2) / row.games : 0;
      row.record = `${row.w}-${row.l}${row.t ? `-${row.t}` : ""}`;
      const seq = last.get(row.team.short) ?? [];
      let n = 0;
      for (let i = seq.length - 1; i >= 0 && seq[i] === seq[seq.length - 1]; i--) n++;
      row.streak = seq.length ? `${seq[seq.length - 1]}${n}` : "";
    }
    const divPct = (r: Standing) => (r.divW + r.divL + r.divT ? (r.divW + r.divT / 2) / (r.divW + r.divL + r.divT) : 0);
    const order = (x: Standing, y: Standing) => y.pct - x.pct || divPct(y) - divPct(x) || (y.pf - y.pa) - (x.pf - x.pa) || x.team.short.localeCompare(y.team.short);
    const all = [...rows.values()];
    for (const conf of CONFERENCES) {
      const winners: Standing[] = [];
      for (const div of DIVISIONS) {
        const d = all.filter((r) => r.team.conf === conf && r.team.div === div).sort(order);
        d.forEach((r, i) => (r.divRank = i + 1));
        winners.push(d[0]);
      }
      const rest = all.filter((r) => r.team.conf === conf && r.divRank > 1).sort(order);
      [...winners.sort(order), ...rest].forEach((r, i) => (r.seed = i + 1));
    }
    return all.sort((x, y) => x.team.conf.localeCompare(y.team.conf) || x.team.div.localeCompare(y.team.div) || x.divRank - y.divRank);
  });
}

export const standingFor = (season: number, short: string, finals?: Finals): Standing | undefined => standings(season, finals).find((s) => s.team.short === short);

/* ------------------------------------------------------------- venue */

export function venueFor(g: GenGame): Venue | undefined {
  const f = teamFile();
  // A listed neutral venue wins whatever the flag says: nflverse tags some international games "Home".
  const nv = g.stadium ? f.neutralVenues.find((v) => g.stadium!.toLowerCase().includes(v.match.toLowerCase())) : undefined;
  if (nv) {
    const { match: _m, ...rest } = nv;
    void _m;
    return { ...rest, nws: false };
  }
  // Neutral but not on the list: the home team's stadium would put the forecast in the wrong city.
  if (g.neutral) return undefined;
  const home = teamByShort(g.home);
  if (!home) return undefined;
  const s = home.stadium;
  // The schedule row names the stadium; trust it when it matches the team's listed home, else keep the team's venue but use the row's roof and surface.
  return { ...s, name: g.stadium ?? s.name, roof: g.roof ?? s.roof, surface: g.surface ?? s.surface, nws: true };
}

/** Roof state for the forecast: nflverse roof values are outdoors, dome, closed, open (retractable games are tagged closed/open once known). */
export function roofState(roof: string | null | undefined): "open" | "fixed" | "retractable-unknown" | "retractable-closed" {
  if (roof === "dome") return "fixed";
  if (roof === "closed") return "retractable-closed";
  if (roof === "open" || roof === "outdoors") return "open";
  if (roof === "retractable") return "retractable-unknown";
  return "open";
}

/* --------------------------------------------------------------- elo */

export function eloPregame(id: string): { home: number; away: number } | undefined {
  return genElo()?.pregame[id];
}
export function eloCurrent(short: string): number | undefined {
  return genElo()?.teams[short];
}

/* ---------------------------------------------------------- ESPN FPI */

export interface FpiRow {
  fpi: number;
  rank: number;
  offEpa: number | null;
  defEpa: number | null;
  wins: number;
  losses: number;
  projectedW: number | null;
  playoffPct: number | null;
}

interface FpiPayload {
  teams?: { team: { abbreviation?: string; displayName?: string }; categories?: { name: string; values: (number | null)[] }[] }[];
  categories?: { name: string; names: string[] }[];
}

const FPI_URL = (season: number) => `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}`;

/** ESPN Football Power Index, keyed by team nickname. Undefined when ESPN does not answer. Memoized 6 hours. */
export function fpiRatings(season: number): Promise<Map<string, FpiRow> | undefined> {
  return memo(`nfl:fpi:${season}`, 6 * 3600, async () => {
    try {
      const res = await fetch(FPI_URL(season), { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return undefined;
      const data = (await res.json()) as FpiPayload;
      const names = Object.fromEntries((data.categories ?? []).map((c) => [c.name, c.names]));
      const out = new Map<string, FpiRow>();
      for (const row of data.teams ?? []) {
        const abbr = row.team.abbreviation ?? "";
        const team = nflTeams().find((t) => t.abbr === abbr || t.code === abbr) ?? nflTeams().find((t) => t.name === row.team.displayName);
        if (!team) continue;
        const cat = (name: string) => row.categories?.find((c) => c.name === name);
        const val = (catName: string, key: string): number | null => {
          const c = cat(catName);
          const i = names[catName]?.indexOf(key) ?? -1;
          const v = c && i >= 0 ? c.values[i] : null;
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        };
        const fpi = val("fpi", "fpi");
        if (fpi === null) continue;
        out.set(team.short, {
          fpi,
          rank: val("fpi", "fpirank") ?? 0,
          offEpa: val("fpi", "epaoffense"),
          defEpa: val("fpi", "epadefense"),
          wins: val("fpi", "numwins") ?? 0,
          losses: val("fpi", "numlosses") ?? 0,
          projectedW: val("projections", "projectedw"),
          playoffPct: val("projections", "probmakeplayoffs"),
        });
      }
      return out.size ? out : undefined;
    } catch {
      return undefined;
    }
  });
}

/* --------------------------------------------------- ESPN week scoreboard */

export interface EspnWeekRow {
  network: string;
  venue?: string;
  city?: string;
  indoor?: boolean;
  neutral?: boolean;
  final?: { home: number; away: number };
}

interface WeekScoreboard {
  events?: { id: string; competitions?: { status?: { type?: { completed?: boolean } }; competitors?: { homeAway?: string; score?: string }[]; neutralSite?: boolean; venue?: { fullName?: string; address?: { city?: string; state?: string }; indoor?: boolean }; broadcasts?: { market?: string; names?: string[] }[]; broadcast?: string }[] }[];
}

/** Broadcast network, venue, and posted finals for every game in an NFL week, from ESPN's scoreboard (nflverse carries no TV column). Memoized 10 minutes so finals land promptly; empty map when ESPN does not answer. */
export function espnWeek(season: number, week: number, seasonType: "regular" | "postseason"): Promise<Map<string, EspnWeekRow>> {
  const st = seasonType === "regular" ? 2 : 3;
  return memo(`nfl:espnweek:${season}:${st}:${week}`, 600, async () => {
    const out = new Map<string, EspnWeekRow>();
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=${st}&week=${week}&limit=100`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return out;
      const data = (await res.json()) as WeekScoreboard;
      for (const e of data.events ?? []) {
        const c = e.competitions?.[0];
        if (!c) continue;
        const names = c.broadcasts?.flatMap((b) => b.names ?? []) ?? [];
        const homeC = c.competitors?.find((x) => x.homeAway === "home");
        const awayC = c.competitors?.find((x) => x.homeAway === "away");
        const network = names[0] ?? c.broadcast ?? "";
        out.set(e.id, {
          network,
          venue: c.venue?.fullName,
          city: [c.venue?.address?.city, c.venue?.address?.state].filter(Boolean).join(", ") || undefined,
          indoor: c.venue?.indoor,
          neutral: c.neutralSite,
          final: c.status?.type?.completed && homeC?.score != null && awayC?.score != null ? { home: Number(homeC.score), away: Number(awayC.score) } : undefined,
        });
      }
    } catch {}
    return out;
  });
}

/** Networks that count as nationally available. Everything else is a regional CBS/FOX window. */
export const NATIONAL_WINDOWS = /^(NBC|ESPN|ABC|ESPN\/ABC|Prime Video|Netflix|NFL Network|NFL Net|NFLN|Peacock|YouTube|YouTube TV|ESPN2|Amazon)$/i;
