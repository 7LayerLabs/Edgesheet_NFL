#!/usr/bin/env node
/**
 * EdgeSheet Telegram bot. Long-running process for PM2:
 *
 *   cd web && pm2 start scripts/telegram-bot.mjs --name nfl-telegram --time
 *
 * Schedule (all Eastern time):
 *   - Morning slate at 8:00 AM on any day with games.
 *   - Kickoff reminders every 15 minutes while games are in a window, for
 *     followed teams (data/follows.json) with a kickoff in the next 60 minutes.
 *   - Postgame grades every 10 minutes while games are live or recently final,
 *     plus radar alerts for followed players who showed up. Hourly otherwise.
 *   - Commands by long polling: /slate, /leans, /record, /radar <team>, /game <team>, /help.
 *
 * The app's libraries are TypeScript; this script registers tsx and imports
 * them directly. Env comes from web/.env.local. State lives in
 * data/telegram-state.json (cursor, reminders sent, radar alerts sent).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(WEB); // the libs resolve data/ and tsconfig paths from cwd
const ENV_FILE = path.join(WEB, ".env.local");
const STATE_FILE = path.join(WEB, "data", "telegram-state.json");
const ET = "America/New_York";

loadEnv(ENV_FILE);
registerCjs();
registerEsm();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);

/* ----------------------------------------------------------------- env */

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

// Wait for the token instead of crash-looping under PM2. Re-reads .env.local every 5 minutes.
while (!process.env.TELEGRAM_BOT_TOKEN) {
  warn("TELEGRAM_BOT_TOKEN is not set in web/.env.local. Get a token from @BotFather, add it, and this process will pick it up within 5 minutes (or pm2 restart nfl-telegram).");
  await sleep(5 * 60_000);
  loadEnv(ENV_FILE);
}

/* ------------------------------------------------------------ app libs */

const tg = await import("../src/lib/telegram.ts");
const digests = await import("../src/lib/digests.ts");
const slateLib = await import("../src/lib/slate.ts");
const archive = await import("../src/lib/archive.ts");
const follows = await import("../src/lib/follows.ts");
const radar = await import("../src/lib/radar.ts");

const me = await tg.getMe().catch((e) => {
  warn(`Telegram rejected the token: ${e.message}`);
  process.exit(1);
});
log(`Bot @${me.username} online. Chat id ${tg.telegramChatId() ?? "NOT SET (push messages disabled until TELEGRAM_CHAT_ID is in .env.local)"}. Base URL ${digests.baseUrl()}.`);

/* --------------------------------------------------------------- state */

function readState() {
  try {
    if (existsSync(STATE_FILE)) return { remindersSent: {}, radarSent: [], ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {}
  return { remindersSent: {}, radarSent: [] };
}
function writeState(s) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}
const state = readState();
if (!state.gradesCursor) {
  // First run: do not replay every grade already in the archive.
  state.gradesCursor = new Date().toISOString();
  log(`No grades cursor yet. Starting from now (${state.gradesCursor}); earlier grades are on /history.`);
  writeState(state);
}

/* ------------------------------------------------------------ helpers */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "numeric", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), date: slateLib.etDate(d) };
}
const isD1 = (g) => g.division === "NFL";

async function push(text, label) {
  if (!tg.telegramChatId()) {
    warn(`[${label}] skipped: TELEGRAM_CHAT_ID is not set. Message the bot, then run node scripts/telegram-chat-id.mjs.`);
    return false;
  }
  try {
    const sent = await tg.sendMessage(text, { parseMode: "HTML" });
    log(`[${label}] sent ${sent.length} message(s).`);
    return true;
  } catch (e) {
    warn(`[${label}] failed: ${e.message}`);
    return false;
  }
}

/** Is any Division I game today in a "window": kicked off in the last 6 hours or kicking off in the next 2. */
function gameWindow(games, now = Date.now()) {
  return games.some((g) => {
    if (!isD1(g)) return false;
    const k = new Date(g.kickoff).getTime();
    return k >= now - 6 * 3600_000 && k <= now + 2 * 3600_000;
  });
}
/** Any Division I game live, or final with a kickoff in the last 6 hours. */
function gradingWindow(games, now = Date.now()) {
  return games.some((g) => isD1(g) && (g.status === "live" || (g.status === "final" && new Date(g.kickoff).getTime() >= now - 6 * 3600_000)));
}

/* ----------------------------------------------------------- scheduled */

async function morning(today) {
  const slate = await slateLib.getSlate(today);
  state.lastSlateDate = today;
  writeState(state);
  if (slate.date !== today || !slate.games.some(isD1)) {
    log(`[slate] no Division I games on ${today}; nothing sent.`);
    return;
  }
  await push(digests.morningSlate(slate), "slate");
}

async function reminders(slate) {
  const f = follows.readFollows();
  if (!f.teams.length && !f.games.length) return;
  const hits = digests.upcomingForFollows(slate.games, f, new Date(), 60).filter((h) => !state.remindersSent[h.game.id]);
  if (!hits.length) return;
  const ok = await push(digests.kickoffReminder(hits), "kickoff");
  if (ok) {
    for (const h of hits) state.remindersSent[h.game.id] = new Date().toISOString();
    // Keep the map small: drop entries older than 2 days.
    const cutoff = Date.now() - 2 * 86400_000;
    for (const [id, at] of Object.entries(state.remindersSent)) if (new Date(at).getTime() < cutoff) delete state.remindersSent[id];
    writeState(state);
  }
}

