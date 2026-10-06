"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * A small "i" next to a stat label: hover shows what the stat means and what counts as good; on a phone a tap opens it
 * and a tap anywhere else (or Escape) closes it. The box opens below the nearest positioned container (give the stat's
 * card `relative`), so `align` ("left", "right", or classes per breakpoint) keeps it on screen against the card's edges.
 */
export function InfoTip({ label, what, context, align = "left" }: { label: string; what: string; context?: string; align?: "left" | "right" | string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const side = align === "left" ? "left-0" : align === "right" ? "right-0" : align;
  return (
    <span ref={box} className="inline-block align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={`What ${label} means`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-line-2 text-[10px] font-bold normal-case leading-none tracking-normal text-chalk-3 hover:border-sky hover:text-sky"
      >
        i
      </button>
      {open && (
        <span role="tooltip" id={id} className={`absolute top-full z-30 mt-1 block w-72 max-w-[calc(100vw-2.5rem)] rounded border border-line bg-panel p-3 text-left text-xs font-normal normal-case leading-snug tracking-normal text-chalk-2 shadow-lg ${side}`}>
          <span className="block font-semibold text-chalk">{label}</span>
          <span className="mt-1 block">{what}</span>
          {context && <span className="mt-2 block border-t border-line pt-2 text-chalk">{context}</span>}
        </span>
      )}
    </span>
  );
}
