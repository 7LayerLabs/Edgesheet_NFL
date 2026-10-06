/**
 * Storylines for the game page's third "Who to watch" slot: a player facing a team he played for, a visiting player in
 * his hometown, back in the state where he played college ball, or back in his home state. Server-only.
 *
 * Every line comes from data, never from a guess: teams played for from the nflverse weekly files (players.json past),
 * the drafting team from the draft file, birthplace and college from ESPN's athlete record, the college's city and state
 * from its home stadium in ESPN's college team record. ESPN records are fetched once per player and kept on disk
 * (data/espn/bios.json, data/espn/colleges.json; birthplaces do not change).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GenPlayer } from "./generated";

const DIR = path.join(process.cwd(), "data", "espn");
const BIOS = path.join(DIR, "bios.json");
const COLLEGES = path.join(DIR, "colleges.json");
/** Visiting players checked for a homecoming or college tie, most prominent first (each is one ESPN fetch, once ever). */
const BIO_LOOKUPS = 40;
/** How long a page render waits on ESPN for missing records; the rest keep loading in the background for the next view. */
const BIO_BUDGET_MS = 3000;

export interface Story {
  id: string;
  name: string;
  pos: string;
  team: string; // nickname
  kind: "revenge" | "hometown" | "college" | "home-state";
  label: string; // "Revenge game", "Homecoming", "College ties"
  text: string;
}

interface Bio {
  at: string;
  city?: string; // birthplace
  state?: string; // birthplace, US postal code
  collegeId?: string;
}
interface College {
  name?: string;
  city?: string; // the college's stadium
  state?: string;
}

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington, D.C.",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function readJson<T>(f: string): Record<string, T> {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, T>) : {};
  } catch {
    return {};
  }
}
function writeJson(f: string, v: unknown) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(f, JSON.stringify(v));
  } catch {
    /* the disk copy is a cache only */
  }
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Birthplace and college for ESPN athlete ids, from disk or ESPN (eight at a time). Waits at most BIO_BUDGET_MS for
 * missing records and returns what it has; the fetch finishes in the background and is on disk for the next view.
 */
async function bios(ids: string[]): Promise<Map<string, { born?: { city?: string; state?: string }; college?: College }>> {
  const cache = readJson<Bio>(BIOS);
  const colleges = readJson<College>(COLLEGES);
  const missing = ids.filter((id) => !cache[id]);
  const work = async () => {
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(
        missing.slice(i, i + 8).map(async (id) => {
          const a = await getJson<{ birthPlace?: { city?: string; state?: string }; college?: { $ref?: string } }>(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`);
          if (!a) return;
          const collegeId = a.college?.$ref?.match(/colleges\/(\d+)/)?.[1];
          cache[id] = { at: new Date().toISOString(), city: a.birthPlace?.city, state: a.birthPlace?.state, collegeId };
          if (collegeId && !colleges[collegeId]) {
            // A college's home: the city and state of its stadium in ESPN's college team record.
            const t = await getJson<{ displayName?: string; venue?: { address?: { city?: string; state?: string } } }>(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/teams/${collegeId}`);
            colleges[collegeId] = { name: t?.displayName, city: t?.venue?.address?.city, state: t?.venue?.address?.state };
          }
        }),
      );
    }
    writeJson(BIOS, cache);
    writeJson(COLLEGES, colleges);
  };
  if (missing.length) await Promise.race([work().catch(() => undefined), new Promise((r) => setTimeout(r, BIO_BUDGET_MS))]);
  return new Map(
    ids.filter((id) => cache[id]).map((id) => {
      const c = cache[id];
      return [id, { born: { city: c.city, state: c.state }, college: c.collegeId ? colleges[c.collegeId] : undefined }];
    }),
  );
}

/** "from 2023 to 2025", "in 2024", or "in 2019 and 2021" for a list of seasons. */
function seasonsText(ys: number[]): string {
  const s = [...ys].sort((a, b) => a - b);
  if (s.length === 1) return `in ${s[0]}`;
  const consecutive = s.every((y, i) => i === 0 || y === s[i - 1] + 1);
  return consecutive ? `from ${s[0]} to ${s.at(-1)}` : `in ${s.slice(0, -1).join(", ")} and ${s.at(-1)}`;
}

