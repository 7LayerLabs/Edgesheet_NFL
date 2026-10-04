"use client";

import { useEffect } from "react";

/**
 * Game page error boundary. The game page pulls from six or seven sources
 * (CFBD, ESPN live, NWS, Odds API, archive, AI reports, plays). If one of them
 * throws past the per-section guards, the reader sees this instead of a blank
 * page, with a way back to the slate.
 */
export default function GameError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[game page error]", error);
  }, [error]);

  return (
    <div className="card mt-6 border-l-4 border-l-brick p-6">
      <p className="eyebrow">Game page</p>
      <h1 className="display mt-1 text-4xl font-extrabold text-chalk">This game could not be built</h1>
      <p className="mt-2 max-w-2xl text-base text-chalk-2">
        One of the feeds behind this page failed. The slate, radar, and record still work. Try again; if it keeps failing, the game id may be wrong or the data source is down.
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
        <a href="/" className="inline-flex items-center rounded border border-line bg-white px-4 py-2 text-sm font-semibold text-chalk transition-colors hover:border-navy">
          Back to the slate
        </a>
      </div>
    </div>
  );
}
