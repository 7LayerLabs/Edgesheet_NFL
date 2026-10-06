/**
 * Coverage tendencies and receiver-versus-coverage splits for the game page. Server-only.
 *
 * Source: data/generated/coverage.json (scripts/ingest-coverage.mjs: nflverse pbp_participation, FTN charting, joined to
 * play-by-play). nflverse posts participation after a season ends, so during the season this is LAST season; every
 * sentence says so. The carry-over verdicts come from data/backtest/coverage.json (scripts/backtest-coverage.mjs):
 * a defense's two-deep-safety rate repeats season to season; a receiver's man-versus-zone yards split repeats weakly;
 * man rates and EPA splits do not (the Cover 1 versus Cover 3 call drifts with the charting), so they are context.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { genPlayers } from "./generated";
import { memoSync } from "./memo";

interface Ranked {
  value: number | null;
  rank?: number;
}
interface Side {
  tgt: number;
  catches: number;
  yards: number;
  td: number;
  ypt: number | null;
  epa: number | null;
  enough: boolean;
}
export interface CoverageTeam {
  code: string;
  def: {
    dropbacks: number;
    charted: number;
    twoHigh: Ranked & { n: number };
    oneHigh: Ranked & { n: number };
    man: Ranked & { n: number };
    zone: Ranked & { n: number };
    shells: { shell: string; key: string; pct: number | null; n: number; rank?: number }[];
    rush5: Ranked & { of: number };
    pressure: Ranked & { of: number };
    epaVsMan: Ranked & { n: number };
    epaVsZone: Ranked & { n: number };
  };
  off: {
    plays: number;
    personnel: { group: string; pct: number | null; n: number }[];
    epaVsMan: Ranked & { n: number };
    epaVsZone: Ranked & { n: number };
  };
}
export interface CoveragePlayer {
  gsis: string;
  id: string;
  name: string;
  pos: string;
  team?: string; // the team he played for most that season
  now?: string;
  targets: number;
  catches: number;
  yards: number;
  td: number;
  ypt: number;
  epa: number;
  man: Side;
  zone: Side;
}
interface CoverageFile {
  season: number;
  builtAt: string;
  minSplitTargets: number;
  teams: Record<string, CoverageTeam>;
  players: Record<string, CoveragePlayer>;
}
interface Test {
  what: string;
  pairs: number;
  r: number | null;
  ci: number[] | null;
  verdict: string;
}
interface Backtest {
  seasons: number[];
  note?: string;
  leagueDrift?: Record<string, { manRate: number; twoHighRate: number }>;
  tests: Record<string, Test>;
}

const GEN = path.join(process.cwd(), "data", "generated", "coverage.json");
const BT = path.join(process.cwd(), "data", "backtest", "coverage.json");

function load<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return memoSync(`coverage:${file}:${statSync(file).mtimeMs}`, 3600, () => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  });
}

export const coverageFile = () => load<CoverageFile>(GEN);
const backtest = () => load<Backtest>(BT);

const pct = (x: number | null | undefined) => (x == null ? "?" : `${Math.round(x * 100)}%`);
const yd = (x: number | null | undefined) => (x == null ? "?" : x.toFixed(1));
const no = (rank: number | undefined, of = 32) => (rank ? `No. ${rank} of ${of}` : "unranked");
const seasonWord = (f: CoverageFile) => `${f.season} season`;

/** The carry-over verdict line, built from the backtest file. Undefined when the backtest has not run. */
export function coverageNote(): string | undefined {
  const b = backtest();
  if (!b) return undefined;
  if (b.note) return b.note;
  const t = b.tests;
  const span = `${b.seasons[0]}-${b.seasons.at(-1)}`;
  const two = t.defenseTwoHighRate;
  const rec = t.receiverManMinusZoneYards;
  const man = t.defenseManRate;
  const parts: string[] = [];
  if (two?.r != null) parts.push(`a defense's two-deep-safety rate ${two.verdict === "carries over" ? "carries over" : "does not carry over"} from one season to the next (correlation ${two.r.toFixed(2)})`);
  if (rec?.r != null) parts.push(`a receiver's man-versus-zone yards split ${rec.verdict === "carries over" ? (rec.r < 0.3 ? "carries over weakly" : "carries over") : "does not carry over"} (${rec.r.toFixed(2)}, ${rec.pairs} receivers)`);
  if (man?.r != null) parts.push(`a defense's man rate ${man.verdict === "carries over" ? "carries over" : "does not"} (${man.r.toFixed(2)}): charting calls Cover 1 and Cover 3 differently from season to season, so treat man and zone shares and EPA splits as last season's context`);
  return parts.length ? `Tested on ${span}: ${parts.join("; ")}.` : undefined;
}

