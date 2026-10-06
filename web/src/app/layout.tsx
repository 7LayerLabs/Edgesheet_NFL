import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed, Source_Sans_3, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import { NavLinks } from "@/components/NavLinks";
import "./globals.css";

const barlow = Barlow_Semi_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const source = Source_Sans_3({
  variable: "--font-source",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "EdgeSheet NFL",
  description: "Pick any NFL game and know why it is worth watching.",
};

export const viewport: Viewport = {
  themeColor: "#0d1f3c",
};

const I = {
  slate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 4v4M16 4v4"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v9l6 3"/></svg>',
  rank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19V5M4 19h16M8 15V9M12 15V6M16 15v-4"/></svg>',
  rookies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  dfs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  leaders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
};

const NAV = [
  { href: "/", label: "Slate", icon: I.slate },
  { href: "/radar", label: "Radar", icon: I.radar },
  { href: "/dfs", label: "DFS", icon: I.dfs },
  { href: "/leaders", label: "Leaders", icon: I.leaders },
  { href: "/standings", label: "Standings", icon: I.rank },
  { href: "/rookies", label: "Rookies", icon: I.rookies },
  { href: "/history", label: "Record", icon: I.record },
  { href: "/watchlist", label: "Watchlist", icon: I.star },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${barlow.variable} ${source.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full flex flex-col field">
        <header className="topbar sticky top-0 z-30">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="display flex items-center gap-2 text-3xl font-bold text-white">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white" aria-hidden>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v8l5 3" /></svg>
              </span>
              EdgeSheet <span className="ml-1 rounded bg-white/15 px-1.5 text-base font-semibold tracking-wider">NFL</span>
            </Link>
            <NavLinks items={NAV} variant="top" />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-5 sm:pb-24">{children}</main>
        <NavLinks items={NAV} variant="tabs" />
        <footer className="border-t border-line px-4 py-6 text-center text-xs text-chalk-3">
          Schedules, results, stats, play-by-play, injuries, and draft picks from nflverse. Live scores, broadcasts, and FPI from ESPN. Lines from The Odds API. Forecasts from the National Weather Service. Nothing is invented; gaps are labeled.
        </footer>
      </body>
    </html>
  );
}
