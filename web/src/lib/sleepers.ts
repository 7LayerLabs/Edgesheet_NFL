/**
 * Sleepers by beat buzz: backs, receivers, tight ends, and quarterbacks the beat feed is talking about more than their
 * role suggests. Server-only.
 *
 * From the 3-day feed (src/lib/feed.ts, every skill player on the teams tagged by name): a candidate has 2+ posts and
 * either plays under 60% of his offense's snaps this season or inherits work from a teammate who is out (vacated.ts).
 * Jev reads the candidates' posts (judgeFeed, cached 6 hours): a "promoted" read lifts him to the top, and a player whose
 * buzz is mostly injury news is dropped (that is not a sleeper, it is a status). Top ten, each with up to three sources.
 */
import { judgeFeed, feedForTeams, type FeedItem, type FeedPlayer } from "./feed";
import { genPlayers } from "./generated";
import type { Vacated } from "./vacated";

export interface Sleeper {
  id: string;
  name: string;
  pos: string;
  team: string;
  posts: number;
  outlets: number; // posts from reporters, outlets, or news
  snap?: number; // offensive snap share this season, 0 to 1
  promoted: boolean;
  reasons: string[];
  sources: { url: string; label: string }[];
}

const SKILL = new Set(["QB", "RB", "WR", "TE"]);
const MIN_POSTS = 2;
const PART_TIME = 0.6;
const TOP = 10;

/**
 * The sleepers for some teams (nicknames). `players` are the names the feed searches (the same list the page's beat feed
 * uses, so the feed is fetched once); `vacated` adds the "inherits work" path by team.
 */
export async function sleepersFor(teams: string[], players: FeedPlayer[], vacated: Record<string, Vacated[]> = {}): Promise<Sleeper[]> {
  const feed = await feedForTeams(teams, players);
  const byId = new Map(genPlayers().map((p) => [p.id, p]));
  // Who inherits work: the top riser for each missing player.
  const inherits = new Map<string, string>();
  for (const list of Object.values(vacated)) for (const v of list) if (v.without?.risers[0]) inherits.set(v.without.risers[0].id, v.name);

  const count = new Map<string, FeedItem[]>();
  for (const it of feed.items) for (const id of it.tags) (count.get(id) ?? count.set(id, []).get(id)!).push(it);
  const candidates = [...count.entries()].filter(([id, items]) => {
    const p = byId.get(id);
    if (!p || !SKILL.has(p.pg ?? "") || !teams.includes(p.t) || items.length < MIN_POSTS) return false;
    return (p.u?.o ?? 0) < PART_TIME || inherits.has(id);
  });
  if (!candidates.length) return [];

  // Jev reads only the candidates' posts.
  const candPlayers: FeedPlayer[] = candidates.map(([id]) => ({ id, name: byId.get(id)!.n, team: byId.get(id)!.t }));
  const itemSet = [...new Set(candidates.flatMap(([, items]) => items))];
  const judged = await judgeFeed(itemSet, candPlayers, { purpose: "sleepers" }).catch(() => itemSet);
  const judgedById = new Map(judged.map((it) => [it.id, it]));

  const out: Sleeper[] = [];
  for (const [id, items0] of candidates) {
    const p = byId.get(id)!;
    const items = items0.map((it) => judgedById.get(it.id) ?? it).filter((it) => it.tags.includes(id)); // Jev may drop a namesake tag
    if (items.length < MIN_POSTS) continue;
    const reads = items.map((it) => it.judged?.[id]).filter((j): j is NonNullable<typeof j> => Boolean(j));
    const injuryShare = reads.length ? reads.filter((j) => j.injury >= 0.7).length / reads.length : 0;
    if (injuryShare >= 0.5) continue;
    const promoted = reads.some((j) => j.promoted >= 0.7);
    const outlets = items.filter((it) => it.kind !== "fan").length;
    const reasons: string[] = [];
    if (promoted) reasons.push("Jev: the beat reports him moving up (promoted, named the starter, or taking over a role)");
    if (inherits.has(id)) reasons.push(`Took on the most work the last times ${inherits.get(id)} sat`);
    reasons.push(`${items.length} posts in 3 days${outlets ? `, ${outlets} from reporters or outlets` : ""}`);
    if (p.u?.o !== undefined) reasons.push(`plays ${Math.round(p.u.o * 100)}% of the offense's snaps`);
    out.push({
      id,
      name: p.n,
      pos: p.p ?? p.pg ?? "",
      team: p.t,
      posts: items.length,
      outlets,
      snap: p.u?.o,
      promoted,
      reasons,
      sources: items.slice(0, 3).map((it) => ({ url: it.url, label: it.outlet ?? it.author ?? it.source })),
    });
  }
  return out.sort((a, b) => Number(b.promoted) - Number(a.promoted) || b.outlets - a.outlets || b.posts - a.posts).slice(0, TOP);
}
