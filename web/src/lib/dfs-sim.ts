/**
 * DraftKings slate simulator. Pure functions, no I/O; seeded, so the same inputs always simulate the same way.
 *
 * Each simulation draws one scoring shock per game (both teams share it), one offense shock and one pass-versus-run
 * tilt per team, and one link shock per pass catcher (WR1-3, TE1) that his quarterback also loads on. A player's
 * percentile is his loadings on those shocks plus his own noise; his outcome shape (data/backtest/dfs-sim.json, built by
 * scripts/build-dfs-sim.mjs from 2022 to 2025) turns the percentile into points: projection x a ratio for players,
 * projection + a difference for defenses. A player who sits in a draw (his play probability) scores 0 there, and his
 * backups pick up their share of his projection in that same draw.
 *
 * Lineups (DraftKings Classic: QB, 2 RB, 3 WR, TE, FLEX, DST, $50,000, players from 2+ games) are scored on the summed
 * draws, so correlation is in the math: Cash maximizes the median total, GPP the 90th percentile.
 */

export type SimPos = "QB" | "RB" | "WR" | "TE" | "DST";
export type SimRole = "QB1" | "RB1" | "RB2" | "WR1" | "WR2" | "WR3" | "TE1";
type L3 = { g: number; t: number; s: number };

export interface SimHistory {
  tiers: Record<SimPos, number[]>;
  shapes: Record<string, { n: number; q: number[] }>;
  loadings: Record<SimPos, L3> & { link: Record<"WR1" | "WR2" | "WR3" | "TE1", { p: number; q: number }> };
}

export interface SimPlayer {
  key: string; // unique: player id, or "DST-<team>"
  name: string;
  pos: SimPos;
  team: string;
  opp: string;
  gameId: string;
  salary: number;
  proj: number; // mean DK points, deterministic bumps included
  pPlay: number; // 0..1
  role?: SimRole; // by projection rank inside his team
  /** Who takes his work when he sits in a draw, and how many of his projected points each gets. */
  backups?: { key: string; pts: number }[];
}

export interface PlayerSim {
  key: string;
  mean: number;
  floor: number; // 10th percentile
  median: number;
  ceiling: number; // 90th percentile
  boom: number; // share of draws at 5x salary per $1,000 or more
  bust: number; // share of draws under 2x
  playRate: number;
}

export interface LineupSim {
  kind: "cash" | "gpp" | "gpp-bringback";
  keys: string[]; // slot order: QB, RB, RB, WR, WR, WR, TE, FLEX, DST
  salary: number;
  mean: number;
  median: number;
  p90: number;
  p99: number;
}

/* ------------------------------------------------------------ random numbers */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a string (the slate date and salary pull). */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function normals(rand: () => number) {
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const v = spare;
      spare = undefined;
      return v;
    }
    let u = 0;
    while (u === 0) u = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rand();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

function phi(z: number): number {
  // Standard normal CDF (Abramowitz and Stegun 7.1.26 on erf).
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + (x >= 0 ? y : -y));
}

/* ------------------------------------------------------------ shapes */

function tierKey(h: SimHistory, pos: SimPos, proj: number): string {
  const edges = h.tiers[pos] ?? [];
  let i = 0;
  while (i < edges.length && proj >= edges[i]) i++;
  return `${pos}${i}`;
}

/** Value of the outcome shape at percentile u (0..1), interpolating its 101 quantiles. */
function shapeAt(q: number[], u: number): number {
  const x = Math.min(100, Math.max(0, u * 100));
  const lo = Math.floor(x);
  const hi = Math.min(100, lo + 1);
  return q[lo] + (q[hi] - q[lo]) * (x - lo);
}

/* ------------------------------------------------------------ simulation */

