/**
 * Beat feed: the last 3 days of posts and news about a game's two teams,
 * tagged to the radar players they mention. Free sources only, no keys.
 *
 *  - Bluesky public AppView (searchPosts, no auth)
 *  - Reddit via RSS (the JSON endpoints return 403 to server fetches; RSS works but is rate limited hard)
 *  - Google News RSS
 *  - YouTube: search link always; Data API embed only when YOUTUBE_API_KEY is set
 *
 * Every fetch has a 6 second timeout, failures are swallowed and reported in `sources`,
 * and every query is memoized for 15 minutes so a page never hammers a source.
 * Nothing here is a fact for our reports. It is context, and each item says what it is.
 */
import { memo } from "./memo";

export type FeedSource = "bluesky" | "reddit" | "news";
/** fan = a person on a social network or a subreddit; outlet = a publication or a reporter account; news = a news article. */
export type FeedKind = "fan" | "outlet" | "news";

export interface FeedItem {
  id: string;
  source: FeedSource;
  kind: FeedKind;
  author: string;
  outlet?: string;
  url: string;
  text: string;
  publishedAt: string;
  /** Radar player ids mentioned in the text. */
  tags: string[];
  /** School the query that found this item was about. */
  team: string;
  /** Community or feed the item came from, for display ("r/CFB", "r/clemsontigers"). */
  where?: string;
  /** Jev chips (judgeFeed): shown when the probability clears FEED_CHIP_MIN. Absent when Jev is off. */
  chips?: FeedChip[];
  /** Per tagged player, the raw Jev probabilities (judgeFeed). Absent when Jev is off. */
  judged?: Record<string, FeedJudgment>;
  /** Player ids the regex tagged but Jev said the post is not about (judgeFeed). Already removed from `tags`. */
  droppedTags?: string[];
}

export type FeedChip = "injury" | "availability" | "promoted" | "demoted";

/** Raw Jev probabilities for one (item, player) pair. Policy lives in judgeFeed, not here. */
export interface FeedJudgment {
  /** The post reports an injury to this player. */
  injury: number;
  /** The post reports availability news that is not an injury: out, suspended, questionable, transferring, back. */
  availability: number;
  /** Promoted, named the starter, or moved up the depth chart. */
  promoted: number;
  /** Demoted, benched, or moved down the depth chart. */
  demoted: number;
  /** A reporter or outlet praising the player's play. */
  praise: number;
  /** The post is about this player (same person, same team), not a namesake. */
  refersToPlayer: number;
}

export interface FeedPlayer {
  id: string;
  name: string;
  /** School name as CFBD spells it (matches Team.short). */
  team: string;
}

export interface SourceStatus {
  source: FeedSource;
  label: string;
  ok: boolean;
  count: number;
  note?: string;
}

export interface FeedResult {
  items: FeedItem[];
  sources: SourceStatus[];
  asOf: string;
  windowDays: number;
}

const WINDOW_DAYS = 3;
const TIMEOUT_MS = 6000;
const MEMO_SECONDS = 15 * 60;
const CAP = 60;
const UA = "EdgeSheet/1.0 (college football beat feed)";

/* ------------------------------------------------------------------ fetch */

async function get(url: string, accept: string): Promise<{ status: number; body: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: ctl.signal, cache: "no-store" });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------- tiny XML */

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripHtml(s: string): string {
  return decodeEntities(decodeEntities(s))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|table)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function blocks(xml: string, tag: "item" | "entry"): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

function tagAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : "";
}

/* ----------------------------------------------------------- team names */

