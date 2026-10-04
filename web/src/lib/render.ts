/**
 * Render a page of this site to PNG with the locally installed Chrome in
 * headless mode. No puppeteer: plain child_process. Used for the Saturday
 * sheet (data/sheets/<date>.png) that Telegram sends as a photo.
 *
 * Chrome needs its own user-data-dir or it refuses to start while the real
 * Chrome is open, so every render gets a throwaway profile in the OS temp dir.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Crop the empty band under the content. Chrome captures the whole window, so pages render into a
 * tall window and this scans up from the bottom for the first row that differs from the bottom row.
 */
export async function trimBottom(file: string, padPx = 2): Promise<void> {
  const sharp = (await import("sharp")).default;
  const src = readFileSync(file);
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // Background from the bottom-right pixel; the left 8% is skipped so a floating corner badge
  // (the Next dev indicator) does not read as content. Sheet rows always run further right.
  const base = (height * width - 1) * channels;
  const bg = [data[base], data[base + 1], data[base + 2]];
  const x0 = Math.floor(width * 0.08);
  let last = height - 1;
  scan: for (let y = height - 1; y >= 0; y--) {
    const row = y * width * channels;
    for (let x = x0; x < width; x += 2) {
      const i = row + x * channels;
      if (Math.abs(data[i] - bg[0]) > 8 || Math.abs(data[i + 1] - bg[1]) > 8 || Math.abs(data[i + 2] - bg[2]) > 8) {
        last = y;
        break scan;
      }
    }
  }
  const h = Math.min(height, last + padPx);
  if (h >= height - 2) return;
  writeFileSync(file, await sharp(src).extract({ left: 0, top: 0, width, height: h }).png().toBuffer());
}

/** The whole sheet as one PNG: data/sheets/<date>.png, trimmed to its content. `base` is the site origin Chrome should load. */
export async function renderSheetPng(date: string, base: string, opts: RenderOptions = {}): Promise<string> {
  const out = path.join(process.cwd(), "data", "sheets", `${date}.png`);
  const url = `${base.replace(/\/+$/, "")}/sheet?date=${date}&print=1`;
  await renderPng(url, { out, height: 3000, ...opts });
  await trimBottom(out);
  return out;
}

/** The sheet as two Letter-width pages for Telegram: data/sheets/<date>-p1.png and -p2.png. */
export async function renderSheetPages(date: string, base: string, opts: RenderOptions = {}): Promise<string[]> {
  const files: string[] = [];
  for (const part of [1, 2]) {
    const out = path.join(process.cwd(), "data", "sheets", `${date}-p${part}.png`);
    const url = `${base.replace(/\/+$/, "")}/sheet?date=${date}&print=1&part=${part}`;
    await renderPng(url, { out, height: 1800, ...opts });
    await trimBottom(out);
    files.push(out);
  }
  return files;
}
