/**
 * Pre-registered test 4.1 (tasks/todo.md, "Decision rules for Phases 2 to 5", written and pushed in 8bd3de7 before
 * this script existed): do forecast wind and rain predict the total going under the closing line?
 *
 *   node scripts/backtest-wind.mjs
 *
 * The rule, as written:
 *   2024 and 2025, outdoor and open-roof games, regular season and playoffs. Forecast = Open-Meteo previous-runs 10 m
 *   wind speed issued the day before (previous_day1), at the stadium, averaged over the kickoff hour and the 3 hours
 *   after. Windy = 10+ mph. Outcome = final total against the nflverse closing total, pushes out. PASS = windy games go
 *   under 55%+ of the time, one-sided binomial p <= 0.05 against 50%, and 60+ games. Rain the same way: 1+ mm forecast
 *   over those 4 hours, same bar.
 *
 * How each part is read (fixed before the first run):
 *   games    nflverse schedule (data/cache/games.csv), seasons 2024 and 2025, every game type (REG, WC, DIV, CON, SB),
 *            roof "outdoors" or "open", with a final score and a closing total.
 *   venue    stadium_id -> coordinates (STADIUMS below; the US ones are checked against data/nfl-teams.json at run time).
 *            Seven 2025 international games carry the home team's usual stadium in the schedule; VENUE_FIX puts them
 *            at the venue the nflverse play-by-play `stadium` field (NFL game data) gives.
 *   time     gametime is ET. It is turned into UTC with the real New York offset (daylight saving aware) and the
 *            forecast is asked for in GMT, because Open-Meteo ignores daylight saving changes inside a requested range.
 *            The kickoff hour is the clock hour the game starts in (a 4:25 kickoff uses 4:00).
 *   wind     wind_speed_10m_previous_day1 (an instant value, mph) at the kickoff hour and the next 3 hourly stamps,
 *            averaged. Windy = average 10+ mph.
 *   rain     precipitation_previous_day1 is the sum over the hour before each stamp, so the 4 clock hours that start at
 *            the kickoff hour are the stamps 1 to 4 hours after it. Summed. Rainy = 1+ mm.
 *   outcome  home + away points against total_line: under if below, over if above, pushes out of the rate.
 *   bar      under rate 0.55+, one-sided exact binomial p <= 0.05 against 0.5, and 60+ graded games (pushes out).
 *
 * Raw Open-Meteo responses are cached in data/cache/openmeteo/ (one call per venue per season), so a rerun makes no
 * calls. Writes data/backtest/wind.json with every game and its hourly forecast values so the result can be audited.
 */
