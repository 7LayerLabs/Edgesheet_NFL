/**
 * The Odds API core: pure parsing, team matching, consensus, movement text,
 * and the snapshot files under data/odds/<season>/<gameId>.json.
 *
 * Plain JavaScript on purpose: src/lib/odds.ts (the app) and
 * scripts/odds-snapshot.mjs (the cron) both import this file, so the two
 * never drift apart. Types live in odds-core.d.mts.
 *
 * Request budget (free tier = 500 credits a month, cost = markets x regions):
 *   slate call   h2h,spreads,totals x us          = 3 credits
 *   props call   6 player markets x us (one event) = 6 credits (yards, anytime TD, tackles + assists, sacks)
 * Every call records x-requests-remaining to data/odds/usage.json so both the
 * page path and the cron can refuse to spend below a reserve.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SPORT = "americanfootball_nfl";
export const BASE = "https://api.the-odds-api.com/v4";
export const SLATE_MARKETS = "h2h,spreads,totals";
export const PROP_MARKETS = "player_pass_yds,player_rush_yds,player_reception_yds,player_anytime_td,player_tackles_assists,player_sacks";
export const REGIONS = "us";

export const PROP_LABELS = {
  player_pass_yds: "pass yds",
  player_rush_yds: "rush yds",
  player_reception_yds: "rec yds",
  player_anytime_td: "anytime TD",
  player_tackles_assists: "tackles + ast",
  player_sacks: "sacks",
};

export const BOOK_SHORT = {
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  caesars: "CZR",
  williamhill_us: "CZR",
  pointsbetus: "PB",
  betrivers: "BR",
  bovada: "BOV",
  betonlineag: "BOL",
  mybookieag: "MYB",
  lowvig: "LV",
  betus: "BUS",
  unibet_us: "UNI",
  wynnbet: "WYNN",
  superbook: "SB",
  twinspires: "TS",
  barstool: "BAR",
  espnbet: "ESPN",
  fanatics: "FAN",
  hardrockbet: "HR",
  ballybet: "BALLY",
  fliff: "FLIFF",
  novig: "NOVIG",
  prophetx: "PX",
  betparx: "PARX",
};

export const bookShort = (key, title) => BOOK_SHORT[key] ?? (title ? title.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase() : key.slice(0, 4).toUpperCase());

/* ------------------------------------------------------------ names */