/** Full names for search precision ("Kansas City Chiefs", never a bare "Chiefs"). Keyed by nickname, the join key everywhere. */
const FULL_NAME: Record<string, string> = {
  "Cardinals": "Arizona Cardinals",
  "Falcons": "Atlanta Falcons",
  "Ravens": "Baltimore Ravens",
  "Bills": "Buffalo Bills",
  "Panthers": "Carolina Panthers",
  "Bears": "Chicago Bears",
  "Bengals": "Cincinnati Bengals",
  "Browns": "Cleveland Browns",
  "Cowboys": "Dallas Cowboys",
  "Broncos": "Denver Broncos",
  "Lions": "Detroit Lions",
  "Packers": "Green Bay Packers",
  "Texans": "Houston Texans",
  "Colts": "Indianapolis Colts",
  "Jaguars": "Jacksonville Jaguars",
  "Chiefs": "Kansas City Chiefs",
  "Rams": "Los Angeles Rams",
  "Chargers": "Los Angeles Chargers",
  "Raiders": "Las Vegas Raiders",
  "Dolphins": "Miami Dolphins",
  "Vikings": "Minnesota Vikings",
  "Patriots": "New England Patriots",
  "Saints": "New Orleans Saints",
  "Giants": "New York Giants",
  "Jets": "New York Jets",
  "Eagles": "Philadelphia Eagles",
  "Steelers": "Pittsburgh Steelers",
  "Seahawks": "Seattle Seahawks",
  "49ers": "San Francisco 49ers",
  "Buccaneers": "Tampa Bay Buccaneers",
  "Titans": "Tennessee Titans",
  "Commanders": "Washington Commanders"
};

/** Team subreddits, all 32. */
const SUBREDDIT: Record<string, string> = {
  "Cardinals": "AZCardinals",
  "Falcons": "falcons",
  "Ravens": "ravens",
  "Bills": "buffalobills",
  "Panthers": "panthers",
  "Bears": "CHIBears",
  "Bengals": "bengals",
  "Browns": "Browns",
  "Cowboys": "cowboys",
  "Broncos": "DenverBroncos",
  "Lions": "detroitlions",
  "Packers": "GreenBayPackers",
  "Texans": "Texans",
  "Colts": "Colts",
  "Jaguars": "Jaguars",
  "Chiefs": "KansasCityChiefs",
  "Rams": "LosAngelesRams",
  "Chargers": "Chargers",
  "Raiders": "raiders",
  "Dolphins": "miamidolphins",
  "Vikings": "minnesotavikings",
  "Patriots": "Patriots",
  "Saints": "Saints",
  "Giants": "NYGiants",
  "Jets": "nyjets",
  "Eagles": "eagles",
  "Steelers": "steelers",
  "Seahawks": "Seahawks",
  "49ers": "49ers",
  "Buccaneers": "buccaneers",
  "Titans": "Tennesseetitans",
  "Commanders": "Commanders"
};

export function teamQuery(team: string): string {
  const full = FULL_NAME[team];
  return full ? `"${full}"` : `"${team}" NFL`;
}

/** Nicknames that other sports or common words also use; those need a football word nearby. */
const AMBIGUOUS = new Set(["Giants", "Cardinals", "Panthers", "Rams", "Jets", "Lions", "Bears", "Eagles", "Texans", "Titans", "Bills", "Browns", "Saints", "Chargers", "Jaguars", "Falcons", "Ravens", "Colts", "Dolphins", "Patriots", "Raiders", "Vikings", "Cowboys", "Broncos", "Chiefs", "Steelers", "Seahawks", "49ers", "Buccaneers", "Commanders", "Packers", "Bengals"]);

/** Does the text plausibly talk about this team? Keeps the Giants' pennant race out of a Giants football feed. */
function mentionsTeam(text: string, team: string): boolean {
  const t = text.toLowerCase();
  const full = FULL_NAME[team]?.toLowerCase();
  if (full && t.includes(full)) return true;
  if (!t.includes(team.toLowerCase())) return false;
  if (AMBIGUOUS.has(team)) return /\bnfl\b|football|quarterback|\bqb\b|touchdown|\bwr\b|\brb\b|coach|week \d|injur|practice|game thread|halftime|snap|sack|kickoff|playoff|draft/i.test(text);
  return true;
}

/* ------------------------------------------------------------- sources */

function since(): Date {
  return new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
}

