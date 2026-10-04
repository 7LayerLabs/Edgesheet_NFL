/**
 * Render a page of this site to PNG with the locally installed Chrome in
 * headless mode. No puppeteer: plain child_process. Used for the Saturday
 * sheet (data/sheets/<date>.png) that Telegram sends as a photo.
 *
 * Chrome needs its own user-data-dir or it refuses to start while the real
 * Chrome is open, so every render gets a throwaway profile in the OS temp dir.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => Boolean(p));

export function chromePath(): string | undefined {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Device pixel ratio. 2 makes a Letter page 1632 x 2112, crisp on a phone. */
  scale?: number;
  /** Where to write the PNG. Defaults to a temp file. */
  out?: string;
  /** Virtual time budget in ms so fonts, logos, and data settle before the capture. */
  budgetMs?: number;
  timeoutMs?: number;
}

/** Screenshot `url` to a PNG file and return its path. Throws with a plain message when Chrome is missing or fails. */
export async function renderPng(url: string, opts: RenderOptions = {}): Promise<string> {
  const chrome = chromePath();
  if (!chrome) throw new Error("Chrome is not installed at C:/Program Files/Google/Chrome/Application/chrome.exe. Set CHROME_PATH to the browser executable.");
  const width = opts.width ?? 816;
  const height = opts.height ?? 1056;
  const scale = opts.scale ?? 2;
  const out = opts.out ?? path.join(tmpdir(), `edgesheet-${Date.now()}.png`);
  mkdirSync(path.dirname(out), { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "edgesheet-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    `--virtual-time-budget=${opts.budgetMs ?? 15000}`,
    `--screenshot=${out}`,
    url,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(chrome, args, { timeout: opts.timeoutMs ?? 90_000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`Chrome exited with an error: ${err.message}${stderr ? ` ${String(stderr).slice(0, 300)}` : ""}`));
        else resolve();
      });
    });
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* temp profile cleanup is best effort */
    }
  }
  if (!existsSync(out) || statSync(out).size < 1000) throw new Error(`Chrome produced no screenshot for ${url}`);
  return out;
}

/** The sheet PNG for a date: data/sheets/<date>.png. `base` is the site origin Chrome should load. */
export async function renderSheetPng(date: string, base: string, opts: RenderOptions = {}): Promise<string> {
  const out = path.join(process.cwd(), "data", "sheets", `${date}.png`);
  const url = `${base.replace(/\/+$/, "")}/sheet?date=${date}&print=1`;
  return renderPng(url, { out, ...opts });
}
