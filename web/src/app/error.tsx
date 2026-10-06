"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary. One failing data source (CFBD, ESPN, NWS, the
 * Odds API) must never blank the whole page. Next renders this in place of the
 * page segment and keeps the layout, nav, and tab bar.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[page error]", error);
  }, [error]);

  return (
    <div className="card mt-6 border-l-4 border-l-brick p-6">
      <p className="eyebrow">Something broke</p>
      <h1 className="display mt-1 text-4xl font-extrabold text-chalk">This page could not load</h1>
      <p className="mt-2 max-w-2xl text-base text-chalk-2">
        A data source did not answer, or answered with something the page could not use. Nothing you did caused it. Try again in a few seconds; most of these clear on the second request.
      </p>
      {error?.message && (
        <p className="mono mt-2 break-words text-xs text-chalk-3">
          {error.message}
          {error.digest ? ` (${error.digest})` : ""}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => reset()} className="inline-flex items-center rounded border border-navy bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-chalk">
          Try again
        </button>
        <Link href="/" className="inline-flex items-center rounded border border-line bg-white px-4 py-2 text-sm font-semibold text-chalk transition-colors hover:border-navy">
          Back to the slate
        </Link>
      </div>
    </div>
  );
}
