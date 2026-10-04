"use client";

import { useState } from "react";

/**
 * Share the current page: native share sheet when the browser has one
 * (phones), otherwise copy the URL to the clipboard. The link carries the
 * game's Open Graph card (opengraph-image.tsx) so iMessage and Telegram show it.
 */
export function ShareButton({ title, text, size = "sm" }: { title: string; text?: string; size?: "sm" | "md" }) {
  const [state, setState] = useState<"idle" | "copied" | "shared" | "error">("idle");
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-2 text-sm";
  async function share() {
    const url = window.location.href;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, url });
        setState("shared");
      } else {
        await navigator.clipboard.writeText(url);
        setState("copied");
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setState("copied");
      } catch {
        setState("error");
      }
    }
    setTimeout(() => setState("idle"), 2500);
  }
  const label = state === "copied" ? "Link copied" : state === "shared" ? "Shared" : state === "error" ? "Could not share" : "Share";
  return (
    <button type="button" onClick={share} className={`inline-flex items-center gap-1.5 rounded border bg-white font-semibold transition-colors ${pad} ${state === "error" ? "border-brick text-brick" : "border-line-2 text-chalk hover:border-chalk-2"}`}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
      </svg>
      {label}
    </button>
  );
}