function fresh(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d >= since() && d.getTime() <= Date.now() + 3600 * 1000;
}

interface BskyPost {
  uri: string;
  author: { handle: string; displayName?: string };
  record: { text?: string; createdAt?: string; bridgyOriginalText?: string; embed?: { external?: { title?: string; description?: string; uri?: string } } };
  embed?: { external?: { title?: string; description?: string; uri?: string } };
  likeCount?: number;
  repostCount?: number;
}

function bskyUrl(p: BskyPost): string {
  const rkey = p.uri.split("/").pop();
  return `https://bsky.app/profile/${p.author.handle}/post/${rkey}`;
}

const OUTLET_WORDS = /\b(wire|insider|news|sports|247|rivals|on3|espn|athletic|times|post|herald|tribune|gazette|journal|radio|network|report|beat|writer|reporter|columnist|podcast)\b/i;

function bskyKind(handle: string, displayName?: string): FeedKind {
  // A custom domain handle (reporter, outlet, bridged site) is an outlet account.
  if (!handle.endsWith(".bsky.social")) return "outlet";
  if (displayName && OUTLET_WORDS.test(displayName)) return "outlet";
  return "fan";
}

const BSKY_HOSTS = ["https://api.bsky.app", "https://public.api.bsky.app"];

async function bluesky(query: string, team: string): Promise<FeedItem[]> {
  return memo(`feed:bsky:${query}`, MEMO_SECONDS, async () => {
    const qs = `q=${encodeURIComponent(query)}&limit=50&sort=latest&since=${encodeURIComponent(since().toISOString())}`;
    // Both hosts at once, first good answer wins: one after the other cost up to 12 s when the first hung.
    const ask = async (host: string) => {
      const r = await get(`${host}/xrpc/app.bsky.feed.searchPosts?${qs}`, "application/json");
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body;
    };
    try {
      const body = await Promise.any(BSKY_HOSTS.map(ask));
      const data = JSON.parse(body) as { posts?: BskyPost[] };
      const out: FeedItem[] = [];
      for (const p of data.posts ?? []) {
        const ext = p.record.embed?.external ?? p.embed?.external;
        const text = [p.record.text, p.record.bridgyOriginalText, ext?.title, ext?.description].filter(Boolean).join(" ").trim();
        if (!text) continue;
        const at = p.record.createdAt ?? "";
        if (!fresh(at)) continue;
        const handle = p.author.handle;
        out.push({
          id: `bsky:${p.uri}`,
          source: "bluesky",
          kind: bskyKind(handle, p.author.displayName),
          author: p.author.displayName?.trim() || handle,
          outlet: handle.endsWith(".bsky.social") ? undefined : handle.replace(/\.web\.brid\.gy$/, ""),
          url: bskyUrl(p),
          text: text.replace(/\s+/g, " ").slice(0, 600),
          publishedAt: new Date(at).toISOString(),
          tags: [],
          team,
          where: "Bluesky",
        });
      }
      return out;
    } catch (e) {
      const why = e instanceof AggregateError ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join("; ") : e instanceof Error ? e.message : String(e);
      throw new Error(why || "Bluesky unavailable");
    }
  });
}

/** Reddit blocks unauthenticated JSON and rate-limits RSS hard. Back off for 10 minutes after any 429 or 403. */
let redditBlockedUntil = 0;