import { mkdir, writeFile, readFile, access, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, num } from "./lib/csv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CACHE = path.join(root, "data", "cache", "openmeteo");
const OUT = path.join(root, "data", "backtest");
const SEASONS = [2024, 2025];
const WINDY_MPH = 10;
const RAIN_MM = 1;
const BAR = { underRate: 0.55, p: 0.05, games: 60 };
const HOUR = 3600 * 1000;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = (f) => access(f).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Venue coordinates (stadium center, published locations). Keys are nflverse stadium_id, except DUB00, BER00 and
// MAD00, which are local keys for 2025 venues the schedule does not name. `team` marks the venues checked against
// data/nfl-teams.json.
const STADIUMS = {
  BAL00: { name: "M&T Bank Stadium, Baltimore", team: "BAL", lat: 39.278, lon: -76.6227 },
  BOS00: { name: "Gillette Stadium, Foxborough", team: "NE", lat: 42.0909, lon: -71.2643 },
  BUF00: { name: "Highmark Stadium (New Era Field), Orchard Park", team: "BUF", lat: 42.7738, lon: -78.787 },
  CAR00: { name: "Bank of America Stadium, Charlotte", team: "CAR", lat: 35.2258, lon: -80.8528 },
  CHI98: { name: "Soldier Field, Chicago", team: "CHI", lat: 41.8623, lon: -87.6167 },
  CIN00: { name: "Paycor Stadium, Cincinnati", team: "CIN", lat: 39.0954, lon: -84.516 },
  CLE00: { name: "Huntington Bank Field (FirstEnergy Stadium), Cleveland", team: "CLE", lat: 41.5061, lon: -81.6995 },
  DEN00: { name: "Empower Field at Mile High, Denver", team: "DEN", lat: 39.7439, lon: -105.0201 },
  GNB00: { name: "Lambeau Field, Green Bay", team: "GB", lat: 44.5013, lon: -88.0622 },
  JAX00: { name: "EverBank Stadium (TIAA Bank Stadium), Jacksonville", team: "JAX", lat: 30.3239, lon: -81.6373 },
  KAN00: { name: "GEHA Field at Arrowhead Stadium, Kansas City", team: "KC", lat: 39.0489, lon: -94.4839 },
  MIA00: { name: "Hard Rock Stadium, Miami Gardens", team: "MIA", lat: 25.958, lon: -80.2389 },
  NAS00: { name: "Nissan Stadium, Nashville", team: "TEN", lat: 36.1665, lon: -86.7713 },
  NYC01: { name: "MetLife Stadium, East Rutherford", team: "NYG", lat: 40.8135, lon: -74.0745 },
  PHI00: { name: "Lincoln Financial Field, Philadelphia", team: "PHI", lat: 39.9008, lon: -75.1675 },
  PIT00: { name: "Acrisure Stadium, Pittsburgh", team: "PIT", lat: 40.4468, lon: -80.0158 },
  SEA00: { name: "Lumen Field, Seattle", team: "SEA", lat: 47.5952, lon: -122.3316 },
  SFO01: { name: "Levi's Stadium, Santa Clara", team: "SF", lat: 37.4033, lon: -121.9694 },
  TAM00: { name: "Raymond James Stadium, Tampa", team: "TB", lat: 27.9759, lon: -82.5033 },
  WAS00: { name: "Northwest Stadium (FedExField), Landover", team: "WAS", lat: 38.9076, lon: -76.8645 },
  SAO00: { name: "Arena Corinthians (Neo Quimica Arena), Sao Paulo", lat: -23.5453, lon: -46.4742 },
  LON00: { name: "Wembley Stadium, London", lat: 51.556, lon: -0.2796 },
  LON02: { name: "Tottenham Hotspur Stadium, London", lat: 51.6043, lon: -0.0664 },
  GER00: { name: "Allianz Arena, Munich", lat: 48.2188, lon: 11.6247 },
  DUB00: { name: "Croke Park, Dublin", lat: 53.3607, lon: -6.2512 },
  BER00: { name: "Olympiastadion, Berlin", lat: 52.5147, lon: 13.2395 },
  MAD00: { name: "Santiago Bernabeu, Madrid", lat: 40.4531, lon: -3.6883 },
};

// 2025 international games whose schedule row names the home team's usual stadium. Venue from the nflverse
// play-by-play `stadium` field (NFL game data). Roof from the venue: Croke Park, Tottenham, Wembley, the Olympiastadion
// and Arena Corinthians have no roof over the field; the NFL gamebook lists the Bernabeu (retractable) as closed for
// the Madrid game, so that one leaves the outdoor set.
const VENUE_FIX = {
  "2025_01_KC_LAC": { stadium: "SAO00", roof: "outdoors", schedule: "SoFi Stadium, roof dome" },
  "2025_04_MIN_PIT": { stadium: "DUB00", roof: "outdoors", schedule: "Acrisure Stadium, roof outdoors" },
  "2025_05_MIN_CLE": { stadium: "LON02", roof: "outdoors", schedule: "FirstEnergy Stadium, roof outdoors" },
  "2025_06_DEN_NYJ": { stadium: "LON02", roof: "outdoors", schedule: "MetLife Stadium, roof outdoors" },
  "2025_07_LA_JAX": { stadium: "LON00", roof: "outdoors", schedule: "TIAA Bank Stadium, roof outdoors" },
  "2025_10_ATL_IND": { stadium: "BER00", roof: "outdoors", schedule: "Lucas Oil Stadium, roof closed" },
  "2025_11_WAS_MIA": { stadium: "MAD00", roof: "closed", schedule: "Hard Rock Stadium, roof outdoors" },
};

