export const DST: { sd: number; tdLeague: number; safetyLeague: number; rateWeight: number; priorGames: number };
export function paPoints(pa: number): number;
export function expectedPa(implied: number, sd?: number): number;
export interface DstWeek { week: number; team: string; opp: string; sk: number; to: number; td: number; saf: number; give: number; sks: number }
export interface DstSeason { g: number; sk: number; to: number; td: number; saf: number; give: number; sks: number; dst: number }
export function dstPoints(w: DstWeek, oppScore: number): number;
export function teamWeeks(rows: { week: number; team: string; opp: string; sk: number; int: number; fr: number; dtd: number; sttd: number; saf: number; give: number; sks: number }[]): Map<string, DstWeek>;
export function seasonRates(weeks: Iterable<DstWeek>, oppScoreOf: (w: DstWeek) => number | undefined): Map<string, DstSeason>;
export function blendRate(now: DstSeason | undefined, prev: DstSeason | undefined, k: keyof DstSeason, priorGames?: number): number | undefined;
export function projectDst(
  team: { now?: DstSeason; prev?: DstSeason },
  opp: { now?: DstSeason; prev?: DstSeason },
  oppImplied: number,
): { proj: number; sacks: number; takeaways: number; tds: number; paPoints: number };
