/**
 * Prints the beat feed for two teams. Run: npx tsx scripts/feed-check.ts [Team A] [Team B]
 * Default is Miami and Clemson. Tags against the radar players for those schools when generated data exists.
 */
import { feedForTeams, KIND_LABEL, type FeedPlayer } from "../src/lib/feed";

async function main() {
  const [a = "Miami", b = "Clemson"] = process.argv.slice(2);
  const players: FeedPlayer[] = [];
  try {
    const { radarForGame } = await import("../src/lib/radar");
    for (const t of [a, b]) players.push(...radarForGame(t, 6).map((r) => ({ id: r.id, name: r.name, team: r.team })));
  } catch (e) {
    console.log("(radar unavailable, tagging skipped:", e instanceof Error ? e.message : e, ")");
  }
  console.log(`Players for tagging: ${players.map((p) => `${p.name} (${p.team})`).join(", ") || "none"}\n`);
  const t0 = Date.now();
  const feed = await feedForTeams([a, b], players);
  console.log(`Fetched in ${Date.now() - t0} ms. Window ${feed.windowDays} days. ${feed.items.length} items.\n`);
  for (const s of feed.sources) console.log(`  ${s.label.padEnd(8)} ${s.ok ? "ok " : "FAIL"} ${String(s.count).padStart(3)} items ${s.note ? `(${s.note})` : ""}`);
  console.log();
  const names = new Map(players.map((p) => [p.id, p.name]));
  for (const it of feed.items) {
    const age = Math.round((Date.now() - new Date(it.publishedAt).getTime()) / 3600000);
    const tags = it.tags.map((id) => names.get(id) ?? id).join(", ");
    console.log(`[${it.source}] ${KIND_LABEL[it.kind]} · ${it.author}${it.outlet && it.outlet !== it.author ? ` (${it.outlet})` : ""} · ${age}h ago · ${it.team}${tags ? ` · TAGS: ${tags}` : ""}`);
    console.log(`   ${it.text.replace(/\s+/g, " ").slice(0, 160)}`);
    console.log(`   ${it.url}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
