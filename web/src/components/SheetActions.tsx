"use client";

import { useState } from "react";

/**
 * Print and Send-to-Telegram controls for the Saturday sheet. The Telegram
 * button POSTs /api/notify with type "sheet"; the server renders the page to
 * PNG with headless Chrome and sends it as a photo. Hidden in print.
 */
export function SheetActions({ date, telegramEnabled }: { date: string; telegramEnabled: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  const base = "inline-flex items-center gap-1.5 rounded border bg-white px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60";
  const tone = state === "sent" ? "border-turf text-turf" : state === "error" ? "border-brick text-brick" : "border-line-2 text-chalk hover:border-chalk-2";

  async function send() {
    setState("sending");
    setErr("");
    try {
      const res = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "sheet", date }) });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setState("sent");
      setTimeout(() => setState("idle"), 5000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  return (
    <div className="sheet-actions flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => window.print()} className={`${base} border-line-2 text-chalk hover:border-chalk-2`}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="7" />
        </svg>
        Print
      </button>
      {telegramEnabled && (
        <span className="inline-flex flex-col items-start gap-0.5">
          <button type="button" onClick={send} disabled={state === "sending"} title={err || undefined} className={`${base} ${tone}`}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 2L11 13" />
              <path d="M22 2l-7 20-4-9-9-4z" />
            </svg>
            {state === "sending" ? "Rendering and sending" : state === "sent" ? "Sent" : state === "error" ? "Failed, retry" : "Send to Telegram"}
          </button>
          {state === "error" && err && <span className="max-w-[20rem] truncate text-[10px] text-brick">{err}</span>}
        </span>
      )}
      <a href={`/api/sheet.png?date=${date}`} className="text-xs text-sky hover:underline">PNG</a>
    </div>
  );
}