async function grades(season) {
  // getSlate() grades every final on today's slate that has a locked call, so the archive is fresh after this.
  const entries = archive.listEntries(season);
  const { entries: fresh, cursor } = digests.newlyGraded(entries, state.gradesCursor);
  if (fresh.length) {
    const ok = await push(digests.postgameDigest(fresh), "grades");
    if (ok) {
      state.gradesCursor = cursor;
      writeState(state);
    }
  }
  const f = follows.readFollows();
  const alerts = digests.radarAlerts(entries, f, new Set(state.radarSent));
  if (alerts.length) {
    const ok = await push(digests.radarAlertDigest(alerts), "radar");
    if (ok) {
      state.radarSent = [...state.radarSent, ...alerts.map((a) => a.key)].slice(-500);
      writeState(state);
    }
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { hour, minute, date: today } = etParts();
    const slateNeeded = (hour === 8 && minute < 10 && state.lastSlateDate !== today) || minute % 15 === 0 || minute % 10 === 0 || minute === 0;
    if (!slateNeeded) return;
    const slate = await slateLib.getSlate(today);
    const todays = slate.date === today ? slate.games : [];

    if (hour === 8 && minute < 10 && state.lastSlateDate !== today) await morning(today);
    if (minute % 15 === 0 && gameWindow(todays)) await reminders(slate);
    if ((minute % 10 === 0 && gradingWindow(todays)) || minute === 0) await grades(slate.season);
  } catch (e) {
    warn(`[tick] ${e.message}`);
  } finally {
    ticking = false;
  }
}

/* ------------------------------------------------------------ commands */

async function handle(text, chatId) {
  const m = text.trim().match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/i);
  if (!m) return undefined;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();
  const reply = (t) => tg.sendMessage(t, { parseMode: "HTML", chatId });
  switch (cmd) {
    case "start":
    case "help":
      return reply(digests.helpDigest());
    case "slate": {
      const slate = await slateLib.getSlate(/^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined);
      return reply(digests.morningSlate(slate));
    }
    case "leans": {
      const slate = await slateLib.getSlate(/^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined);
      return reply(digests.leansDigest(slate.games.filter(isD1), slate.date));
    }
    case "record": {
      const slate = await slateLib.getSlate();
      return reply(digests.recordDigest(archive.listEntries(slate.season)));
    }
    case "radar": {
      if (!arg) return reply("Usage: /radar &lt;team&gt;, for example /radar LSU");
      const slate = await slateLib.getSlate();
      let school = digests.resolveSchool(slate.weekGames, arg);
      if (!school) {
        const q = arg.toLowerCase();
        const keys = [...radar.radarIndex().byTeam.keys()];
        school = keys.find((k) => k.toLowerCase() === q) ?? keys.find((k) => k.toLowerCase().startsWith(q)) ?? keys.find((k) => k.toLowerCase().includes(q));
      }
      if (!school) return reply(`No team matches "${tg.escapeHtml(arg)}" on this week's slate or in the ingested rosters.`);
      const game = slate.weekGames.find((g) => g.home.short === school || g.away.short === school);
      return reply(digests.teamRadarDigest(school, radar.radarForTeam(school), game));
    }
    case "game": {
      if (!arg) return reply("Usage: /game &lt;team&gt;, for example /game Ohio State");
      const slate = await slateLib.getSlate();
      const hit = digests.findTeamGames(slate.weekGames, arg)[0];
      if (!hit) return reply(`No game this week for "${tg.escapeHtml(arg)}".`);
      const full = (await slateLib.getGame(hit.id).catch(() => undefined)) ?? hit;
      return reply(digests.gameDigest(full));
    }
    default:
      return reply(`Unknown command /${tg.escapeHtml(cmd)}.\n\n${digests.helpDigest()}`);
  }
}

async function poll() {
  let offset = state.lastUpdateId ? state.lastUpdateId + 1 : undefined;
  const allowed = tg.telegramChatId();
  for (;;) {
    let updates = [];
    try {
      updates = await tg.getUpdates(offset, 30);
    } catch (e) {
      warn(`[poll] ${e.message}${/409/.test(e.message) || /terminated by other/i.test(e.message) ? " (another process is polling this bot; stop it, only one poller is allowed)" : ""}`);
      await sleep(10_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      state.lastUpdateId = u.update_id;
      const msg = u.message;
      if (!msg?.text) continue;
      const from = String(msg.chat.id);
      if (!allowed) {
        warn(`[poll] message from chat id ${from} (${msg.chat.type}${msg.chat.username ? `, @${msg.chat.username}` : ""}). Add TELEGRAM_CHAT_ID=${from} to .env.local and restart.`);
        await tg.sendMessage(`This chat id is <code>${from}</code>. Add <code>TELEGRAM_CHAT_ID=${from}</code> to web/.env.local and restart the bot (pm2 restart scout-telegram).`, { parseMode: "HTML", chatId: msg.chat.id }).catch(() => {});
        continue;
      }
      if (from !== allowed) {
        warn(`[poll] ignored message from chat id ${from} (not TELEGRAM_CHAT_ID).`);
        continue;
      }
      log(`[cmd] ${msg.text}`);
      try {
        await handle(msg.text, msg.chat.id);
      } catch (e) {
        warn(`[cmd] ${msg.text} failed: ${e.message}`);
        await tg.sendMessage(`That failed: ${tg.escapeHtml(e.message)}`, { parseMode: "HTML", chatId: msg.chat.id }).catch(() => {});
      }
    }
    if (updates.length) writeState(state);
  }
}

/* ---------------------------------------------------------------- run */

setInterval(tick, 60_000);
tick();
poll();
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
