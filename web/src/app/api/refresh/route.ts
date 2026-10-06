import { NextResponse } from "next/server";
import { forget } from "@/lib/memo";

/**
 * The game page's "Update now". POST {id} drops the cached injury and transaction feeds, the game, the day's slates,
 * and the DraftKings simulation, so the next render re-pulls ESPN and recomputes who is playing and the call. Once per
 * 30 seconds per game, so a page left clicking cannot hammer ESPN.
 */
const last = new Map<string, number>();
const MIN_GAP_MS = 30_000;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = String(body?.id ?? "");
  if (!/^[\w-]{1,40}$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const now = Date.now();
  const wait = (last.get(id) ?? 0) + MIN_GAP_MS - now;
  if (wait > 0) return NextResponse.json({ ok: false, retryInSeconds: Math.ceil(wait / 1000) }, { status: 429 });
  last.set(id, now);
  const dropped = forget("espn:injuries", "espn:transactions", `game:${id}`, "slate:", "dfs-sim:");
  return NextResponse.json({ ok: true, dropped, at: new Date(now).toISOString() });
}
