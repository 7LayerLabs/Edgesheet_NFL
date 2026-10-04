import { NextResponse } from "next/server";
import { listEntries } from "@/lib/archive";
import { NOT_A_PICK, baseUrl, leansDigest, longDate, morningSlate, postgameDigest } from "@/lib/digests";
import { renderSheetPages } from "@/lib/render";
import { etDate, getSlate } from "@/lib/slate";
import { sendMessage, sendPhotoAlbum, telegramMissing, telegramReady } from "@/lib/telegram";

export const dynamic = "force-dynamic";

type Kind = "slate" | "leans" | "grades" | "sheet";

/**
 * Send a digest to Telegram on demand. POST {type: "slate" | "leans" | "grades", date?: "YYYY-MM-DD"}.
 * Used by the "Send to Telegram" buttons. Responds 503 with the missing key when Telegram is not configured.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { type?: Kind; date?: string } | null;
  const type = body?.type;
  if (!type || !["slate", "leans", "grades", "sheet"].includes(type)) return NextResponse.json({ error: "type must be slate, leans, grades, or sheet" }, { status: 400 });
  if (!telegramReady()) return NextResponse.json({ error: telegramMissing() }, { status: 503 });

  if (type === "sheet") {
    // The Sunday sheet as a two-page album: render /sheet?print=1&part=1 and 2 with headless Chrome, then sendMediaGroup.
    const date = body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : etDate();
    try {
      const pngs = await renderSheetPages(date, baseUrl());
      const sent = await sendPhotoAlbum(pngs, `EdgeSheet, ${longDate(date)}. ${NOT_A_PICK} ${baseUrl()}/sheet?date=${date}`);
      return NextResponse.json({ ok: true, messages: sent.length, files: pngs, messageId: sent[0]?.message_id });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  let text: string | undefined;
  if (type === "grades") {
    // On demand: the ten most recently graded games, newest first on the page but oldest first in the message.
    const graded = listEntries()
      .filter((e) => e.postgame)
      .sort((a, b) => b.postgame!.capturedAt.localeCompare(a.postgame!.capturedAt))
      .slice(0, 10)
      .reverse();
    text = postgameDigest(graded) ?? "No graded games in the archive yet.";
  } else {
    const slate = await getSlate(body?.date);
    text = type === "slate" ? morningSlate(slate) : leansDigest(slate.games, slate.date);
  }
  try {
    const sent = await sendMessage(text, { parseMode: "HTML" });
    return NextResponse.json({ ok: true, messages: sent.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({ ready: telegramReady(), missing: telegramMissing() ?? null });
}