/** Lowercase, strip accents and punctuation, "&" to "and", "St" to "state". */
export function normalizeName(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`.]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\bst\b/g, "state")
    .replace(/\bmt\b/g, "mount")
    .replace(/\s+/g, " ")
    .trim();
}

/** School spellings that differ between CollegeFootballData and the books. Both directions. */
const ALIAS_GROUPS = [
  ["umass", "massachusetts"],
  ["ole miss", "mississippi"],
  ["fiu", "florida international"],
  ["louisiana", "louisiana lafayette", "ul lafayette"],
  ["ul monroe", "louisiana monroe"],
  ["sam houston", "sam houston state"],
  ["app state", "appalachian state"],
  ["southern miss", "southern mississippi"],
  ["army", "army west point"],
  ["uconn", "connecticut"],
  ["lsu", "louisiana state"],
  ["pitt", "pittsburgh"],
  ["usc", "southern california"],
  ["smu", "southern methodist"],
  ["byu", "brigham young"],
  ["tcu", "texas christian"],
  ["nc state", "north carolina state"],
  ["cal", "california"],
  ["middle tennessee", "middle tennessee state"],
  ["nicholls", "nicholls state"],
  ["se louisiana", "southeastern louisiana"],
  ["utsa", "texas san antonio", "ut san antonio"],
  ["utep", "texas el paso"],
  ["ucf", "central florida"],
  ["unlv", "nevada las vegas"],
  ["hawaii", "hawaii rainbow"],
  ["san jose state", "san jose st"],
  ["mcneese", "mcneese state"],
  ["stephen f austin", "sfa"],
  ["central connecticut", "central connecticut state"],
  ["long island university", "liu"],
  ["st francis pa", "saint francis", "saint francis pa"],
  ["charleston southern", "charleston so"],
  ["eastern washington", "e washington"],
  ["grambling", "grambling state"],
  ["prairie view", "prairie view a and m"],
  ["bethune cookman", "bethune cookman"],
  ["texas a and m commerce", "east texas a and m"],
  ["north carolina a and t", "nc a and t"],
  ["georgia southern", "ga southern"],
  ["florida atlantic", "fau"],
  ["western kentucky", "wku"],
  ["south florida", "usf"],
  ["miami oh", "miami ohio"],
  ["kennesaw state", "kennesaw"],
  ["jacksonville state", "jax state"],
  ["florida state", "fsu"],
  ["ohio state", "osu"],
];

const ALIASES = new Map();
for (const g of ALIAS_GROUPS) for (const a of g) ALIASES.set(a, g);

function schoolForms(schoolN) {
  const set = new Set([schoolN]);
  for (const a of ALIASES.get(schoolN) ?? []) set.add(a);
  return [...set];
}

const tokens = (s) => s.split(" ").filter(Boolean);

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * How well a book's team name ("Miami Hurricanes") fits a CFBD team
 * ({school: "Miami", mascot: "Hurricanes"}). 0 = no, 3 = exact full name.
 */
export function teamScore(team, bookName) {
  const name = normalizeName(bookName);
  if (!name) return 0;
  const schoolN = normalizeName(team.school);
  const mascotN = normalizeName(team.mascot ?? "");
  const forms = schoolForms(schoolN);
  for (const f of forms) {
    if (mascotN && name === `${f} ${mascotN}`) return 3;
  }
  if (mascotN && name.endsWith(` ${mascotN}`)) {
    const head = name.slice(0, -mascotN.length - 1);
    if (forms.includes(head)) return 3;
  }
  for (const f of forms) {
    if (name === f) return 2;
  }
  // "Appalachian State Mountaineers" when our mascot spelling differs: school is a strict prefix, two or more words.
  for (const f of forms) {
    if (tokens(f).length >= 2 && name.startsWith(`${f} `)) return 1.5;
  }
  // Last resort: token overlap between the school and the book name with the mascot removed.
  const nameSansMascot = mascotN ? name.replace(new RegExp(` ${mascotN}$`), "") : name;
  const best = Math.max(...forms.map((f) => jaccard(tokens(f), tokens(nameSansMascot))));
  if (best >= 0.67) return 1;
  // Abbreviation match ("UTSA", "LSU") only when the book uses the bare abbreviation.
  const abbr = normalizeName(team.abbreviation ?? "");
  if (abbr && abbr.length >= 3 && tokens(nameSansMascot)[0] === abbr) return 1;
  return 0;
}

/**
 * Match our games (CFBD school names) to Odds API events. Both sides must score
 * at least 1 and the event must start within 36 hours of our kickoff. Neutral
 * site games sometimes list home and away the other way around; that is
 * returned as swapped = true and the parser flips the spread.
 * @returns Map<gameId, { event, swapped, score }>
 */
export function matchEvents(games, events, teamsBySchool) {
  const out = new Map();
  const used = new Set();
  const scored = [];
  for (const g of games) {
    const home = teamsBySchool.get(g.home) ?? { school: g.home, mascot: null, abbreviation: null };
    const away = teamsBySchool.get(g.away) ?? { school: g.away, mascot: null, abbreviation: null };
    const kick = Date.parse(g.kickoff);
    for (const ev of events) {
      const t = Date.parse(ev.commence_time);
      if (Number.isFinite(kick) && Number.isFinite(t) && Math.abs(t - kick) > 36 * 3600 * 1000) continue;
      const straight = [teamScore(home, ev.home_team), teamScore(away, ev.away_team)];
      const flipped = [teamScore(home, ev.away_team), teamScore(away, ev.home_team)];
      const sMin = Math.min(...straight);
      const fMin = Math.min(...flipped);
      if (sMin >= 1 && (sMin >= fMin || straight[0] + straight[1] >= flipped[0] + flipped[1])) scored.push({ gameId: g.id, event: ev, swapped: false, score: straight[0] + straight[1] + 0.01 });
      else if (fMin >= 1) scored.push({ gameId: g.id, event: ev, swapped: true, score: flipped[0] + flipped[1] });
    }
  }
  // Greedy by score so a strong match wins an event before a weak one can claim it.
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (out.has(s.gameId) || used.has(s.event.id)) continue;
    out.set(s.gameId, { event: s.event, swapped: s.swapped, score: s.score });
    used.add(s.event.id);
  }
  return out;
}

/* ------------------------------------------------------------ parsing */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * One Odds API event to per-book lines in our convention: spread is the HOME
 * spread (negative = home favored), like CollegeFootballData.
 */
export function parseEvent(ev, swapped = false) {
  const homeName = swapped ? ev.away_team : ev.home_team;
  const awayName = swapped ? ev.home_team : ev.away_team;
  const perBook = [];
  for (const bk of ev.bookmakers ?? []) {
    const line = { book: bk.key, title: bk.title ?? bk.key, updated: bk.last_update ?? null };
    for (const m of bk.markets ?? []) {
      const outs = m.outcomes ?? [];
      if (m.key === "spreads") {
        const h = outs.find((o) => o.name === homeName);
        const a = outs.find((o) => o.name === awayName);
        if (h && num(h.point) !== undefined) {
          line.spread = num(h.point);
          line.spreadPrice = num(h.price);
        } else if (a && num(a.point) !== undefined) {
          line.spread = -num(a.point);
        }
        if (a) line.awaySpreadPrice = num(a.price);
      } else if (m.key === "totals") {
        const over = outs.find((o) => o.name === "Over");
        const under = outs.find((o) => o.name === "Under");
        if (over && num(over.point) !== undefined) {
          line.total = num(over.point);
          line.overPrice = num(over.price);
        }
        if (under) line.underPrice = num(under.price);
      } else if (m.key === "h2h") {
        const h = outs.find((o) => o.name === homeName);
        const a = outs.find((o) => o.name === awayName);
        if (h) line.mlHome = num(h.price);
        if (a) line.mlAway = num(a.price);
      }
    }
    if (line.spread !== undefined || line.total !== undefined || line.mlHome !== undefined) perBook.push(line);
  }
  return perBook;
}

/** Props from the per-event endpoint: one row per book, market, player. */
export function parseProps(ev) {
  const rows = [];
  for (const bk of ev.bookmakers ?? []) {
    for (const m of bk.markets ?? []) {
      if (!m.key.startsWith("player_")) continue;
      const byPlayer = new Map();
      for (const o of m.outcomes ?? []) {
        const player = o.description ?? o.name;
        if (!player) continue;
        const row = byPlayer.get(player) ?? { book: bk.key, market: m.key, player };
        if (o.name === "Over") {
          row.point = num(o.point);
          row.overPrice = num(o.price);
        } else if (o.name === "Under") {
          row.point = row.point ?? num(o.point);
          row.underPrice = num(o.price);
        } else if (o.name === "Yes") row.yesPrice = num(o.price);
        else if (o.name === "No") row.noPrice = num(o.price);
        byPlayer.set(player, row);
      }
      rows.push(...byPlayer.values());
    }
  }
  return rows;
}

/* ------------------------------------------------------------ consensus */

export function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const half = (n) => (n === undefined ? undefined : Math.round(n * 2) / 2);

export function consensusOf(perBook) {
  const spread = half(median(perBook.map((b) => b.spread)));
  const total = half(median(perBook.map((b) => b.total)));
  const mlHome = median(perBook.map((b) => b.mlHome));
  const mlAway = median(perBook.map((b) => b.mlAway));
  return {
    spread,
    total,
    mlHome: mlHome === undefined ? undefined : Math.round(mlHome),
    mlAway: mlAway === undefined ? undefined : Math.round(mlAway),
    books: perBook.filter((b) => b.spread !== undefined).length,
  };
}

/* ------------------------------------------------------------ movement */

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const spreadLabel = (homeSpread, homeAbbr, awayAbbr) => {
  if (homeSpread === undefined) return "no spread";
  if (homeSpread === 0) return "pick";
  return homeSpread < 0 ? `${homeAbbr} ${fmt(homeSpread)}` : `${awayAbbr} ${fmt(-homeSpread)}`;
};

function spanText(fromIso, toIso) {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  const h = ms / 3600000;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} minutes`;
  if (h < 36) return `over ${Math.round(h)} hours`;
  return `over ${Math.round(h / 24)} days`;
}

