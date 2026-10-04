/**
 * Model changelog. scripts/tune.mjs appends one entry per proposed or applied
 * parameter change to data/changelog.json. The Record page lists them and the
 * slate header shows a small note when one landed in the last seven days.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { memoSync } from "./memo";

export interface ChangelogEntry {
  /** ISO timestamp of the tuning run. */
  date: string;
  /** Plain label: "edge threshold", "total baseline offset", "eloWeight", "edgeDivisor", or a proposal label. */
  metric: string;
  from: number | string;
  to: number | string;
  /** Short evidence line: "played-out rate 61% vs 54%, n=73". */
  evidence: string;
  applied: boolean;
}

const FILE = path.join(process.cwd(), "data", "changelog.json");

function stamp() {
  try {
    return String(statSync(FILE).mtimeMs);
  } catch {
    return "missing";
  }
}

/** Newest first. Never throws. */
export function readChangelog(): ChangelogEntry[] {
  return memoSync(`changelog:${stamp()}`, 300, () => {
    if (!existsSync(FILE)) return [];
    try {
      const raw = JSON.parse(readFileSync(FILE, "utf8")) as ChangelogEntry[];
      if (!Array.isArray(raw)) return [];
      return raw.filter((e) => e && typeof e.date === "string").sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  });
}

/** The newest entry inside the last `days` days, if any. */
export function recentUpdate(days = 7): ChangelogEntry | undefined {
  const cutoff = Date.now() - days * 86_400_000;
  return readChangelog().find((e) => new Date(e.date).getTime() >= cutoff);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

/** "Oct 6: edge threshold 20 to 25 (played-out rate 61% vs 54%, n=73)" */
export function changelogLine(e: ChangelogEntry): string {
  return `${shortDate(e.date)}: ${e.metric} ${e.from} to ${e.to} (${e.evidence})`;
}