async function redditRss(url: string, where: string, team: string, mustMention: boolean): Promise<FeedItem[]> {
  return memo(`feed:reddit:${url}`, MEMO_SECONDS, async () => {
    if (Date.now() < redditBlockedUntil) throw new Error("Reddit backing off after a rate limit");
    const r = await get(url, "application/atom+xml, application/rss+xml, application/xml");
    if (r.status === 429 || r.status === 403) {
      redditBlockedUntil = Date.now() + 10 * 60 * 1000;
      throw new Error(`Reddit HTTP ${r.status}`);
    }
    if (r.status !== 200) throw new Error(`Reddit HTTP ${r.status}`);
    const out: FeedItem[] = [];
    for (const b of blocks(r.body, "entry")) {
      const title = stripHtml(tagText(b, "title"));
      const link = tagAttr(b, "link", "href");
      const author = tagText(b, "author").replace(/<[^>]+>/g, " ").match(/\/u\/([\w-]+)/)?.[1] ?? "redditor";
      const at = tagText(b, "published") || tagText(b, "updated");
      if (!title || !link || !fresh(at)) continue;
      const body = stripHtml(tagText(b, "content")).replace(/\[link\]|\[comments\]|submitted by.*$/gim, "").trim();
      const text = body && body !== title ? `${title}\n${body}` : title;
      if (mustMention && !mentionsTeam(text, team)) continue;
      out.push({
        id: `reddit:${link}`,
        source: "reddit",
        kind: "fan",
        author: `u/${author}`,
        url: link,
        text: text.replace(/[ \t]+/g, " ").slice(0, 600),
        publishedAt: new Date(at).toISOString(),
        tags: [],
        team,
        where,
      });
    }
    return out;
  });
}

async function redditSearch(team: string): Promise<FeedItem[]> {
  const q = encodeURIComponent(FULL_NAME[team] ?? team);
  return redditRss(`https://www.reddit.com/r/nfl/search.rss?q=${q}&restrict_sr=1&sort=new&t=week`, "r/nfl", team, true);
}

async function redditTeamSub(school: string): Promise<FeedItem[]> {
  const sub = SUBREDDIT[school];
  if (!sub) return [];
  return redditRss(`https://www.reddit.com/r/${sub}/new.rss`, `r/${sub}`, school, false);
}

async function googleNews(query: string, team: string): Promise<FeedItem[]> {
  return memo(`feed:news:${query}`, MEMO_SECONDS, async () => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${WINDOW_DAYS}d`)}&hl=en-US&gl=US&ceid=US:en`;
    const r = await get(url, "application/rss+xml, application/xml");
    if (r.status !== 200) throw new Error(`Google News HTTP ${r.status}`);
    const out: FeedItem[] = [];
    for (const b of blocks(r.body, "item")) {
      const rawTitle = tagText(b, "title");
      const outlet = tagText(b, "source") || rawTitle.split(" - ").pop()?.trim() || "";
      const title = outlet && rawTitle.endsWith(` - ${outlet}`) ? rawTitle.slice(0, -(outlet.length + 3)).trim() : rawTitle;
      const link = tagText(b, "link");
      const at = tagText(b, "pubDate");
      if (!title || !link || !fresh(at)) continue;
      out.push({
        id: `news:${link}`,
        source: "news",
        kind: "news",
        author: outlet || "News",
        outlet: outlet || undefined,
        url: link,
        text: title,
        publishedAt: new Date(at).toISOString(),
        tags: [],
        team,
        where: "Google News",
      });
    }
    return out;
  });
}

/* ------------------------------------------------------------- tagging */

