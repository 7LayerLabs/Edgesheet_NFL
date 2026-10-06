/** Leaders board columns: label, definition, format. Shared by the Leaders page and the index. */
export type Tab = "passing" | "rushing" | "receiving" | "teams";
export type Col = { key: string; label: string; help: string; fmt?: (v: number) => string; lowerBetter?: boolean; side?: "off" | "def" };

export const f1 = (v: number) => v.toFixed(1);
export const f2 = (v: number) => v.toFixed(2);
export const f3 = (v: number) => (v > 0 ? "+" : "") + v.toFixed(2);
export const pc = (v: number) => `${v.toFixed(1)}%`;
export const sg = (v: number) => (v > 0 ? "+" : "") + v.toFixed(1);

export const COLS: Record<Exclude<Tab, "teams">, Col[]> = {
  passing: [
    { key: "games", label: "G", help: "Games with a dropback" },
    { key: "db", label: "Dropbacks", help: "Pass attempts, sacks, and scrambles" },
    { key: "yds", label: "Yds", help: "Passing yards" },
    { key: "td", label: "TD", help: "Passing touchdowns" },
    { key: "int", label: "INT", help: "Interceptions", lowerBetter: true },
    { key: "epa", label: "EPA", help: "Total expected points added on his dropbacks", fmt: f1 },
    { key: "epaPer", label: "EPA/DB", help: "EPA per dropback, sacks and scrambles included. The broadest single read on a passing game", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of dropbacks with EPA above zero: how often the play left the offense better off", fmt: pc },
    { key: "cpoe", label: "CPOE", help: "Completion % over expected (nflfastR model): completing harder throws than the depth and spot would predict", fmt: sg },
    { key: "adot", label: "aDOT", help: "Average depth of target in yards", fmt: f1 },
    { key: "sackRate", label: "Sack%", help: "Sacks per dropback", fmt: pc, lowerBetter: true },
    { key: "pressured", label: "Pressured%", help: "Dropbacks under pressure (PFR charting, a week behind)", fmt: pc, lowerBetter: true },
    { key: "p2s", label: "Press→Sack%", help: "Pressures that became sacks (PFR): pocket movement and getting rid of the ball", fmt: pc, lowerBetter: true },
    { key: "expl", label: "Expl%", help: "Dropbacks gaining 20+ yards", fmt: pc },
    { key: "neg", label: "Neg%", help: "Dropbacks that lost yards, were sacks, interceptions, or lost fumbles", fmt: pc, lowerBetter: true },
  ],
  rushing: [
    { key: "games", label: "G", help: "Games with a carry" },
    { key: "att", label: "Rush", help: "Designed runs (scrambles count as the quarterback's dropbacks)" },
    { key: "yds", label: "Yds", help: "Rushing yards" },
    { key: "ypc", label: "Yd/Rsh", help: "Yards per carry", fmt: f1 },
    { key: "td", label: "TD", help: "Rushing touchdowns" },
    { key: "epa", label: "EPA", help: "Total expected points added on his carries", fmt: f1 },
    { key: "epaPer", label: "EPA/Rsh", help: "EPA per carry", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of carries with EPA above zero: how often the run kept the offense on schedule. Steadier than yards per carry, which one long run can inflate", fmt: pc },
    { key: "expl", label: "Expl%", help: "Carries of 10+ yards", fmt: pc },
    { key: "stuff", label: "Stuff%", help: "Carries for zero or fewer yards", fmt: pc, lowerBetter: true },
    { key: "syPct", label: "Short%", help: "Third or fourth and 2 or fewer: share converted (3+ tries)", fmt: pc },
    { key: "ybc", label: "YBC/Rsh", help: "Yards before contact a carry (PFR): mostly the blocking", fmt: f1 },
    { key: "ryoe", label: "RYOE/Rsh", help: "Rush yards over expected a carry (NFL Next Gen tracking): mostly the runner", fmt: sg },
  ],
  receiving: [
    { key: "games", label: "G", help: "Games with a target" },
    { key: "tgt", label: "Tgt", help: "Targets" },
    { key: "rec", label: "Rec", help: "Catches" },
    { key: "yds", label: "Yds", help: "Receiving yards" },
    { key: "td", label: "TD", help: "Receiving touchdowns" },
    { key: "epa", label: "EPA", help: "Total expected points added on his targets", fmt: f1 },
    { key: "epaPer", label: "EPA/Tgt", help: "EPA per target", fmt: f3 },
    { key: "succ", label: "Success%", help: "Share of targets with EPA above zero", fmt: pc },
    { key: "tgtShare", label: "Tgt share", help: "His share of the team's targets", fmt: pc },
    { key: "airShare", label: "Air share", help: "His share of the team's intended air yards: who the downfield passing is built around", fmt: pc },
    { key: "adot", label: "aDOT", help: "Average depth of his targets in yards", fmt: f1 },
    { key: "catchPct", label: "Catch%", help: "Catches per target", fmt: pc },
    { key: "yacoe", label: "YACOE", help: "Yards after catch over expected per catch (nflfastR model)", fmt: sg },
    { key: "ydsSnap", label: "Yds/Snap", help: "Receiving yards per offensive snap, games with snap counts only (120+ snaps). Routes run are not in free data, so this stands in for yards per route run", fmt: f2 },
    { key: "sep", label: "Sep", help: "Average separation at the catch point in yards (NFL Next Gen, qualified players)", fmt: f1 },
    { key: "rz", label: "RZ tgt", help: "Targets inside the opponent's 20" },
  ],
};

export const TEAM_COLS: Col[] = [
  { key: "epaPer", label: "EPA/Play", help: "Expected points added per play. Defense: lower is better", fmt: f3 },
  { key: "succ", label: "Success%", help: "Plays with EPA above zero", fmt: pc },
  { key: "expl", label: "Expl%", help: "Runs of 10+ and pass plays of 20+", fmt: pc },
  { key: "neg", label: "Neg%", help: "Plays that lost yards, sacks, interceptions, lost fumbles", fmt: pc },
  { key: "dbEpa", label: "DB EPA", help: "EPA per dropback", fmt: f3 },
  { key: "rushEpa", label: "Rush EPA", help: "EPA per designed run", fmt: f3 },
  { key: "rushSucc", label: "Rush Succ%", help: "Success rate on designed runs", fmt: pc },
  { key: "earlyEpa", label: "Early EPA", help: "EPA per play on first and second down, before obvious passing downs", fmt: f3 },
  { key: "sackRate", label: "Sack%", help: "Sacks per dropback (offense allowed, defense made)", fmt: pc },
];
