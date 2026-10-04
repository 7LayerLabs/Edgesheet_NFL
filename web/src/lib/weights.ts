/**
 * Applied model parameters. data/weights.json carries two kinds of numbers:
 * the fitted sections written by scripts/backtest.mjs (only used behind
 * USE_FITTED_WEIGHTS=1) and the `applied` section written by scripts/tune.mjs,
 * which is ALWAYS read. Defaults equal the constants the model shipped with, so
 * a missing or broken file changes nothing. Every parameter has a hard bound;
 * a value outside it is ignored and the default is used.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Applied {
  /** Share of the margin carried by Elo; the unit edges fill the rest. */
  eloWeight: number;
  /** Net percentile points of unit edge per point of margin. */
  edgeDivisor: number;
  /** Percentile gap at which a unit matchup is called an edge instead of even. */
  edgeThreshold: number;
  /** Points added to the per-team scoring baseline (AVG_PPG) in the model total. */
  totalBaselineOffset: number;
  /** When the applied section was last written by the tuner. */
  updatedAt?: string;
}

export const APPLIED_DEFAULTS: Applied = { eloWeight: 0.6, edgeDivisor: 40, edgeThreshold: 20, totalBaselineOffset: 0 };

/** Hard bounds. The tuner never writes outside these and the reader never accepts outside these. */
export const APPLIED_BOUNDS: Record<keyof Omit<Applied, "updatedAt">, { min: number; max: number }> = {
  eloWeight: { min: 0.3, max: 0.9 },
  edgeDivisor: { min: 15, max: 80 },
  edgeThreshold: { min: 15, max: 40 },
  totalBaselineOffset: { min: -5, max: 5 },
};

export const WEIGHTS_FILE = path.join(process.cwd(), "data", "weights.json");

let cache: { stamp: string; value: Applied } | undefined;

function stamp(): string {
  try {
    return String(statSync(WEIGHTS_FILE).mtimeMs);
  } catch {
    return "missing";
  }
}

function inBounds(key: keyof typeof APPLIED_BOUNDS, v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= APPLIED_BOUNDS[key].min && v <= APPLIED_BOUNDS[key].max;
}

/** The applied parameters, re-read when the file changes. Never throws. */
export function appliedWeights(): Applied {
  const s = stamp();
  if (cache && cache.stamp === s) return cache.value;
  const value: Applied = { ...APPLIED_DEFAULTS };
  if (existsSync(WEIGHTS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(WEIGHTS_FILE, "utf8")) as { applied?: Partial<Applied> };
      const a = raw.applied ?? {};
      for (const k of Object.keys(APPLIED_BOUNDS) as (keyof typeof APPLIED_BOUNDS)[]) {
        if (inBounds(k, a[k])) value[k] = a[k] as number;
      }
      if (typeof a.updatedAt === "string") value.updatedAt = a.updatedAt;
    } catch {
      // keep defaults
    }
  }
  cache = { stamp: s, value };
  return value;
}