export function simulateSlate(players: SimPlayer[], h: SimHistory, opts: { n?: number; seed?: number } = {}): { n: number; draws: Map<string, Float32Array>; players: PlayerSim[] } {
  const n = opts.n ?? 10000;
  const rand = mulberry32(opts.seed ?? 1);
  const gauss = normals(rand);
  const L = h.loadings;
  const games = [...new Set(players.map((p) => p.gameId))];
  const teams = [...new Set(players.flatMap((p) => [p.team, p.opp]))];
  const linkRoles = ["WR1", "WR2", "WR3", "TE1"] as const;

  // Per player: loadings, shape, and his own-noise weight, fixed once.
  const plan = players.map((p) => {
    const base = L[p.pos];
    const link = p.role && p.role in L.link ? L.link[p.role as keyof typeof L.link] : undefined;
    // A QB1 loads on each of his team's pass catchers' link shocks that are in the pool.
    const qbLinks = p.role === "QB1" ? linkRoles.filter((r) => players.some((x) => x.team === p.team && x.role === r)).map((r) => ({ r, q: L.link[r].q })) : [];
    const shared = base.g ** 2 + base.t ** 2 + base.s ** 2 + (link ? link.p ** 2 : 0) + qbLinks.reduce((a, x) => a + x.q ** 2, 0);
    const shape = h.shapes[tierKey(h, p.pos, p.proj)];
    return { p, base, link, qbLinks, own: Math.sqrt(Math.max(0, 1 - shared)), q: shape?.q, additive: p.pos === "DST" };
  });
  const keyIndex = new Map(players.map((p, i) => [p.key, i]));
  const draws = players.map(() => new Float32Array(n));
  const ratio = new Float64Array(players.length);
  const played = new Uint8Array(players.length);
  const G = new Map<string, number>();
  const T = new Map<string, number>();
  const S = new Map<string, number>();
  const P = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    for (const g of games) G.set(g, gauss());
    for (const t of teams) {
      T.set(t, gauss());
      S.set(t, gauss());
      for (const r of linkRoles) P.set(`${t}|${r}`, gauss());
    }
    for (let j = 0; j < plan.length; j++) {
      const { p, base, link, qbLinks, own, q, additive } = plan[j];
      // A defense loads on the OPPONENT's offense shock and its own team's tilt.
      let z = base.g * G.get(p.gameId)! + base.t * T.get(p.pos === "DST" ? p.opp : p.team)! + base.s * S.get(p.team)!;
      if (link && p.role) z += link.p * P.get(`${p.team}|${p.role}`)!;
      for (const x of qbLinks) z += x.q * P.get(`${p.team}|${x.r}`)!;
      z += own * gauss();
      const u = phi(z);
      const shape = q ? shapeAt(q, u) : additive ? 0 : 1;
      ratio[j] = shape;
      played[j] = rand() < p.pPlay ? 1 : 0;
      draws[j][i] = played[j] ? Math.max(additive ? -10 : 0, additive ? p.proj + shape : p.proj * shape) : 0;
    }
    // Players who sat: their backups take their share, scaled by the backup's own draw.
    for (let j = 0; j < plan.length; j++) {
      if (played[j] || !plan[j].p.backups) continue;
      for (const b of plan[j].p.backups!) {
        const k = keyIndex.get(b.key);
        if (k !== undefined && played[k]) draws[k][i] += b.pts * (plan[k].additive ? 1 : ratio[k]);
      }
    }
  }

  const out: PlayerSim[] = players.map((p, j) => {
    const d = draws[j];
    const sorted = Float32Array.from(d).sort();
    const at = (f: number) => sorted[Math.min(n - 1, Math.floor(f * n))];
    let sum = 0;
    let boom = 0;
    let bust = 0;
    const per = p.salary / 1000;
    for (let i = 0; i < n; i++) {
      sum += d[i];
      if (d[i] >= 5 * per) boom++;
      if (d[i] < 2 * per) bust++;
    }
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return { key: p.key, mean: r1(sum / n), floor: r1(at(0.1)), median: r1(at(0.5)), ceiling: r1(at(0.9)), boom: Math.round((boom / n) * 1000) / 1000, bust: Math.round((bust / n) * 1000) / 1000, playRate: Math.round(p.pPlay * 1000) / 1000 };
  });
  return { n, draws: new Map(players.map((p, j) => [p.key, draws[j]])), players: out };
}

/* ------------------------------------------------------------ lineups */