const km = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// Cross-check the US venues against the app's team table.
const teams = JSON.parse(await readFile(path.join(root, "data", "nfl-teams.json"), "utf8")).teams;
for (const [id, v] of Object.entries(STADIUMS)) {
  if (!v.team) continue;
  const s = teams.find((t) => t.code === v.team)?.stadium;
  const d = s ? km(v, s) : Infinity;
  if (d > 0.5) throw new Error(`${id} ${v.name} is ${d.toFixed(2)} km from nfl-teams.json ${v.team}`);
}

// ET wall clock to UTC, with the offset New York actually had at that instant.
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function etOffsetMin(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 60000;
}
function etToUtc(day, time) {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  return wall - etOffsetMin(wall - etOffsetMin(wall) * 60000) * 60000;
}
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16); // Open-Meteo GMT time label, "2024-09-08T13:00"

const games = [];
let skippedRoof = 0;
await readCsv(path.join(root, "data", "cache", "games.csv"), (r) => {
  if (!SEASONS.includes(Number(r.season))) return;
  const fix = VENUE_FIX[r.game_id];
  const roof = fix?.roof ?? r.roof;
  if (roof !== "outdoors" && roof !== "open") {
    skippedRoof++;
    return;
  }
  const hs = num(r.home_score);
  const as = num(r.away_score);
  const line = num(r.total_line);
  if (hs == null || as == null || line == null) throw new Error(`${r.game_id} has no final or no closing total`);
  const stadiumId = fix?.stadium ?? r.stadium_id;
  if (!STADIUMS[stadiumId]) throw new Error(`${r.game_id}: no coordinates for ${stadiumId} ${r.stadium}`);
  const kickoff = etToUtc(r.gameday, r.gametime);
  games.push({
    gameId: r.game_id,
    season: Number(r.season),
    type: r.game_type,
    gameday: r.gameday,
    gametimeET: r.gametime,
    kickoffUTC: new Date(kickoff).toISOString().slice(0, 16) + "Z",
    kickoffHour: Math.floor(kickoff / HOUR) * HOUR,
    roof,
    stadiumId,
    venue: STADIUMS[stadiumId].name,
    venueFixed: fix ? `schedule said ${fix.schedule}` : undefined,
    line,
    points: hs + as,
  });
});
const fixedOut = Object.entries(VENUE_FIX).filter(([, f]) => f.roof !== "outdoors" && f.roof !== "open").map(([id]) => id);
log("outdoor and open-roof games", games.length, "| left out for roof", skippedRoof, `(incl. ${fixedOut.join(", ")})`);

