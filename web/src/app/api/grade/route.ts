import { NextResponse } from "next/server";
import { gradesFor, myScore, removeGrade, setGrade } from "@/lib/grades";

/**
 * Derek's grades. GET ?playerId= returns his grades and score for one player.
 * POST {playerId, gameId?, date?, grade 1..5, note?, name?, team?, pos?, cls?} saves or replaces the
 * grade for that (player, game). DELETE {playerId, gameId?} removes one grade, or all of
 * the player's grades when gameId is omitted. Stored in data/grades.json.
 */
const ID = /^\d{1,12}$/;

export async function GET(req: Request) {
  const playerId = new URL(req.url).searchParams.get("playerId") ?? "";
  if (!ID.test(playerId)) return NextResponse.json({ error: "bad playerId" }, { status: 400 });
  return NextResponse.json({ playerId, grades: gradesFor(playerId), myScore: myScore(playerId) ?? null });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const playerId = String(body?.playerId ?? "");
  if (!body || !ID.test(playerId)) return NextResponse.json({ error: "bad playerId" }, { status: 400 });
  const grade = Number(body.grade);
  if (!Number.isFinite(grade) || grade < 1 || grade > 5) return NextResponse.json({ error: "grade must be 1 to 5" }, { status: 400 });
  const gameId = typeof body.gameId === "string" ? body.gameId : undefined;
  if (gameId && !/^[\w-]{0,40}$/.test(gameId)) return NextResponse.json({ error: "bad gameId" }, { status: 400 });
  const saved = setGrade({
    playerId,
    gameId,
    date: typeof body.date === "string" ? body.date : undefined,
    grade,
    note: typeof body.note === "string" ? body.note : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    team: typeof body.team === "string" ? body.team : undefined,
    pos: typeof body.pos === "string" ? body.pos : undefined,
    cls: typeof body.cls === "string" ? body.cls : undefined,
  });
  return NextResponse.json({ ok: true, grade: saved, myScore: myScore(playerId) ?? null, count: gradesFor(playerId).length });
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { playerId?: string; gameId?: string } | null;
  const playerId = String(body?.playerId ?? "");
  if (!ID.test(playerId)) return NextResponse.json({ error: "bad playerId" }, { status: 400 });
  const removed = removeGrade(playerId, body?.gameId || undefined);
  return NextResponse.json({ ok: true, removed, myScore: myScore(playerId) ?? null });
}
