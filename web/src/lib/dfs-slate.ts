/**
 * The simulated DraftKings slate for a date: the Classic pool from dfs.ts, play probabilities from injury status (or
 * Jev when there is fresh news, jev-dfs.ts), backups for anyone who might sit, then 10,000 simulations and three lineups
 * (dfs-sim.ts). Server-only. Memoized 20 minutes per salary pull and status set; a copy is written to data/dk/<date>-sim.json.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { absenceOf } from "./availability";
import { classicPool, type DfsPlay } from "./dfs";
import { assignRoles, buildLineups, seedOf, simulateSlate, type LineupSim, type PlayerSim, type SimHistory, type SimPlayer } from "./dfs-sim";
import { newsJudgments, ROLE_MULTIPLIER, type NewsCandidate, type NewsJudgment } from "./jev-dfs";
import { memo, memoSync } from "./memo";
import { getSlate, shiftDate } from "./slate";

const HISTORY = path.join(process.cwd(), "data", "backtest", "dfs-sim.json");
const DK_DIR = path.join(process.cwd(), "data", "dk");
const N = 10000;
/** Share of a sitter's projection his backups pick up in the draws where he sits (the lens's next-man-up rule). */
const NEXT_MAN_UP = 0.5;
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface SlatePlayer extends PlayerSim {
  play: DfsPlay;
  proj: number; // after Jev's role adjustment
  pPlay: number;
  pPlaySource: "jev" | "status";
  role?: string;
  jev?: { role: NewsJudgment["role"]; roleConfidence?: number; jevPlay?: number; posts: number; beneficiary?: string };
  backups?: string[]; // names
}

export interface SlateLineup extends LineupSim {
  players: SlatePlayer[];
}

export interface SlateSim {
  date: string;
  source?: string;
  builtAt: string;
  n: number;
  players: SlatePlayer[];
  lineups: SlateLineup[];
  jevCalls: number;
  calibration: { pass: boolean; method: string; worstSeasonOff: Record<string, number> };
}

const history = (): (SimHistory & { calibration?: { pass: boolean; method: string; byPos: Record<string, { worstSeasonOff: number }> } }) | undefined => {
  let stamp = "missing";
  try {
    stamp = String(statSync(HISTORY).mtimeMs);
  } catch {
    return undefined;
  }
  return memoSync(`dfs-sim:history:${stamp}`, 3600, () => (existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : undefined));
};

/** The simulated slate for a date, or a note saying why there is none. */
export async function slateSim(dateParam?: string): Promise<SlateSim | { note: string; date?: string }> {
  const h = history();
  if (!h) return { note: "The simulator's history is missing. Run node scripts/build-dfs-sim.mjs in web/." };
  const slate = await getSlate(dateParam);
  // This week and next: a Classic slate can span days and even weeks (Monday night plus Thursday), and its salary list
  // decides which games belong.
  // A slate only ever holds a team's next game, so each team keeps its earliest upcoming one.
  const next = await getSlate(shiftDate(slate.date, 7));
  const claimed = new Set<string>();
  const games = [...slate.weekGames, ...next.weekGames]
    .filter((g) => g.status === "upcoming")
    .sort((x, y) => x.kickoff.localeCompare(y.kickoff))
    .filter((g) => {
      if (claimed.has(g.home.short) || claimed.has(g.away.short)) return false;
      claimed.add(g.home.short);
      claimed.add(g.away.short);
      return true;
    });
  if (!games.length) return { note: "No game on this date is still to kick off.", date: slate.date };
  const pool = await classicPool(slate.date, games);
  if (!pool.plays.length) return { note: pool.note ?? "No DraftKings Classic salaries for this date yet.", date: slate.date };

  const statusKey = pool.plays.map((p) => `${p.id ?? p.name}:${p.status ?? ""}`).join("|");
  return memo(`dfs-sim:${slate.date}:${pool.fetchedAt}:${seedOf(statusKey)}`, 1200, () => build(slate.date, games, pool, h));
}