/** One team's coverage profile and a short read of its defense. */
export function teamCoverage(team: string): { season: number; team: CoverageTeam; read: string } | undefined {
  const f = coverageFile();
  const t = f?.teams[team];
  if (!f || !t) return undefined;
  const d = t.def;
  const top = d.shells.slice(0, 2).map((s) => `${s.shell} ${pct(s.pct)}`).join(", ");
  const read = `In the ${seasonWord(f)} the ${team} played two deep safeties on ${pct(d.twoHigh.value)} of charted pass plays (${no(d.twoHigh.rank)}), most often ${top}; man coverage on ${pct(d.man.value)} (${no(d.man.rank)}), 5 or more rushers on ${pct(d.rush5.value)} (${no(d.rush5.rank)}), pressure on ${pct(d.pressure.value)} of dropbacks (${no(d.pressure.rank)}). ${d.charted.toLocaleString("en-US")} pass plays charted.`;
  return { season: f.season, team: t, read };
}

const current = () => memoSync("coverage:current-teams", 600, () => new Map(genPlayers().map((p) => [p.id, p.t])));

/** One receiver's last-season line against man and zone, in words. */
export function receiverVsCoverage(id: string): { player: CoveragePlayer; read: string; season: number } | undefined {
  const f = coverageFile();
  const p = f?.players[id];
  if (!f || !p) return undefined;
  const now = current().get(id) ?? p.now;
  const where = p.team && now && p.team !== now ? ` with the ${p.team}` : "";
  const read =
    p.man.enough && p.zone.enough
      ? `${p.name} averaged ${yd(p.zone.ypt)} yards a target against zone (${p.zone.tgt} targets) and ${yd(p.man.ypt)} against man (${p.man.tgt})${where} in the ${seasonWord(f)}.`
      : `${p.name}: not enough targets against ${!p.man.enough ? `man (${p.man.tgt})` : `zone (${p.zone.tgt})`} for a split${where} in the ${seasonWord(f)}; ${yd(p.ypt)} yards a target overall (${p.targets} targets).`;
  return { player: p, read, season: f.season };
}

/** An offense against a defense: the defense's shells and man rate, and the offense's top 3 targets on today's roster. */
export function coverageMatchup(offense: string, defense: string): { season: number; lines: string[]; targets: CoveragePlayer[]; note?: string } | undefined {
  const f = coverageFile();
  const d = f?.teams[defense];
  if (!f || !d) return undefined;
  const lines: string[] = [];
  lines.push(`The ${defense} played two deep safeties on ${pct(d.def.twoHigh.value)} of pass plays in the ${seasonWord(f)} (${no(d.def.twoHigh.rank)}) and man on ${pct(d.def.man.value)} (${no(d.def.man.rank)}).`);
  const now = current();
  const targets = Object.values(f.players)
    .filter((p) => (now.get(p.id) ?? p.now) === offense)
    .sort((a, b) => b.targets - a.targets)
    .slice(0, 3);
  for (const p of targets) {
    const r = receiverVsCoverage(p.id);
    if (r) lines.push(r.read);
  }
  return { season: f.season, lines, targets, note: coverageNote() };
}