/**
 * A game's storylines, up to `max`, mixed by kind: the best revenge game, homecoming, college tie, and home-state return
 * first, then the second of each, and so on (three LSU linebackers do not take all three slots). One story per player.
 * Revenge covers both teams; the others are about the visiting team only (either team at a neutral site): a home player
 * is home every other week. `candidates` are the players expected to play, most prominent first.
 */
export async function gameStories(input: {
  home: string;
  away: string;
  neutral: boolean;
  season: number;
  venue?: { city?: string; state?: string }; // state as a US postal code; none abroad
  candidates: GenPlayer[];
  max: number;
}): Promise<Story[]> {
  const { home, away, neutral, season, venue, max } = input;
  const opponentOf = (t: string) => (t === home ? away : home);
  const pos = (p: GenPlayer) => p.p ?? p.pg ?? "";
  const story = (p: GenPlayer, kind: Story["kind"], label: string, text: string): Story => ({ id: p.id, name: p.n, pos: pos(p), team: p.t, kind, label, text });
  // Kickers, punters, and long snappers do not carry a storyline.
  const candidates = input.candidates.filter((p) => !["K", "P", "LS"].includes(p.pg ?? p.p ?? ""));

  // Revenge: he played for tonight's opponent within the last four seasons, or they drafted him.
  const revenge: Story[] = [];
  for (const p of candidates) {
    const opp = opponentOf(p.t);
    const ys = (p.past?.[opp] ?? []).filter((y) => y < season);
    const drafted = p.r.club === opp && !ys.length && Boolean(p.r.yr && p.r.yr < season);
    if (ys.some((y) => y >= season - 4)) revenge.push(story(p, "revenge", "Revenge game", `Faces the ${opp}, his team ${seasonsText(ys)}.`));
    else if (drafted) revenge.push(story(p, "revenge", "Revenge game", `Faces the ${opp}, who drafted him in ${p.r.yr}.`));
  }

  // Homecoming, college ties, home state: these need a US venue and ESPN's athlete records.
  const homecoming: Story[] = [];
  const college: Story[] = [];
  const homeState: Story[] = [];
  if (venue?.state && STATES[venue.state]) {
    const stateName = STATES[venue.state];
    const sameCity = (c?: string) => Boolean(c && venue.city && c.toLowerCase() === venue.city.toLowerCase());
    // The draft file's school when it is the one ESPN names ("LSU" over "LSU Tigers"); its first entry is his last school.
    const schoolOf = (p: GenPlayer, c: College) => {
      const listed = p.r.college?.split(";")[0].trim();
      return listed && c.name?.startsWith(listed) ? listed : c.name;
    };
    // Only players with an ESPN athlete id can be looked up (nflverse-only ids, mostly linemen, cannot).
    const travelers = candidates.filter((p) => (neutral || p.t === away) && /^\d+$/.test(p.id)).slice(0, BIO_LOOKUPS);
    const b = await bios(travelers.map((p) => p.id));
    for (const p of travelers) {
      const x = b.get(p.id);
      if (!x) continue;
      const { born, college: c } = x;
      const collegeHere = Boolean(c?.state === venue.state && c.name);
      // A birthplace, not "hometown": ESPN records where he was born, not where he grew up.
      if (born?.state === venue.state && sameCity(born.city)) {
        homecoming.push(story(p, "hometown", "Homecoming", `Born in ${born.city}${collegeHere ? `, and played college ball at ${schoolOf(p, c!)}` : ""}.`));
      } else if (collegeHere) {
        const school = schoolOf(p, c!);
        const native = born?.state === venue.state && born.city ? `, and he was born in ${born.city}` : "";
        college.push(story(p, "college", "College ties", sameCity(c!.city) ? `Plays in the city where he played college ball (${school})${native}.` : `Back in ${stateName}, where he played at ${school}${native}.`));
      } else if (born?.state === venue.state && born.city) {
        homeState.push(story(p, "home-state", "Homecoming", `Back in ${stateName}, where he was born (${born.city}).`));
      }
    }
  }

  const lists = [revenge, homecoming, college, homeState];
  const out: Story[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < max && lists.some((l) => l.length > i); i++) {
    for (const l of lists) {
      const x = l[i];
      if (x && !seen.has(x.id) && out.length < max) {
        out.push(x);
        seen.add(x.id);
      }
    }
  }
  return out;
}
