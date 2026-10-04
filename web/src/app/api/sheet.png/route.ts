import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/digests";
import { renderSheetPng } from "@/lib/render";
import { etDate } from "@/lib/slate";

export const dynamic = "force-dynamic";

/** GET /api/sheet.png?date=YYYY-MM-DD renders the Saturday sheet to PNG with headless Chrome and returns it. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("date");
  const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : etDate();
  try {
    const file = await renderSheetPng(date, baseUrl());
    return new NextResponse(new Uint8Array(readFileSync(file)), {
      headers: { "Content-Type": "image/png", "Content-Disposition": `inline; filename="edgesheet-${date}.png"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