const COMMON_SURNAMES = new Set(
  `smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young allen king wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts gomez phillips evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers gutierrez ortiz morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez wood james bennett gray mendoza ruiz hughes price alvarez castillo sanders patel myers long ross foster jimenez powell jenkins perry russell sullivan bell coleman butler henderson barnes gonzales fisher vasquez simmons romero jordan patterson alexander hamilton graham reynolds griffin wallace moreno west cole hayes bryant herrera gibson ellis tran medina aguilar stevens murray ford castro marshall owens harrison fernandez mcdonald woods washington kennedy wells vargas henry chen freeman webb tucker guzman burns crawford olson simpson porter hunter gordon mendez silva shaw snyder mason dixon munoz hunt hicks holmes palmer wagner black robertson boyd rose stone salazar fox warren mills meyer rice schmidt garza daniels ferguson nichols stephens soto weaver ryan gardner payne grant dunn kelley spencer hawkins arnold pierce vazquez hansen peters santos hart bradley knight elliott cunningham duncan armstrong hudson carroll lane riley andrews alvarado ray delgado berry perkins hoffman johnston matthews pena richards contreras willis carpenter lawrence sandoval guerrero george chapman rios estrada ortega watkins greene nunez wheeler valdez harper burke larson santiago maldonado morrison franklin carlson austin dominguez carr lawson jacobs obrien lynch singh vega bishop montgomery oliver jensen harvey williamson gilbert dean sims espinoza howell li wong reid hanson le mccoy garrett burton fuller wang weber welch rojas lucas marquez fields park yang little banks padilla day walsh bowman schultz luna fowler mejia davidson acosta brewer may holland juarez newman pearson curtis cortez douglas schneider joseph barrett navarro figueroa keller avila wade molina stanley hopkins campos barnett bates chambers caldwell beck lambert miranda byrd craig ayala lowe frazier powers neal leonard gregory carrillo sutton fleming rhodes shelton schwartz norris jennings watts duran walters cohen mcdaniel moran parks steele vaughn becker holt deleon barker terry hale leon hail benson haynes horton miles lyons pham graves bush thornton wolfe warner cabrera mckinney mann zimmerman dawson lara fletcher page mccarthy love robles cervantes solis erickson reeves chang klein salinas fuentes baldwin daniel simon velasquez hardy higgins aguirre lin cummings chandler sharp barber bowen ochoa dennis robbins liu ramsey francis griffith paul blair oconnor cardenas pacheco cross calderon quinn moss swanson chan rivas khan rodgers serrano fitzgerald rosales stevenson christensen alexander gill mack curry norman young cole`.split(/\s+/),
);

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Conservative: full name match always; "last name + same team" only when the last name is uncommon and 5+ letters. */
export function tagItem(text: string, team: string, players: FeedPlayer[]): string[] {
  const tags: string[] = [];
  const norm = text.replace(/[’‘]/g, "'");
  for (const p of players) {
    const parts = p.name.replace(/[’‘]/g, "'").trim().split(/\s+/);
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1].replace(/^(jr|sr|ii|iii|iv)\.?$/i, "") || parts[parts.length - 2];
    const first = parts[0];
    const full = new RegExp(`\\b${esc(first)}\\s+(?:[A-Z]\\.?\\s+)?${esc(last)}\\b`, "i");
    if (full.test(norm)) {
      tags.push(p.id);
      continue;
    }
    // First initial + last name ("D. Mensah") on the same team.
    const initial = new RegExp(`\\b${esc(first[0])}\\.\\s*${esc(last)}\\b`);
    if (p.team === team && initial.test(norm)) {
      tags.push(p.id);
      continue;
    }
    if (p.team === team && last.length >= 5 && !COMMON_SURNAMES.has(last.toLowerCase())) {
      const lastOnly = new RegExp(`\\b${esc(last)}\\b`);
      if (lastOnly.test(norm) && mentionsTeam(norm, team)) tags.push(p.id);
    }
  }
  return tags;
}

/* ------------------------------------------------------------- assemble */

function dedupe(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of items) {
    const u = it.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    const t = it.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    const k1 = `u:${u}`;
    const k2 = `t:${it.source}:${t}`;
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1);
    seen.add(k2);
    out.push(it);
  }
  return out;
}

const MAX_PLAYER_QUERIES = 8;

