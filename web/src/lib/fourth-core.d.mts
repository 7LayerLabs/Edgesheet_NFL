export interface FourthState {
  sd: number;
  gsr: number;
  yl: number;
  down: number;
  togo: number;
  toPos?: number;
  toDef?: number;
  home?: number;
  spread?: number;
}

export interface FourthModel {
  builtAt: string;
  seasons: number[];
  wp: { segments: number[][]; features: string[]; holdout?: unknown };
  go: { coef: number[]; gain: { lo: number; hi: number; mean: number; n: number }[]; attempts: number; byTogo?: unknown };
  fg: { coef: number[]; maxDistance: number; attempts: number; byDistance?: unknown };
  punt: { table: { lo: number; hi: number; oppYl: number; touchback: number; n: number }[]; punts: number };
}

export interface FourthOptions {
  go: { wp: number; pConvert: number; gain: number; touchdown: boolean };
  kick?: { wp: number; pMake: number; distance: number };
  punt?: { wp: number; oppYl: number };
  best: "go" | "kick" | "punt";
  margin: number;
  tossUp: boolean;
}

export const SEGMENTS: { name: string; hi: number; lo: number }[];
export const FEATURES: string[];
export const AFTER_SCORE_YL: number;
export const SECONDS: { go: number; kick: number; punt: number };
export function segmentOf(gsr: number): number;
export function features(st: FourthState): number[];
export function wp(model: FourthModel, st: FourthState): number;
export function convProb(model: FourthModel, togo: number, yl: number): number;
export function gainIfConverted(model: FourthModel, togo: number): number;
export function fgProb(model: FourthModel, dist: number): number;
export function puntOppYl(model: FourthModel, yl: number): number;
export function options(model: FourthModel, st: FourthState): FourthOptions;
export function callOf(playType: string): "go" | "kick" | "punt" | undefined;
export function stateOf(r: Record<string, string>): FourthState | undefined;
