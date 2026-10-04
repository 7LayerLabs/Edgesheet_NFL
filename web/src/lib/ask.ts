/**
 * Ask the slate. A tool-using loop where every tool is one of our own
 * functions (slate, game, radar, forecast, record). The model answers only
 * from tool results, names the games and players it used, and says "not in
 * the data" when the data does not cover the question.
 */
import { etDate, getGame, getSlate } from "./slate";
import { buildPacket } from "./report";
import { radarBoard, type PosGroup } from "./radar";
import { historyStats, listEntries } from "./archive";
import { scoutScore, scoreTag } from "./score";
import { kickoffTime, spreadText } from "./format";
import { llmInfo, runTools, type ToolCallRecord, type ToolDef, type Unavailable, type Usage } from "./llm";
import type { Game } from "./types";

export interface AskResult {
  question: string;
  answer: string;
  notInData: boolean;
  games: { id: string; label: string }[];
  players: { id: string; label: string }[];
  calls: ToolCallRecord[];
  provider: string;
  model: string;
  usage: Usage;
  stoppedEarly?: string;
}

const GROUPS: PosGroup[] = ["QB", "RB", "WR", "TE", "OL", "DL", "EDGE", "LB", "CB", "S"];

const SYSTEM = `You answer questions about this week's NFL slate for EdgeSheet NFL, a game guide for people deciding what to watch.
You know nothing on your own. Use the tools, then answer only from what they returned.
Rules:
1. Never state a stat, line, rank, score, injury, or player that did not come back from a tool. If the tools do not cover the question, say "not in the data" and stop. Do not fill gaps from memory.
2. Keep answers short: two to five sentences, numbers inside the sentences, plain English, no emojis, no em dashes, no bullet lists unless the user asks for a list.
3. Explain and rank evidence. You may describe a model lean the way the tool describes it (a model, not a pick). Never give betting advice or tell the user what to bet.
4. Finish by calling the finish tool with the answer, the ids of every game you relied on, the ids of every player you named, and whether the answer is "not in the data". Set notInData true whenever any part of the question could not be answered from the tools, and say which part.
5. The data has an official injury report (game status and practice status), a depth chart rank, snap shares, and draft slots, but no career history and no quotes. Always tie a player to the team the tool gives for him, and check that the team matches the one the user asked about before answering.
Tool notes: getSlate lists a day's games (default today) with each game's single biggest unit matchup; getGame returns the full evidence for one game (all four matchups with percentile gaps, every radar name with evidence, style metrics); radarBoard lists players by lens (Rookie, Breakout, Watch) and position; getRecord is the accountability archive of locked calls and how they graded. Call getSlate first for anything about "today", "tonight", or "the slate". A spread is not a matchup: for questions about a matchup, a unit, a line of scrimmage, or who to watch, pick the two or three best candidates from the slate and call getGame on each before answering. Rank by the percentile gap and the strength label (mismatch beats clear edge beats edge), not by the point spread.`;

const slim = (g: Game) => ({
  id: g.id,
  game: `${g.away.rank ? `No. ${g.away.rank} ` : ""}${g.away.short} (${g.away.record}) at ${g.home.rank ? `No. ${g.home.rank} ` : ""}${g.home.short} (${g.home.record})`,
  division: g.division,
  kickoffEt: kickoffTime(g.kickoff),
  network: g.network,
  status: g.status,
  score: g.score && Number.isFinite(g.score.home) ? `${g.away.abbr} ${g.score.away}, ${g.home.abbr} ${g.score.home} (${g.score.clock})` : undefined,
  scoutScore: scoutScore(g.scoreComponents),
  tag: scoreTag(g),
  whyWatch: g.whyWatch,
  spread: g.market.spread ? spreadText(g.market.spread.team, g.market.spread.line) : "no line",
  total: g.market.total?.line,
  projection: g.projection ? `${g.projection.winner} by ${g.projection.margin.toFixed(1)}, ${Math.round(g.projection.winProb * 100)}%` : undefined,
  topMatchup: g.matchups[0] ? `${g.matchups[0].a} vs ${g.matchups[0].b}: ${g.matchups[0].strength ?? "even"}, advantage ${g.matchups[0].edge ?? "even"}. ${g.matchups[0].evidence}` : "not charted",
  topRadar: g.prospects.slice(0, 3).map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos, cls: p.cls, score: p.radar?.score, tier: p.tier })),
  styleLine: g.styleLine,
});

