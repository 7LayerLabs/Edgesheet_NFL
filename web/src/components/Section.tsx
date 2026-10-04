import type { ReactNode } from "react";

/**
 * Collapsible report section built on native <details>, so it works with no
 * JavaScript. The summary row carries the eyebrow, the title, and a one-line
 * summary derived from the data. JumpOpener opens a section when the jump bar
 * links to it.
 */
export function Section({
  n,
  id,
  title,
  summary,
  defaultOpen = false,
  tone,
  children,
}: {
  n: string;
  id: string;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  /** Left rule color for state sections: live (green) and final (red). */
  tone?: "live" | "final" | "navy";
  children: ReactNode;
}) {
  const rule = tone === "live" ? "sec-live" : tone === "final" ? "sec-final" : tone === "navy" ? "sec-navy" : "";
  return (
    <details id={id} className={`sec scroll-mt-28 ${rule}`} open={defaultOpen}>
      <summary className="sec-head">
        <span className="sec-chevron" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">{n}</span>
          <span className="display mt-0.5 block text-2xl font-bold leading-tight text-chalk sm:text-4xl">{title}</span>
          {summary && <span className="sec-summary">{summary}</span>}
        </span>
      </summary>
      <div className="sec-body">{children}</div>
    </details>
  );
}

/** Small inline disclosure for residue: evidence ids, computation basis, coverage gaps. */
export function Fold({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <details className={`fold ${className}`}>
      <summary className="fold-head">
        <span className="fold-chevron" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </span>
        {label}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
