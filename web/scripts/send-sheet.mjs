#!/usr/bin/env node
/**
 * Render the Sunday sheet to PNG and send it to Telegram as a photo.
 * Meant for a Sunday 8:00 AM cron (npm run sheet:send). Needs the site up
 * (PM2 "nfl" on PUBLIC_BASE_URL or http://localhost:3100) and Chrome.
 *
 *   node scripts/send-sheet.mjs               (today, ET)
 *   node scripts/send-sheet.mjs 2026-10-10    (a specific date)
 *   node scripts/send-sheet.mjs --dry         (render only, do not send)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(WEB);
const envFile = path.join(WEB, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
registerCjs();
registerEsm();

const render = await import("../src/lib/render.ts");
const digests = await import("../src/lib/digests.ts");
const slateLib = await import("../src/lib/slate.ts");
const tg = await import("../src/lib/telegram.ts");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? slateLib.etDate();
const base = digests.baseUrl();

const t0 = Date.now();
console.log(`Rendering ${base}/sheet?date=${date}&print=1 ...`);
const png = await render.renderSheetPng(date, base);
console.log(`Wrote ${png} in ${Date.now() - t0} ms`);

if (dry) process.exit(0);
if (!tg.telegramReady()) {
  console.error(`Not sent: ${tg.telegramMissing()}`);
  process.exit(2);
}
const caption = `EdgeSheet, ${digests.longDate(date)}. ${digests.NOT_A_PICK} ${base}/sheet?date=${date}`;
const sent = await tg.sendPhoto(png, caption);
console.log(`Sent as Telegram message ${sent.message_id}.`);
