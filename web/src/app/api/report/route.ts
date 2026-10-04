import { NextResponse } from "next/server";
import { getGame } from "@/lib/slate";
import { buildPacket, generateReport, readReport, seasonOf } from "@/lib/report";
import { isUnavailable } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET ?id=: the evidence packet a report is checked against, and the cached report record. For auditing. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[\w-]+$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const game = await getGame(id);
  if (!game) return NextResponse.json({ error: "no such game" }, { status: 404 });
  const packet = buildPacket(game);
  return NextResponse.json({ gameId: id, title: packet.title, pregame: packet.pregame, evidenceAsOf: packet.evidenceAsOf, names: packet.names, facts: packet.facts, cached: readReport(seasonOf(game.kickoff), id) ?? null });
}

/** POST { id, force? }: write (or rewrite) the report for one game, validate it, cache it. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: string; force?: boolean } | null;
  if (!body?.id || !/^[\w-]+$/.test(body.id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const game = await getGame(body.id);
  if (!game) return NextResponse.json({ error: "no such game" }, { status: 404 });
  try {
    const out = await generateReport(game, { force: Boolean(body.force) });
    if (isUnavailable(out)) return NextResponse.json({ error: out.unavailable, unavailable: true }, { status: 503 });
    if (out.failed) return NextResponse.json({ ok: false, failed: out.failed, attempts: out.attempts, model: out.model }, { status: 422 });
    return NextResponse.json({ ok: true, model: out.model, provider: out.provider, words: out.words, attempts: out.attempts, costUsd: out.usage.costUsd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
