export function kickoffTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

export function asOf(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }) + " ET";
}

export function spreadText(team: string, line: number) {
  return `${team} ${line > 0 ? "+" : ""}${line}`;
}

export function moveText(open: number, cur: number) {
  const d = cur - open;
  if (d === 0) return "no move";
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} from ${open}`;
}

/** NFL kickoff windows in ET: early (London 9:30 AM and the 1 PM games), late afternoon (4:05 and 4:25), prime time. */
export type Window = "Early" | "Late afternoon" | "Prime time" | "Late night";

export function kickoffWindow(iso: string): Window {
  const h = Number(
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }),
  );
  if (h < 15) return "Early";
  if (h < 19) return "Late afternoon";
  if (h < 21) return "Prime time";
  return "Late night";
}

export function mlText(n: number) {
  return n > 0 ? `+${n}` : String(n);
}

/** Calendar date (YYYY-MM-DD) of an ISO timestamp in Eastern time. */
export function etDateOf(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