/** Newest first, but no single source may take more than half the feed, so headlines never bury the posts. */
function balance(sorted: FeedItem[]): FeedItem[] {
  const perSource = Math.ceil(CAP / 2);
  const used: Record<FeedSource, number> = { bluesky: 0, reddit: 0, news: 0 };
  const out: FeedItem[] = [];
  const spill: FeedItem[] = [];
  for (const it of sorted) {
    if (out.length >= CAP) break;
    if (used[it.source] < perSource) {
      used[it.source] += 1;
      out.push(it);
    } else spill.push(it);
  }
  for (const it of spill) {
    if (out.length >= CAP) break;
    out.push(it);
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function feedForTeams(schools: string[], players: FeedPlayer[] = []): Promise<FeedResult> {
  const teams = [...new Set(schools.filter(Boolean))].sort();
  const roster = players.filter((p) => p.id && p.name && p.name.includes(" "));
  const key = `feed:all:${teams.join("|")}:${roster.map((p) => p.id).sort().join(",")}`;
  return memo(key, MEMO_SECONDS, async () => {
    type Job = { source: FeedSource; label: string; run: () => Promise<FeedItem[]> };
    const jobs: Job[] = [];
    for (const t of teams) {
      jobs.push({ source: "bluesky", label: `Bluesky: ${t}`, run: () => bluesky(teamQuery(t), t) });
      jobs.push({ source: "news", label: `News: ${t}`, run: () => googleNews(`${teamQuery(t)} NFL`, t) });
      jobs.push({ source: "reddit", label: `r/nfl: ${t}`, run: () => redditSearch(t) });
      if (SUBREDDIT[t]) jobs.push({ source: "reddit", label: `r/${SUBREDDIT[t]}`, run: () => redditTeamSub(t) });
    }
    const named = roster.filter((p) => teams.includes(p.team)).slice(0, MAX_PLAYER_QUERIES);
    for (const p of named) {
      jobs.push({ source: "bluesky", label: `Bluesky: ${p.name}`, run: () => bluesky(`"${p.name}"`, p.team) });
      jobs.push({ source: "news", label: `News: ${p.name}`, run: () => googleNews(`"${p.name}" ${p.team}`, p.team) });
    }

    const settled = await Promise.allSettled(jobs.map((j) => j.run()));
    const bySource = new Map<FeedSource, SourceStatus>();
    const all: FeedItem[] = [];
    settled.forEach((s, i) => {
      const j = jobs[i];
      const st = bySource.get(j.source) ?? { source: j.source, label: SOURCE_LABEL[j.source], ok: false, count: 0 };
      if (s.status === "fulfilled") {
        st.ok = true;
        st.count += s.value.length;
        all.push(...s.value);
      } else {
        const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        st.note = st.note ?? (msg.includes("abort") ? "timed out" : msg);
      }
      bySource.set(j.source, st);
    });

    // Player-name queries can return items about another school's player with the same name; keep only items that mention a team or a player.
    const tagged = dedupe(all)
      .map((it) => ({ ...it, tags: tagItem(it.text, it.team, roster) }))
      .filter((it) => it.tags.length > 0 || teams.some((t) => mentionsTeam(it.text, t)))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const items = balance(tagged);

    return {
      items,
      sources: (["news", "bluesky", "reddit"] as FeedSource[]).map((s) => bySource.get(s) ?? { source: s, label: SOURCE_LABEL[s], ok: false, count: 0, note: "not queried" }),
      asOf: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
    };
  });
}

export const SOURCE_LABEL: Record<FeedSource, string> = { bluesky: "Bluesky", reddit: "Reddit", news: "News" };
export const KIND_LABEL: Record<FeedKind, string> = { fan: "Fan post", outlet: "Reporter or outlet", news: "News" };

/* ------------------------------------------------------------- YouTube */

export interface YouTubeHit {
  searchUrl: string;
  videoId?: string;
  title?: string;
  channel?: string;
  note?: string;
}

export async function youtubeFor(playerName: string, team: string): Promise<YouTubeHit> {
  const q = `${playerName} ${team} highlights 2026`;
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { searchUrl, note: "YOUTUBE_API_KEY not set; showing a search link instead of an embed." };
  return memo(`feed:yt:${q}`, 6 * 3600, async () => {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(q)}&key=${key}`;
      const r = await get(url, "application/json");
      if (r.status !== 200) return { searchUrl, note: `YouTube API HTTP ${r.status}` };
      const data = JSON.parse(r.body) as { items?: { id: { videoId: string }; snippet: { title: string; channelTitle: string } }[] };
      const hit = data.items?.[0];
      if (!hit) return { searchUrl, note: "No YouTube result." };
      return { searchUrl, videoId: hit.id.videoId, title: hit.snippet.title, channel: hit.snippet.channelTitle };
    } catch (e) {
      return { searchUrl, note: e instanceof Error ? e.message : "YouTube lookup failed" };
    }
  });
}

export function subredditFor(team: string): string | undefined {
  return SUBREDDIT[team];
}

/* ------------------------------------------------------------- Jev judgments */

import { batchNouls, jevAvailable } from "./jev";

/** A chip shows when its probability clears this. */
export const FEED_CHIP_MIN = 0.7;
/** A regex tag is dropped when Jev says the post is this unlikely to be about the player. */
export const FEED_TAG_MIN = 0.4;
const JUDGE_TTL_MS = 6 * 3600 * 1000;

const judgeCache = new Map<string, { at: number; value: FeedJudgment }>();

export const FEED_CHIP_LABEL: Record<FeedChip, string> = { injury: "Injury", availability: "Availability", promoted: "Promoted", demoted: "Demoted" };

/** Chips from one judgment, policy only. */
export function chipsFor(j: FeedJudgment): FeedChip[] {
  const out: FeedChip[] = [];
  if (j.injury >= FEED_CHIP_MIN) out.push("injury");
  if (j.availability >= FEED_CHIP_MIN) out.push("availability");
  if (j.promoted >= FEED_CHIP_MIN) out.push("promoted");
  if (j.demoted >= FEED_CHIP_MIN) out.push("demoted");
  return out;
}

const SOURCE_KIND_TEXT: Record<FeedKind, string> = {
  fan: "a fan's social post or forum thread (opinion, may be a rumor)",
  outlet: "a reporter or outlet account on a social network",
  news: "a news article headline",
};

/**
 * Ask Jev about every (item, tagged player) pair in ONE request (chunked only past 30 pairs),
 * then apply the policy: chips at >= 0.7, drop a tag under 0.4 on "about this player".
 * Items without tags are untouched. Results memoized per item id and player for 6 hours.
 * Returns the same items (new objects where judged). Never throws; without a key it returns the input.
 */
export async function judgeFeed(items: FeedItem[], players: FeedPlayer[], opts: { purpose?: string; ref?: string } = {}): Promise<FeedItem[]> {
  if (!jevAvailable()) return items;
  const byId = new Map(players.map((p) => [p.id, p]));
  type Pair = { item: FeedItem; player: FeedPlayer; key: string };
  const pending: Pair[] = [];
  const have = new Map<string, FeedJudgment>();
  const now = Date.now();
  for (const it of items) {
    for (const id of it.tags) {
      const p = byId.get(id);
      if (!p) continue;
      const key = `${it.id}|${id}`;
      const hit = judgeCache.get(key);
      if (hit && now - hit.at < JUDGE_TTL_MS) have.set(key, hit.value);
      else pending.push({ item: it, player: p, key });
    }
  }
  if (pending.length) {
    try {
      const rows = await batchNouls(
        pending.map(({ item, player }) => ({
          post: item.text,
          source_kind: SOURCE_KIND_TEXT[item.kind],
          author: item.author,
          player: { name: player.name, team: player.team, position: (player as FeedPlayer & { pos?: string }).pos ?? "unknown" },
        })),
        {
          injury: { q: "Does ITEM.post report an injury to ITEM.player (hurt, injured, a named body part, carted off, surgery, out with an injury)?", yes: "The post says this player is injured or hurt, or gives an injury status.", no: "No injury to this player is reported. Other players' injuries do not count." },
          availability: { q: "Does ITEM.post report availability news about ITEM.player other than an injury (suspended, out, doubtful, questionable, game-time decision, not traveling, transferring, dismissed, eligible, cleared, or returning)?", yes: "The post says whether this player will or will not play, or that he is leaving or returning.", no: "Nothing about whether this player is available." },
          promoted: { q: "Does ITEM.post report that ITEM.player moved UP: named the starter, promoted on the depth chart, or taking over a role?", yes: "He was promoted, named a starter, or is getting the job.", no: "No upward depth chart move is reported." },
          demoted: { q: "Does ITEM.post report that ITEM.player moved DOWN: benched, demoted, lost the starting job, or replaced?", yes: "He was benched, demoted, or replaced.", no: "No downward depth chart move is reported." },
          praise: { q: "Is ITEM.post a reporter or outlet praising how ITEM.player has played (performance, talent, draft stock), given ITEM.source_kind?", yes: "A reporter or outlet speaks well of this player's play or prospects.", no: "Not praise, or it comes from a fan rather than a reporter or outlet." },
          refersToPlayer: { q: "Is ITEM.post about ITEM.player, the player with that name on that team, rather than a different person with the same name or only a passing namesake mention?", yes: "The post is talking about this specific player at this team.", no: "A different person, a different team, or the name only appears in a list or as a namesake." },
        },
        { purpose: opts.purpose ?? "feed", ref: opts.ref, chunk: 30 },
      );
      if (rows) {
        rows.forEach((r, i) => {
          const j: FeedJudgment = { injury: r.injury, availability: r.availability, promoted: r.promoted, demoted: r.demoted, praise: r.praise, refersToPlayer: r.refersToPlayer };
          judgeCache.set(pending[i].key, { at: now, value: j });
          have.set(pending[i].key, j);
        });
      }
    } catch {}
  }
  if (!have.size) return items;
  return items.map((it) => {
    if (!it.tags.length) return it;
    const judged: Record<string, FeedJudgment> = {};
    const keep: string[] = [];
    const dropped: string[] = [];
    for (const id of it.tags) {
      const j = have.get(`${it.id}|${id}`);
      if (!j) {
        keep.push(id);
        continue;
      }
      judged[id] = j;
      if (j.refersToPlayer < FEED_TAG_MIN) dropped.push(id);
      else keep.push(id);
    }
    if (!Object.keys(judged).length) return it;
    const chips = new Set<FeedChip>();
    for (const id of keep) if (judged[id]) for (const c of chipsFor(judged[id])) chips.add(c);
    return { ...it, tags: keep, judged, chips: [...chips], ...(dropped.length ? { droppedTags: dropped } : {}) };
  });
}

/** True when the item carries an injury or availability chip. */
export const isAvailabilityItem = (it: FeedItem): boolean => Boolean(it.chips?.some((c) => c === "injury" || c === "availability"));

export interface AvailabilityNote {
  playerId: string;
  /** "Reported questionable" style lead, from the chip. */
  lead: string;
  /** Short quote from the post. */
  text: string;
  url: string;
  source: string;
  publishedAt: string;
  probability: number;
}

/**
 * For each player, the strongest injury or availability item (highest probability, then newest).
 * Only items judged at or above FEED_CHIP_MIN and about the player (>= FEED_TAG_MIN) count.
 */
export function availabilityNotes(items: FeedItem[]): Record<string, AvailabilityNote> {
  const best: Record<string, AvailabilityNote> = {};
  for (const it of items) {
    if (!it.judged) continue;
    for (const id of it.tags) {
      const j = it.judged[id];
      if (!j || j.refersToPlayer < FEED_TAG_MIN) continue;
      const p = Math.max(j.injury, j.availability);
      if (p < FEED_CHIP_MIN) continue;
      const lead = j.injury >= j.availability ? (j.demoted >= FEED_CHIP_MIN ? "Reported injured, benched" : "Reported injured") : j.promoted >= FEED_CHIP_MIN ? "Reported available, promoted" : "Reported availability news";
      const cur = best[id];
      if (cur && (cur.probability > p || (cur.probability === p && cur.publishedAt >= it.publishedAt))) continue;
      best[id] = { playerId: id, lead, text: it.text.replace(/\s+/g, " ").slice(0, 140), url: it.url, source: it.where ?? SOURCE_LABEL[it.source], publishedAt: it.publishedAt, probability: p };
    }
  }
  return best;
}
