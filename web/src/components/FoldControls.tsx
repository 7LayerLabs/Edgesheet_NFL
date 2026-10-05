"use client";

import { useEffect, useState } from "react";

const folds = () => [...document.querySelectorAll<HTMLDetailsElement>("details.fold")];

/**
 * The game report's section bar: "Open all / Close all" for the collapsible sections, and links that open a section and
 * scroll to it. A #section link from anywhere (another page, a shared URL) opens that section on arrival too.
 */
export function FoldControls({ items }: { items: { id: string; label: string }[] }) {
  const [allOpen, setAllOpen] = useState(false);

  useEffect(() => {
    const sync = () => setAllOpen(folds().length > 0 && folds().every((d) => d.open));
    const openHash = () => {
      const el = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: "start" });
      }
    };
    openHash();
    sync();
    // "toggle" does not bubble; a capture listener still hears every section open and close.
    document.addEventListener("toggle", sync, true);
    window.addEventListener("hashchange", openHash);
    return () => {
      document.removeEventListener("toggle", sync, true);
      window.removeEventListener("hashchange", openHash);
    };
  }, []);

  const open = (id: string) => (e: React.MouseEvent) => {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLDetailsElement)) return;
    e.preventDefault();
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  };

  return (
    <nav className="jumpbar" aria-label="Sections">
      <button type="button" onClick={() => folds().forEach((d) => (d.open = !allOpen))}>
        {allOpen ? "Close all" : "Open all"}
      </button>
      {items.map(({ id, label }) => (
        <a key={id} href={`#${id}`} onClick={open(id)}>
          {label}
        </a>
      ))}
    </nav>
  );
}