/** "MIA -12 to -15.5 over 3 days; 5 of 7 books moved. Total 48.5 to 51." */
export function movementText(snapshots, homeAbbr, awayAbbr) {
  if (!snapshots.length) return "No line snapshots yet.";
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const c0 = first.consensus;
  const c1 = last.consensus;
  if (snapshots.length === 1) {
    const parts = [`One snapshot so far: ${spreadLabel(c1.spread, homeAbbr, awayAbbr)}`];
    if (c1.total !== undefined) parts.push(`total ${fmt(c1.total)}`);
    return `${parts.join(", ")} across ${c1.books} ${c1.books === 1 ? "book" : "books"}.`;
  }
  const out = [];
  if (c0.spread !== undefined && c1.spread !== undefined) {
    const span = spanText(first.at, last.at);
    const favFlipped = Math.sign(c0.spread) !== Math.sign(c1.spread) && c0.spread !== 0 && c1.spread !== 0;
    const moved = new Map(first.perBook.map((b) => [b.book, b.spread]));
    let changed = 0;
    let shared = 0;
    for (const b of last.perBook) {
      if (!moved.has(b.book) || b.spread === undefined || moved.get(b.book) === undefined) continue;
      shared++;
      if (moved.get(b.book) !== b.spread) changed++;
    }
    const books = shared ? `; ${changed} of ${shared} books moved` : "";
    if (c0.spread === c1.spread) out.push(`${spreadLabel(c1.spread, homeAbbr, awayAbbr)} has held ${span}${books}.`);
    else if (favFlipped) out.push(`Flipped from ${spreadLabel(c0.spread, homeAbbr, awayAbbr)} to ${spreadLabel(c1.spread, homeAbbr, awayAbbr)} ${span}${books}.`);
    else {
      const favHome = c1.spread < 0 || (c1.spread === 0 && c0.spread < 0);
      const favAbbr = favHome ? homeAbbr : awayAbbr;
      const a = favHome ? c0.spread : -c0.spread;
      const b = favHome ? c1.spread : -c1.spread;
      out.push(`${favAbbr} ${fmt(a)} to ${fmt(b)} ${span}${books}.`);
    }
  }
  if (c0.total !== undefined && c1.total !== undefined) {
    out.push(c0.total === c1.total ? `Total steady at ${fmt(c1.total)}.` : `Total ${fmt(c0.total)} to ${fmt(c1.total)}.`);
  }
  return out.join(" ") || "Snapshots exist but no book posted a spread.";
}