async function build(
  date: string,
  games: Awaited<ReturnType<typeof getSlate>>["games"],
  pool: Awaited<ReturnType<typeof classicPool>>,
  h: NonNullable<ReturnType<typeof history>>,
): Promise<SlateSim> {
  const kickoffOf = new Map(games.map((g) => [g.id, g.kickoff]));
  const keyOf = (p: DfsPlay) => (p.pos === "DST" ? `DST-${p.team}` : (p.id ?? `${p.team}-${p.name}`));
  const base = pool.plays.map((p) => ({ play: p, key: keyOf(p), prior: p.pos === "DST" ? 1 : 1 - absenceOf(p.status) }));

  // Jev reads fresh news for anyone who might not play; without a key or news, his status prior stands.
  const candidates: NewsCandidate[] = base
    .filter((b) => b.play.pos !== "DST" && b.prior < 1 && b.play.id)
    .map((b) => ({
      id: b.play.id!,
      name: b.play.name,
      team: b.play.team,
      pos: b.play.pos as NewsCandidate["pos"],
      status: b.play.status ?? "Active",
      statusSource: "",
      prior: b.prior,
      kickoff: kickoffOf.get(b.play.gameId) ?? new Date().toISOString(),
      opponent: b.play.opp,
      proj: b.play.proj,
      // Healthy teammates only: two questionable receivers would otherwise name each other.
      teammates: base.filter((x) => x.play.team === b.play.team && x.play.pos === b.play.pos && x.key !== b.key && x.play.id && x.prior >= 1).map((x) => ({ id: x.play.id!, name: x.play.name, pos: x.play.pos })),
    }));
  const judged = candidates.length ? await newsJudgments(candidates).catch(() => new Map<string, NewsJudgment>()) : new Map<string, NewsJudgment>();

  const players: SimPlayer[] = base.map((b) => {
    const j = b.play.id ? judged.get(b.play.id) : undefined;
    return {
      key: b.key,
      name: b.play.name,
      pos: b.play.pos,
      team: b.play.team,
      opp: b.play.opp,
      gameId: b.play.gameId,
      salary: b.play.salary,
      proj: round1(b.play.proj * (j ? ROLE_MULTIPLIER[j.role] : 1)),
      pPlay: j?.pPlay ?? b.prior,
    };
  });
  // Backups for anyone who might sit: Jev's pick when it named one, else the best-projected teammates at the position
  // (three receivers share a receiver's work, one back or tight end takes the rest), half his projection in all.
  const byKey = new Map(players.map((p) => [p.key, p]));
  for (const p of players) {
    if (p.pPlay >= 1 || p.pos === "DST" || p.pos === "QB") continue;
    const pick = judged.get(p.key)?.beneficiaryId;
    const mates = players.filter((x) => x.team === p.team && x.pos === p.pos && x.key !== p.key).sort((a, b) => b.proj - a.proj);
    const takers = pick && byKey.has(pick) ? [byKey.get(pick)!] : mates.slice(0, p.pos === "WR" ? 3 : 1);
    if (takers.length) p.backups = takers.map((t) => ({ key: t.key, pts: round1((p.proj * NEXT_MAN_UP) / takers.length) }));
  }
  assignRoles(players);

  const seed = seedOf(`${date}|${pool.fetchedAt}`);
  const sim = simulateSlate(players, h, { n: N, seed });
  const lineups = buildLineups(players, sim, { seed });
  const statByKey = new Map(sim.players.map((s) => [s.key, s]));
  const slatePlayers: SlatePlayer[] = base.map((b, i) => {
    const sp = players[i];
    const j = b.play.id ? judged.get(b.play.id) : undefined;
    return {
      ...statByKey.get(sp.key)!,
      play: b.play,
      proj: sp.proj,
      pPlay: sp.pPlay,
      pPlaySource: j?.pPlaySource ?? "status",
      role: sp.role,
      jev: j && j.posts ? { role: j.role, roleConfidence: j.roleConfidence, jevPlay: j.jevPlay, posts: j.posts, beneficiary: j.beneficiaryId ? byKey.get(j.beneficiaryId)?.name : undefined } : undefined,
      backups: sp.backups?.map((x) => byKey.get(x.key)?.name ?? x.key),
    };
  });
  const playerByKey = new Map(slatePlayers.map((p) => [p.key, p]));
  const result: SlateSim = {
    date,
    source: pool.source,
    builtAt: new Date().toISOString(),
    n: sim.n,
    players: slatePlayers.sort((a, b) => b.median - a.median),
    lineups: lineups.map((l) => ({ ...l, players: l.keys.map((k) => playerByKey.get(k)!) })),
    jevCalls: [...judged.values()].filter((j) => j.posts > 0).length,
    calibration: { pass: Boolean(h.calibration?.pass), method: h.calibration?.method ?? "", worstSeasonOff: Object.fromEntries(Object.entries(h.calibration?.byPos ?? {}).map(([k, v]) => [k, v.worstSeasonOff])) },
  };
  try {
    mkdirSync(DK_DIR, { recursive: true });
    writeFileSync(path.join(DK_DIR, `${date}-sim.json`), JSON.stringify({ ...result, players: result.players.map(({ play, ...rest }) => ({ ...rest, name: play.name, team: play.team, pos: play.pos, salary: play.salary })), lineups: result.lineups.map((l) => ({ kind: l.kind, keys: l.keys, salary: l.salary, mean: l.mean, median: l.median, p90: l.p90, p99: l.p99 })) }));
  } catch {
    /* the disk copy is a convenience */
  }
  return result;
}
