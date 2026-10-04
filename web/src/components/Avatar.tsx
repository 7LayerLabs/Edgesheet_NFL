import Image from "next/image";
import { Headshot } from "./Headshot";

/** Same URL as headshotUrl() in src/lib/espn.ts, inlined so this file stays safe to import from client components. */
const headshotUrl = (id: string | number) => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;

/**
 * Player avatar. With a playerId it tries the ESPN headshot (nflverse espn_id);
 * when that 404s, or when there is no id, it shows the jersey
 * number in the team color. The team logo sits in the corner either way.
 */
export function Avatar({
  jersey,
  color,
  logo,
  size = "md",
  playerId,
  name,
  src,
}: {
  jersey?: number | null;
  color: string;
  logo?: string;
  size?: "sm" | "md" | "lg";
  playerId?: string | number;
  name?: string;
  /** Explicit headshot URL (nflverse headshot_url). Wins over the ESPN id. */
  src?: string;
}) {
  const dim = size === "lg" ? "h-16 w-16 text-2xl" : size === "md" ? "h-12 w-12 text-lg" : "h-9 w-9 text-sm";
  const badge = size === "lg" ? "h-7 w-7 -right-1 -bottom-1" : size === "md" ? "h-5 w-5 -right-0.5 -bottom-0.5" : "h-4 w-4 -right-0.5 -bottom-0.5";
  const jerseyCircle = (
    <span className="absolute inset-0 flex items-center justify-center rounded-full" style={{ background: color }}>
      <span className="display font-extrabold text-white" style={{ textShadow: "0 1px 2px rgba(0,0,0,.6)" }}>
        {jersey ? `#${jersey}` : "–"}
      </span>
    </span>
  );
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${dim}`} style={{ background: color }}>
      {src || (playerId && /^\d+$/.test(String(playerId))) ? (
        <Headshot
          src={src ?? headshotUrl(playerId!)}
          alt={name ?? ""}
          className="absolute inset-0 h-full w-full rounded-full bg-panel-2 object-cover object-top ring-1 ring-line"
          fallback={jerseyCircle}
        />
      ) : (
        jerseyCircle
      )}
      {logo && (
        <span className={`absolute flex items-center justify-center rounded-full bg-white ring-2 ring-white ${badge}`}>
          <Image src={logo} alt="" width={28} height={28} className="h-[80%] w-[80%] object-contain" unoptimized />
        </span>
      )}
    </span>
  );
}