// One Open-Meteo call per venue per season, covering every hour any of its games needs.
async function forecast(stadiumId, start, end) {
  const v = STADIUMS[stadiumId];
  const file = path.join(CACHE, `${stadiumId}_${start}_${end}.json`);
  if (await exists(file)) return JSON.parse(await readFile(file, "utf8"));
  const url =
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}` +
    `&hourly=wind_speed_10m_previous_day1,precipitation_previous_day1&start_date=${start}&end_date=${end}` +
    `&wind_speed_unit=mph&precipitation_unit=mm&timezone=GMT`;
  await sleep(1500);
  log("download", stadiumId, start, end);
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${stadiumId} ${start}..${end}: ${text.slice(0, 300)}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(`${file}.part`, text);
  await rename(`${file}.part`, file);
  return JSON.parse(text);
}

const groups = new Map();
for (const g of games) {
  const k = `${g.stadiumId}|${g.season}`;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(g);
}
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const gridKm = {};
for (const [k, set] of groups) {
  const [stadiumId] = k.split("|");
  const start = day(Math.min(...set.map((g) => g.kickoffHour)));
  const end = day(Math.max(...set.map((g) => g.kickoffHour + 4 * HOUR)));
  const om = await forecast(stadiumId, start, end);
  if (om.utc_offset_seconds !== 0) throw new Error(`${stadiumId}: expected GMT series`);
  const idx = new Map(om.hourly.time.map((t, i) => [t, i]));
  const grid = { lat: om.latitude, lon: om.longitude };
  gridKm[stadiumId] = Math.round(km(STADIUMS[stadiumId], grid) * 10) / 10;
  for (const g of set) {
    const at = (h, key) => {
      const i = idx.get(stamp(g.kickoffHour + h * HOUR));
      return i === undefined ? null : om.hourly[key][i];
    };
    g.windMphHours = [0, 1, 2, 3].map((h) => at(h, "wind_speed_10m_previous_day1"));
    g.rainMmHours = [1, 2, 3, 4].map((h) => at(h, "precipitation_previous_day1"));
    // Kickoff-hour stamps for rain too; only used to count how many games the stamp reading changes.
    g.rainMmSameStampsAsWind = [0, 1, 2, 3].map((h) => at(h, "precipitation_previous_day1"));
    g.wind = g.windMphHours.includes(null) ? null : Math.round((g.windMphHours.reduce((a, b) => a + b, 0) / 4) * 100) / 100;
    g.rain = g.rainMmHours.includes(null) ? null : Math.round(g.rainMmHours.reduce((a, b) => a + b, 0) * 100) / 100;
    g.gridPoint = grid;
  }
}

// Exact one-sided binomial: P(X >= k) for X ~ Binomial(n, 0.5).
function pUpper(k, n) {
  const lf = [0];
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp(lf[n] - lf[i] - lf[n - i] - n * Math.LN2);
  return Math.min(1, p);
}
const r3 = (x) => Math.round(x * 1000) / 1000;
function grade(set) {
  let unders = 0, overs = 0, pushes = 0, miss = 0;
  for (const g of set) {
    miss += g.points - g.line;
    if (g.points < g.line) unders++;
    else if (g.points > g.line) overs++;
    else pushes++;
  }
  const graded = unders + overs;
  return {
    games: set.length,
    graded,
    unders,
    overs,
    pushes,
    underRate: graded ? r3(unders / graded) : null,
    pOneSided: graded ? Number(pUpper(unders, graded).toPrecision(3)) : null,
    meanFinalMinusClose: set.length ? r3(miss / set.length) : null,
  };
}
function verdict(gr) {
  const checks = { underRate: gr.underRate >= BAR.underRate, p: gr.pOneSided <= BAR.p, games: gr.graded >= BAR.games };
  return { pass: checks.underRate && checks.p && checks.games, checks };
}

const outcome = (g) => (g.points < g.line ? "under" : g.points > g.line ? "over" : "push");
for (const g of games) {
  g.result = outcome(g);
  g.finalMinusClose = g.points - g.line;
  g.windy = g.wind == null ? null : g.wind >= WINDY_MPH;
  g.rainy = g.rain == null ? null : g.rain >= RAIN_MM;
}
const noWind = games.filter((g) => g.wind == null);
const noRain = games.filter((g) => g.rain == null);
const windy = games.filter((g) => g.windy === true);
const calm = games.filter((g) => g.windy === false);
const rainy = games.filter((g) => g.rainy === true);
const dry = games.filter((g) => g.rainy === false);
const bySeason = (set) => SEASONS.map((y) => ({ season: y, ...grade(set.filter((g) => g.season === y)) }));

const windGrade = grade(windy);
const rainGrade = grade(rainy);
const results = {
  wind: { windy: windGrade, calm: grade(calm), verdict: verdict(windGrade), windyBySeason: bySeason(windy) },
  rain: { rainy: rainGrade, dry: grade(dry), verdict: verdict(rainGrade), rainyBySeason: bySeason(rainy) },
  allOutdoor: grade(games),
};
for (const t of ["wind", "rain"]) {
  const v = results[t].verdict;
  const gr = t === "wind" ? windGrade : rainGrade;
  if (v.pass) v.liveTilt = gr.meanFinalMinusClose;
}

// What the readings and fixes touched.
const fixedIn = games.filter((g) => g.venueFixed);
const rainStampFlips = games.filter((g) => {
  if (g.rain == null || g.rainMmSameStampsAsWind.includes(null)) return false;
  return g.rainMmSameStampsAsWind.reduce((a, b) => a + b, 0) >= RAIN_MM !== g.rainy;
});
const notes = {
  venueFixes: {
    games: Object.keys(VENUE_FIX).length,
    keptOutdoor: fixedIn.map((g) => ({ gameId: g.gameId, venue: g.venue, wind: g.wind, rain: g.rain, windy: g.windy, rainy: g.rainy, result: g.result })),
    leftOutClosedRoof: fixedOut,
    note: "Schedule rows name the home team's usual stadium; venue from the nflverse play-by-play stadium field. Madrid roof closed per the NFL gamebook.",
  },
  openRoof: {
    games: games.filter((g) => g.roof === "open").length,
    note: "nflverse codes no 2024 or 2025 game as roof open (10 to 11 a season in 2021 to 2023), so open-roof games at retractable stadiums are coded closed and are not in the test.",
  },
  missingForecast: { wind: noWind.map((g) => g.gameId), rain: noRain.map((g) => g.gameId) },
  rainStampReading: {
    note: "Rain uses the stamps 1 to 4 hours after the kickoff hour (each stamp sums the hour before it). Games whose rainy flag would change if the kickoff-hour stamps were summed instead:",
    games: rainStampFlips.map((g) => ({ gameId: g.gameId, rain: g.rain, sameStamps: Math.round(g.rainMmSameStampsAsWind.reduce((a, b) => a + b, 0) * 100) / 100, result: g.result })),
  },
  sixtyGames: "Counted as graded games (pushes out).",
  gridPointKmFromVenue: gridKm,
};

await mkdir(OUT, { recursive: true });
await writeFile(
  path.join(OUT, "wind.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      test: "4.1 pre-registered in tasks/todo.md (commit 8bd3de7)",
      seasons: SEASONS,
      thresholds: { windyMph: WINDY_MPH, rainMm: RAIN_MM, bar: BAR },
      source: "Open-Meteo previous-runs API, best_match model, wind_speed_10m_previous_day1 and precipitation_previous_day1, GMT series",
      results,
      notes,
      stadiums: STADIUMS,
      games: games.map(({ kickoffHour, ...g }) => g),
    },
    null,
    2,
  ),
);

console.log(`Outdoor games ${games.length}; missing wind ${noWind.length}, missing rain ${noRain.length}`);
console.log(`Windy (avg ${WINDY_MPH}+ mph) vs calm:`);
console.table({ windy: windGrade, calm: results.wind.calm, all: results.allOutdoor });
console.log("Wind verdict:", results.wind.verdict);
console.log(`Rainy (${RAIN_MM}+ mm over the 4 hours) vs dry:`);
console.table({ rainy: rainGrade, dry: results.rain.dry, all: results.allOutdoor });
console.log("Rain verdict:", results.rain.verdict);
console.log("Venue-fixed games kept:", notes.venueFixes.keptOutdoor);
console.log("Rain stamp reading flips:", notes.rainStampReading.games.length);
console.log("Grid point km from venue:", gridKm);