/* ------------------------------------------------------------ files */

export const oddsDir = (root) => path.join(root, "data", "odds");

export function oddsFilePath(root, season, gameId) {
  return path.join(oddsDir(root), String(season), `${gameId}.json`);
}

export function readOddsFile(root, season, gameId) {
  const f = oddsFilePath(root, season, gameId);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeOddsFile(root, file) {
  const f = oddsFilePath(root, file.season, file.gameId);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(file, null, 1));
}

/** Every odds file for a season (or all seasons). */
export function listOddsFiles(root, season) {
  const dir = oddsDir(root);
  if (!existsSync(dir)) return [];
  const seasons = season ? [String(season)] : readdirSync(dir).filter((d) => /^\d{4}$/.test(d));
  const out = [];
  for (const s of seasons) {
    const d = path.join(dir, s);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(path.join(d, f), "utf8")));
      } catch {}
    }
  }
  return out;
}

const sameBooks = (a, b) => JSON.stringify(a.map((x) => [x.book, x.spread, x.total, x.mlHome, x.mlAway])) === JSON.stringify(b.map((x) => [x.book, x.spread, x.total, x.mlHome, x.mlAway]));

/**
 * Append one snapshot for a matched game. Returns the file. A snapshot
 * identical to the previous one taken under an hour ago is not appended, so
 * a quiet line does not bloat the file.
 */
export function appendSnapshot(root, { season, gameId, home, away, kickoff, event, swapped, at }) {
  const perBook = parseEvent(event, swapped);
  const file = readOddsFile(root, season, gameId) ?? { gameId, season, home, away, kickoff, snapshots: [] };
  file.eventId = event.id;
  file.eventHome = event.home_team;
  file.eventAway = event.away_team;
  file.swapped = Boolean(swapped);
  file.kickoff = kickoff ?? file.kickoff;
  const snap = { at: at ?? new Date().toISOString(), perBook, consensus: consensusOf(perBook) };
  const prev = file.snapshots[file.snapshots.length - 1];
  if (prev && sameBooks(prev.perBook, perBook) && Date.parse(snap.at) - Date.parse(prev.at) < 3600000) {
    file.lastChecked = snap.at;
    writeOddsFile(root, file);
    return { file, appended: false };
  }
  file.snapshots.push(snap);
  file.lastChecked = snap.at;
  writeOddsFile(root, file);
  return { file, appended: true };
}

