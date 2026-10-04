"use client";

import { useEffect } from "react";

/**
 * Opens the <details> section a jump-bar link points at, on load and on every
 * hash change, then scrolls to it. Also opens any closed <details> wrapping the
 * target, so deep anchors inside a collapsed section still land.
 */
export function JumpOpener() {
  useEffect(() => {
    const open = (hash: string, scroll: boolean) => {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      let node: HTMLElement | null = el;
      while (node) {
        if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
        node = node.parentElement;
      }
      if (scroll) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
    };
    open(window.location.hash, true);
    const onHash = () => open(window.location.hash, true);
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#']") as HTMLAnchorElement | null;
      if (!a) return;
      // Same hash twice does not fire hashchange, so open on the click itself.
      open(a.getAttribute("href") ?? "", false);
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}
