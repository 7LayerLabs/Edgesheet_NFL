/**
 * Small renditions of CDN images. The originals are full-size headshots (1 to 4 MB from nfl.com) and
 * 500 px logos, shown at 14 to 64 px. Both CDNs resize on request. No server imports: client components use this.
 */

/** A 128 px face crop of an nfl.com headshot, or ESPN's resized copy of an ESPN one. Other URLs pass through. */
export function smallHeadshot(url: string): string {
  if (url.startsWith("https://static.www.nfl.com/") && url.includes("/f_auto,q_auto/")) return url.replace("/f_auto,q_auto/", "/f_auto,q_auto,w_128,h_128,c_fill,g_face/");
  const espn = /^https:\/\/a\.espncdn\.com(\/i\/headshots\/[^?]+\.png)$/.exec(url);
  if (espn) return `https://a.espncdn.com/combiner/i?img=${espn[1]}&w=128&h=93&scale=crop&cquality=60`;
  return url;
}

/** ESPN team logo at 96 px (48 px at 2x, the largest place a logo shows). */
export const smallLogo = (abbr: string) => `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png&w=96&h=96`;