const SLOTS: { name: string; pos: SimPos[] }[] = [
  { name: "QB", pos: ["QB"] },
  { name: "RB", pos: ["RB"] },
  { name: "RB", pos: ["RB"] },
  { name: "WR", pos: ["WR"] },
  { name: "WR", pos: ["WR"] },
  { name: "WR", pos: ["WR"] },
  { name: "TE", pos: ["TE"] },
  { name: "FLEX", pos: ["RB", "WR", "TE"] },
  { name: "DST", pos: ["DST"] },
];
const CAP = 50000;

/** k-th smallest of a copy (quickselect). */
function kth(src: Float64Array, k: number): number {
  const a = Float64Array.from(src);
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/**
 * Cash, GPP, and GPP with a bring-back lineup from the simulated draws. Greedy start, then single-player swaps until
 * nothing improves, from several starts. The search scores the first `searchN` draws; the reported numbers use all.
 */
export function buildLineups(players: SimPlayer[], sim: { n: number; draws: Map<string, Float32Array>; players: PlayerSim[] }, opts: { searchN?: number; seed?: number } = {}): LineupSim[] {
  const M = Math.min(sim.n, opts.searchN ?? 4000);
  const stats = new Map(sim.players.map((s) => [s.key, s]));
  const byKey = new Map(players.map((p) => [p.key, p]));
  const rand = mulberry32((opts.seed ?? 7) + 11);

  const lineupFor = (kind: LineupSim["kind"]): LineupSim | undefined => {
    const score = (vals: Float64Array) => (kind === "cash" ? kth(vals, Math.floor(M * 0.5)) : kth(vals, Math.floor(M * 0.9)));
    const metric = (k: string) => (kind === "cash" ? stats.get(k)!.median : stats.get(k)!.ceiling);
    // Candidate pool per position: the best by the objective's own player number, plus the best values.
    const pool = (pos: SimPos, size: number) => {
      const ps = players.filter((p) => p.pos === pos && p.pPlay > 0.3);
      const best = [...ps].sort((a, b) => metric(b.key) - metric(a.key)).slice(0, size);
      const value = [...ps].sort((a, b) => metric(b.key) / b.salary - metric(a.key) / a.salary).slice(0, Math.ceil(size / 2));
      return [...new Set([...best, ...value])];
    };
    const cands: Record<SimPos, SimPlayer[]> = { QB: pool("QB", 10), RB: pool("RB", 16), WR: pool("WR", 22), TE: pool("TE", 10), DST: pool("DST", 10) };
    if (SLOTS.some((s) => s.pos.every((p) => !cands[p].length))) return undefined;

    const valid = (keys: string[]) => {
      const ps = keys.map((k) => byKey.get(k)!);
      if (new Set(keys).size !== keys.length) return false;
      if (ps.reduce((a, p) => a + p.salary, 0) > CAP) return false;
      if (new Set(ps.map((p) => p.gameId)).size < 2) return false;
      if (kind === "gpp-bringback") {
        const qb = ps[0];
        const stack = ps.slice(1, 8).some((p) => p.team === qb.team && (p.pos === "WR" || p.pos === "TE"));
        const back = ps.slice(1, 8).some((p) => p.team === qb.opp);
        if (!stack || !back) return false;
      }
      return true;
    };
    const totals = (keys: string[]) => {
      const t = new Float64Array(M);
      for (const k of keys) {
        const d = sim.draws.get(k)!;
        for (let i = 0; i < M; i++) t[i] += d[i];
      }
      return t;
    };

    // Greedy start in slot order by points per dollar, with a random tilt for restarts; fix the cap by downgrading.
    const start = (tilt: number, qb?: SimPlayer): string[] | undefined => {
      const keys: string[] = [];
      for (const [i, slot] of SLOTS.entries()) {
        if (i === 0 && qb) { keys.push(qb.key); continue; }
        const opts2 = slot.pos.flatMap((p) => cands[p]).filter((p) => !keys.includes(p.key));
        opts2.sort((a, b) => (metric(b.key) / b.salary) * (1 + tilt * (rand() - 0.5)) - (metric(a.key) / a.salary) * (1 + tilt * (rand() - 0.5)));
        if (!opts2.length) return undefined;
        keys.push(opts2[0].key);
      }
      return keys;
    };
    const improve = (keys: string[]) => {
      let cur = keys;
      let curTotals = totals(cur);
      let curScore = valid(cur) ? score(curTotals) : -Infinity;
      for (let pass = 0; pass < 8; pass++) {
        let improved = false;
        for (let s = 0; s < SLOTS.length; s++) {
          const out = sim.draws.get(cur[s])!;
          for (const c of SLOTS[s].pos.flatMap((p) => cands[p])) {
            if (cur.includes(c.key)) continue;
            const next = [...cur];
            next[s] = c.key;
            if (!valid(next)) continue;
            const inn = sim.draws.get(c.key)!;
            const t = new Float64Array(M);
            for (let i = 0; i < M; i++) t[i] = curTotals[i] - out[i] + inn[i];
            const sc = score(t);
            if (sc > curScore + 1e-9) {
              cur = next;
              curTotals = t;
              curScore = sc;
              improved = true;
              break;
            }
          }
        }
        if (!improved) break;
      }
      return { keys: cur, score: curScore };
    };

    let best: { keys: string[]; score: number } | undefined;
    const qbs = kind === "gpp-bringback" ? cands.QB.slice(0, 5) : [undefined];
    for (const qb of qbs) {
      for (let r = 0; r < 6; r++) {
        const s0 = start(r === 0 ? 0 : 0.6, qb);
        if (!s0) continue;
        // Over the cap: swap the priciest non-QB for the next cheaper option until it fits.
        for (let guard = 0; guard < 40 && s0.reduce((a, k) => a + byKey.get(k)!.salary, 0) > CAP; guard++) {
          const idx = s0.map((k, i) => ({ i, sal: byKey.get(k)!.salary })).filter((x) => x.i > 0).sort((a, b) => b.sal - a.sal)[0].i;
          const cheaper = SLOTS[idx].pos.flatMap((p) => cands[p]).filter((p) => !s0!.includes(p.key) && p.salary < byKey.get(s0![idx])!.salary).sort((a, b) => metric(b.key) - metric(a.key))[0];
          if (!cheaper) break;
          s0[idx] = cheaper.key;
        }
        const res = improve(s0);
        if (res.score > -Infinity && (!best || res.score > best.score)) best = res;
      }
    }
    if (!best) return undefined;
    // Report on every draw.
    const full = new Float64Array(sim.n);
    for (const k of best.keys) {
      const d = sim.draws.get(k)!;
      for (let i = 0; i < sim.n; i++) full[i] += d[i];
    }
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return {
      kind,
      keys: best.keys,
      salary: best.keys.reduce((a, k) => a + byKey.get(k)!.salary, 0),
      mean: r1(full.reduce((a, b) => a + b, 0) / sim.n),
      median: r1(kth(full, Math.floor(sim.n * 0.5))),
      p90: r1(kth(full, Math.floor(sim.n * 0.9))),
      p99: r1(kth(full, Math.floor(sim.n * 0.99))),
    };
  };

  return (["cash", "gpp", "gpp-bringback"] as const).map(lineupFor).filter((x): x is LineupSim => Boolean(x));
}

/** Roles inside each team by projection: QB1, RB1-2, WR1-3, TE1 (the shapes and links were fit on these). */
export function assignRoles(players: SimPlayer[]): void {
  const caps: Record<string, number> = { QB: 1, RB: 2, WR: 3, TE: 1 };
  const byTeamPos = new Map<string, SimPlayer[]>();
  for (const p of players) if (p.pos !== "DST") (byTeamPos.get(`${p.team}|${p.pos}`) ?? byTeamPos.set(`${p.team}|${p.pos}`, []).get(`${p.team}|${p.pos}`)!).push(p);
  for (const [k, ps] of byTeamPos) {
    const pos = k.split("|")[1];
    ps.sort((a, b) => b.proj - a.proj).slice(0, caps[pos]).forEach((p, i) => (p.role = `${pos}${i + 1}` as SimRole));
  }
}