export function storeProps(root, file, event, at) {
  file.props = { at: at ?? new Date().toISOString(), rows: parseProps(event) };
  writeOddsFile(root, file);
  return file;
}

/** The last snapshot taken before kickoff. */
export function closingOf(file, kickoffIso) {
  if (!file?.snapshots?.length) return undefined;
  const kick = Date.parse(kickoffIso ?? file.kickoff);
  const before = Number.isFinite(kick) ? file.snapshots.filter((s) => Date.parse(s.at) <= kick) : file.snapshots;
  const snap = before[before.length - 1];
  if (!snap) return undefined;
  const hoursBefore = Number.isFinite(kick) ? Math.max(0, (kick - Date.parse(snap.at)) / 3600000) : undefined;
  return { at: snap.at, spread: snap.consensus.spread, total: snap.consensus.total, mlHome: snap.consensus.mlHome, mlAway: snap.consensus.mlAway, books: snap.consensus.books, hoursBeforeKick: hoursBefore === undefined ? undefined : Math.round(hoursBefore * 10) / 10 };
}

export function openingOf(file) {
  const snap = file?.snapshots?.[0];
  if (!snap) return undefined;
  return { at: snap.at, spread: snap.consensus.spread, total: snap.consensus.total, mlHome: snap.consensus.mlHome, mlAway: snap.consensus.mlAway, books: snap.consensus.books };
}

/* ------------------------------------------------------------ usage */

export function readUsage(root) {
  const f = path.join(oddsDir(root), "usage.json");
  if (!existsSync(f)) return { calls: 0 };
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return { calls: 0 };
  }
}

export function recordUsage(root, headers, cost) {
  const u = readUsage(root);
  const get = (k) => {
    const v = headers?.get?.(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const remaining = get("x-requests-remaining");
  const used = get("x-requests-used");
  const last = get("x-requests-last");
  const next = {
    ...u,
    calls: (u.calls ?? 0) + 1,
    lastCall: new Date().toISOString(),
    lastCost: last ?? cost,
    remaining: remaining ?? u.remaining,
    used: used ?? u.used,
  };
  mkdirSync(oddsDir(root), { recursive: true });
  writeFileSync(path.join(oddsDir(root), "usage.json"), JSON.stringify(next, null, 1));
  return next;
}

/* ------------------------------------------------------------ fetch */

export class OddsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function oddsGet(root, url, cost) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  recordUsage(root, res.headers, cost);
  if (!res.ok) throw new OddsApiError(`Odds API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, res.status);
  return res.json();
}

/** One slate call: every upcoming NCAAF event with h2h, spreads, totals from US books. Cost 3. */
export async function fetchSlateOdds(root, key, { from, to } = {}) {
  const q = new URLSearchParams({ apiKey: key, regions: REGIONS, markets: SLATE_MARKETS, oddsFormat: "american", dateFormat: "iso" });
  if (from) q.set("commenceTimeFrom", from);
  if (to) q.set("commenceTimeTo", to);
  const events = await oddsGet(root, `${BASE}/sports/${SPORT}/odds?${q}`, 3);
  return Array.isArray(events) ? events : [];
}

/** Props for one event. Cost = number of markets (4 by default). */
export async function fetchEventProps(root, key, eventId, markets = PROP_MARKETS) {
  const q = new URLSearchParams({ apiKey: key, regions: REGIONS, markets, oddsFormat: "american", dateFormat: "iso" });
  return oddsGet(root, `${BASE}/sports/${SPORT}/events/${encodeURIComponent(eventId)}/odds?${q}`, markets.split(",").length);
}

/** The free list of events (no odds, no credits). Used to find an event id without spending. */
export async function fetchEventList(key) {
  const q = new URLSearchParams({ apiKey: key, dateFormat: "iso" });
  const res = await fetch(`${BASE}/sports/${SPORT}/events?${q}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new OddsApiError(`Odds API ${res.status}`, res.status);
  const events = await res.json();
  return Array.isArray(events) ? events : [];
}

/** ISO date for "to" filters: the end of the given ET calendar date plus a day of slack. */
export function isoWindow(now = new Date()) {
  const from = new Date(now.getTime() - 6 * 3600 * 1000);
  const to = new Date(now.getTime() + 8 * 86400 * 1000);
  const trim = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { from: trim(from), to: trim(to) };
}