export async function ask(question: string): Promise<AskResult | Unavailable> {
  const q = question.trim().slice(0, 500);
  const info = llmInfo({ small: true });
  if ("unavailable" in info) return info;
  const gameLabels = new Map<string, string>();
  const playerLabels = new Map<string, string>();
  const noteGame = (g: Game) => gameLabels.set(g.id, `${g.away.short} at ${g.home.short}`);
  const notePlayer = (id: string, name: string, extra?: string) => playerLabels.set(id, extra ? `${name} (${extra})` : name);

  const tools: ToolDef[] = [
    {
      name: "getSlate",
      description: "Games on one day (ET), with Watch Score, line, projection, and the top radar names for each. Default is today.",
      inputSchema: { properties: { date: { type: "string", description: "YYYY-MM-DD in Eastern time. Omit for today." } }, additionalProperties: false },
      run: async (i) => {
        const s = await getSlate(typeof i.date === "string" ? i.date : undefined);
        let games = s.games;
        games = [...games].sort((a, b) => scoutScore(b.scoreComponents) - scoutScore(a.scoreComponents));
        for (const g of games) {
          noteGame(g);
          for (const p of g.prospects.slice(0, 3)) notePlayer(p.id, p.name, `${p.team} ${p.pos}`);
        }
        return { date: s.date, season: s.season, week: s.week?.week, count: games.length, games: games.slice(0, 60).map(slim), notes: s.notes };
      },
    },
    {
      name: "getGame",
      description: "Full evidence packet for one game: why watch, matchups with evidence, projection, radar prospects with their evidence, style profiles, forecast, market, storylines, and graded results if final.",
      inputSchema: { properties: { id: { type: "string", description: "Game id from getSlate." } }, required: ["id"], additionalProperties: false },
      run: async (i) => {
        const id = String(i.id ?? "");
        const g = await getGame(id);
        if (!g) return { error: `no game ${id}` };
        noteGame(g);
        for (const p of g.prospects) notePlayer(p.id, p.name, `${p.team} ${p.pos}`);
        const pk = buildPacket(g);
        return { id: g.id, game: pk.title, status: g.status, facts: pk.facts.map((f) => f.text), players: g.prospects.map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos })) };
      },
    },
    {
      name: "radarBoard",
      description: "Watch radar board: players ranked by evidence (production percentile, snap share, draft slot, breakout). Filter by lens (Rookie, Breakout, Watch), position group, or a name/team search.",
      inputSchema: {
        properties: {
          tier: { type: "string", enum: ["Rookie", "Breakout", "Watch"] },
          group: { type: "string", enum: GROUPS },
          q: { type: "string", description: "Name, team, or conference search" },
          limit: { type: "integer", description: "Default 15, max 40" },
        },
        additionalProperties: false,
      },
      run: (i) => {
        const limit = Math.min(40, Math.max(1, Number(i.limit) || 15));
        const list = radarBoard({
          tier: ["Rookie", "Breakout", "Watch"].includes(String(i.tier)) ? (i.tier as "Rookie") : undefined,
          group: GROUPS.includes(i.group as PosGroup) ? (i.group as PosGroup) : undefined,
          q: typeof i.q === "string" ? i.q : undefined,
          limit,
        });
        for (const p of list) notePlayer(p.id, p.name, `${p.team} ${p.pos}`);
        return list.map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos, cls: p.cls, draftClass: p.draftClass, score: p.score, tier: p.tier, stat: p.stat, evidence: p.evidence.map((e) => e.label + (e.note ? ` (${e.note})` : "")), size: p.size, level: p.classification }));
      },
    },
    {
      name: "getRecord",
      description: "Accountability archive: every locked pregame call (edges, radar names, projection, market) and how it graded after the final, plus season-wide hit rates.",
      inputSchema: { properties: { season: { type: "integer" }, limit: { type: "integer", description: "Default 25, max 60" }, gradedOnly: { type: "boolean" } }, additionalProperties: false },
      run: (i) => {
        const season = typeof i.season === "number" ? i.season : undefined;
        const entries = listEntries(season);
        const stats = historyStats(entries);
        let rows = entries;
        if (i.gradedOnly) rows = rows.filter((e) => e.postgame);
        const limit = Math.min(60, Math.max(1, Number(i.limit) || 25));
        for (const e of rows) gameLabels.set(e.gameId, `${e.pregame.away} at ${e.pregame.home}`);
        return {
          stats,
          entries: rows.slice(0, limit).map((e) => ({
            gameId: e.gameId,
            game: `${e.pregame.away} at ${e.pregame.home}`,
            kickoff: e.pregame.kickoff,
            scoutScore: e.pregame.scoutScore,
            pressurePoint: e.pregame.pressurePoint,
            projection: e.pregame.projection ? `${e.pregame.projection.winner} by ${e.pregame.projection.margin.toFixed(1)}` : undefined,
            spread: e.pregame.spread ? `${e.pregame.spread.team} ${e.pregame.spread.line}` : undefined,
            graded: e.postgame
              ? { score: e.postgame.score, pressurePoint: e.postgame.pressurePointVerdict, spreadResult: e.postgame.spreadResult, totalResult: e.postgame.totalResult, edges: e.postgame.edges.map((x) => `${x.a} vs ${x.b}: ${x.verdict} (${x.actual})`), prospects: e.postgame.prospects.map((p) => `${p.name}: ${p.verdict}`), projection: e.postgame.projectionResult }
              : undefined,
          })),
        };
      },
    },
    {
      name: "finish",
      description: "Deliver the final answer. Call this exactly once, at the end.",
      inputSchema: {
        properties: {
          answer: { type: "string", description: "Two to five sentences." },
          gameIds: { type: "array", items: { type: "string" }, description: "Ids of games the answer relies on." },
          playerIds: { type: "array", items: { type: "string" }, description: "Ids of players named in the answer." },
          notInData: { type: "boolean", description: "True when the data does not cover the question." },
        },
        required: ["answer", "gameIds", "playerIds", "notInData"],
        additionalProperties: false,
      },
      run: () => "done",
    },
  ];

  const res = await runTools(`Today is ${etDate()} (ET). Question: ${q}`, tools, { system: SYSTEM, purpose: "ask", small: true, maxSteps: 8, finishTool: "finish" });
  if ("unavailable" in res) return res;
  const fin = res.finish ?? {};
  let answer = String(fin.answer ?? res.text ?? "").trim();
  if (!answer) answer = res.stoppedEarly ? `No answer: ${res.stoppedEarly}.` : "Not in the data.";
  answer = answer.replace(/\s*[—–]\s*/g, ", ");
  const ids = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const gameIds = new Set(ids(fin.gameIds));
  for (const c of res.calls) if (c.name === "getGame" && typeof c.input.id === "string") gameIds.add(c.input.id);
  const games = [...gameIds].filter((id) => gameLabels.has(id)).map((id) => ({ id, label: gameLabels.get(id)! }));
  const players = ids(fin.playerIds).filter((id) => playerLabels.has(id)).map((id) => ({ id, label: playerLabels.get(id)! }));
  return {
    question: q,
    answer,
    notInData: Boolean(fin.notInData) || /^not in the data/i.test(answer),
    games,
    players,
    calls: res.calls.filter((c) => c.name !== "finish"),
    provider: res.provider,
    model: res.model,
    usage: res.usage,
    stoppedEarly: res.stoppedEarly,
  };
}
