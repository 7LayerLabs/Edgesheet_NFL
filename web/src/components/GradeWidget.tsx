"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Derek's grade for one player in one game: five stars and a one-line note.
 * A star tap saves at once; the note saves on Enter or blur. Shows the last
 * grade on file. Compact mode fits the bottom row of a ProspectCard.
 */
interface Saved {
  gameId: string;
  date: string;
  grade: number;
  note: string;
  at: string;
}

export function GradeWidget({
  playerId,
  gameId,
  date,
  name,
  team,
  pos,
  cls,
  compact = false,
}: {
  playerId: string;
  gameId?: string;
  date?: string;
  name?: string;
  team?: string;
  pos?: string;
  cls?: string;
  compact?: boolean;
}) {
  const [grades, setGrades] = useState<Saved[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const key = gameId || date || "";
  const current = grades?.find((g) => (g.gameId || g.date) === key) ?? null;
  const last = grades?.[0] ?? null;

  useEffect(() => {
    let alive = true;
    fetch(`/api/grade?playerId=${encodeURIComponent(playerId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { grades?: Saved[] } | null) => {
        if (!alive) return;
        const list = j?.grades ?? [];
        setGrades(list);
        const mine = list.find((g) => (g.gameId || g.date) === key);
        if (mine?.note) setNote(mine.note);
      })
      .catch(() => alive && setGrades([]));
    return () => {
      alive = false;
    };
  }, [playerId, key]);

  async function save(grade: number, noteText?: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, gameId, date, grade, note: noteText ?? note, name, team, pos, cls }),
      });
      const j = (await r.json()) as { ok?: boolean; grade?: Saved; error?: string };
      if (!r.ok || !j.grade) throw new Error(j.error ?? "save failed");
      const saved = j.grade;
      setGrades((prev) => {
        const rest = (prev ?? []).filter((g) => (g.gameId || g.date) !== (saved.gameId || saved.date));
        return [saved, ...rest].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!current) return;
    setBusy(true);
    try {
      await fetch("/api/grade", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ playerId, gameId: key }) });
      setGrades((prev) => (prev ?? []).filter((g) => (g.gameId || g.date) !== key));
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  const starSize = compact ? "h-4 w-4" : "h-6 w-6";
  const lastText = last ? `${last.grade} of 5 on ${fmt(last.date)}${last.note ? `: ${last.note}` : ""}` : null;

  return (
    <div className={compact ? "flex flex-col gap-1" : "card flex flex-col gap-2 p-4"}>
      <div className="flex flex-wrap items-center gap-2">
        {!compact && <span className="eyebrow">My grade</span>}
        <div className="flex items-center" role="radiogroup" aria-label="Grade 1 to 5">
          {[1, 2, 3, 4, 5].map((n) => {
            const on = (current?.grade ?? 0) >= n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={current?.grade === n}
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
                disabled={busy}
                onClick={() => save(n)}
                className={`p-0.5 transition-colors ${on ? "text-warn" : "text-chalk-3 hover:text-warn"} disabled:opacity-60`}
              >
                <svg viewBox="0 0 24 24" className={starSize} fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" />
                </svg>
              </button>
            );
          })}
        </div>
        {current && (
          <button type="button" onClick={clear} disabled={busy} className="mono text-[10px] text-chalk-3 hover:text-brick" title="Remove this grade">
            clear
          </button>
        )}
        {!compact && grades && grades.length > 0 && (
          <span className="mono ml-auto text-xs text-chalk-3">{grades.length} game{grades.length === 1 ? "" : "s"} graded</span>
        )}
      </div>
      <input
        ref={noteRef}
        type="text"
        value={note}
        maxLength={240}
        placeholder={current ? "One line on what you saw" : "Tap a star, then a one-line note"}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (current) save(current.grade, note);
            noteRef.current?.blur();
          }
        }}
        onBlur={() => {
          if (current && note !== (current.note ?? "")) save(current.grade, note);
        }}
        className={`w-full rounded border border-line bg-white px-2 text-chalk placeholder:text-chalk-3 focus:border-navy focus:outline-none ${compact ? "py-0.5 text-xs" : "py-1.5 text-sm"}`}
      />
      {err ? (
        <p className="text-[11px] text-brick">{err}</p>
      ) : grades === null ? (
        <p className="mono text-[10px] text-chalk-3">loading grades</p>
      ) : lastText ? (
        <p className={`truncate text-chalk-3 ${compact ? "text-[10px]" : "text-xs"}`} title={lastText}>
          Last: {lastText}
        </p>
      ) : (
        !compact && <p className="text-xs text-chalk-3">No grade yet. Your grades feed the board at /board.</p>
      )}
    </div>
  );
}

function fmt(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
