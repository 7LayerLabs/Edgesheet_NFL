"use client";

import { useState, type ReactNode } from "react";
import { smallHeadshot } from "@/lib/images";

/**
 * ESPN headshot with a graceful fallback. Some ids return 404, so the
 * image swaps to the jersey circle the moment it fails to load. The parent
 * stays a server component; only this leaf is client-side.
 */
export function Headshot({ src, alt, className, fallback }: { src: string; alt: string; className: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={smallHeadshot(src)}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
