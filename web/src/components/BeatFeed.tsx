import Link from "next/link";
import { feedForTeams, KIND_LABEL, SOURCE_LABEL, type FeedItem, type FeedPlayer, type FeedResult } from "@/lib/feed";

/** "4h ago", "2d ago". */
// eslint-disable-next-line react-hooks/purity
export function ago(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const KIND_TONE: Record<FeedItem["kind"], string> = {
  fan: "border-line bg-ink-2 text-chalk-2",
  outlet: "border-sky/40 bg-sky/10 text-sky",
  news: "border-navy/30 bg-navy text-white",
};

export function FeedItemRow({ item, names, now }: { item: FeedItem; names: Record<string, string>; now: number }) {
  const outlet = item.outlet && item.outlet !== item.author ? item.outlet : undefined;
  return (
    <li className="card p-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-chalk-3">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${KIND_TONE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
        <span className="font-semibold text-chalk">{item.author}</span>
        {outlet && <span className="mono">{outlet}</span>}
        <span className="mono">
          {ago(item.publishedAt, now)} on {item.where ?? SOURCE_LABEL[item.source]}
        </span>
        <span className="mono ml-auto text-chalk-3">{item.team}</span>
      </div>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1.5 block whitespace-pre-line text-[15px] leading-snug text-chalk hover:text-sky">
        {item.text}
      </a>
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.tags.map((id) => (
            <Link key={id} href={`/player/${id}`} className="rounded bg-warn px-2 py-0.5 text-[11px] font-semibold text-chalk hover:brightness-95">
              {names[id] ?? id}
            </Link>
          ))}
        </div>
      )}
    </li>
  );
}

export function SourceLine({ feed }: { feed: FeedResult }) {
  return (
    <p className="mono mt-2 text-[11px] text-chalk-3">
      Last {feed.windowDays} days.{" "}
      {feed.sources.map((s, i) => (
        <span key={s.source}>
          {i > 0 && " · "}
          <span className={s.ok ? "text-turf" : "text-brick"}>{s.label}</span> {s.ok ? `${s.count}` : s.note ? `off (${s.note})` : "off"}
        </span>
      ))}
    </p>
  );
}

export function FeedDisclaimer() {
  return (
    <p className="mt-2 text-xs text-chalk-3">
      Posts are context, not facts. Fan posts are opinion. Nothing here feeds the report, the radar, or the projection.
    </p>
  );
}

/**
 * Server component. Fetches the feed for the given schools and renders it sleepers.app style.
 * Wrap in <Suspense> so it streams in after the rest of the page.
 */
export async function BeatFeed({
  schools,
  players,
  limit,
  onlyTagged,
  emptyText,
}: {
  schools: string[];
  players: FeedPlayer[];
  limit?: number;
  /** Only show items that tag one of these player ids. */
  onlyTagged?: string[];
  emptyText?: string;
}) {
  const feed = await feedForTeams(schools, players);
  const names: Record<string, string> = {};
  for (const p of players) names[p.id] = p.name;
  let items = feed.items;
  if (onlyTagged && onlyTagged.length > 0) items = items.filter((it) => it.tags.some((t) => onlyTagged.includes(t)));
  const more = limit && items.length > limit ? items.length - limit : 0;
  if (limit) items = items.slice(0, limit);
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const allOff = feed.sources.every((s) => !s.ok);

  return (
    <div>
      <SourceLine feed={feed} />
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-chalk-3">
          {allOff ? "No source answered. The feed will retry in a few minutes." : emptyText ?? `Nothing found about ${schools.join(" or ")} in the last ${feed.windowDays} days.`}
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {items.map((it) => (
            <FeedItemRow key={it.id} item={it} names={names} now={now} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <a href={`/feed?${schools.map((s) => `team=${encodeURIComponent(s)}`).join("&")}`} className="mt-2 inline-block text-sm font-semibold text-sky">
          {more} more in the full feed →
        </a>
      )}
      <FeedDisclaimer />
    </div>
  );
}

export function BeatFeedFallback() {
  return (
    <div className="mt-3 grid gap-2" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card p-3.5">
          <div className="h-3 w-40 rounded bg-ink-2" />
          <div className="mt-2 h-4 w-full rounded bg-ink-2" />
          <div className="mt-1 h-4 w-3/4 rounded bg-ink-2" />
        </div>
      ))}
      <p className="mono text-[11px] text-chalk-3">Loading posts and news...</p>
    </div>
  );
}
