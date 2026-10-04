/**
 * Situational tendencies from play-by-play, as a side-by-side table (Team style
 * section) and a short cue list (matchups section). Server component: plain
 * props only, no node:fs.
 */
import type { SituationCue, SplitRow, TeamSituations } from "@/lib/situational";
import type { Team } from "@/lib/types";
import { asOf } from "@/lib/format";

const TABLE_KEYS: { key: string; label: string }[] = [
  { key: "earlyPass", label: "Early-down pass rate" },
  { key: "pdSucc", label: "Passing-downs success" },
  { key: "pdHavoc", label: "Havoc on passing downs" },
  { key: "thirdShortConv", label: "3rd and short (1-3) converted" },
  { key: "thirdMedConv", label: "3rd and medium (4-6) converted" },
  { key: "thirdLongConv", label: "3rd and long (7+) converted" },
  { key: "thirdMedPass", label: "3rd and medium pass rate" },
  { key: "rzPass", label: "Red zone pass rate" },
  { key: "rzTd", label: "Red zone TD per trip" },
  { key: "glTd", label: "Goal line TD per play" },
  { key: "xRush", label: "Explosive rush (12+)" },
  { key: "xPass", label: "Explosive pass (20+)" },
  { key: "trailPass", label: "Pass rate trailing by 9+" },
  { key: "leadPass", label: "Pass rate leading by 9+" },
  { key: "noHuddle", label: "No-huddle rate" },
  { key: "playsPerMin", label: "Plays per minute of possession" },
];

function Cell({ r }: { r?: SplitRow }) {
  if (!r || r.rate === null) return <td className="px-2 py-1 text-right text-chalk-3">unmeasured</td>;
  const pct = r.pct;
  const tone = r.kind !== "quality" || pct === undefined ? "text-chalk-2" : pct >= 75 ? "text-turf" : pct <= 25 ? "text-brick" : "text-chalk-2";
  return (
    <td className="px-2 py-1 text-right whitespace-nowrap">
      <span className={tone}>{r.value}</span>
      <span className="ml-2 inline-block w-14 text-chalk-3">{r.small ? `n=${r.n}` : r.rank ? `No. ${r.rank}` : ""}</span>
    </td>
  );
}

function UnitTable({ side, away, home, awayRows, homeRows }: { side: string; away: Team; home: Team; awayRows: SplitRow[]; homeRows: SplitRow[] }) {
  const keys = TABLE_KEYS.filter((k) => awayRows.some((r) => r.key === k.key) || homeRows.some((r) => r.key === k.key));
  return (
    <div className="card overflow-x-auto p-3">
      <p className="eyebrow">{side}</p>
      <table className="mono mt-1 w-full text-[13px]">
        <thead>
          <tr className="text-chalk-3">
            <th className="px-2 py-1 text-left font-normal">Situation</th>
            <th className="px-2 py-1 text-right font-normal">{away.abbr}</th>
            <th className="px-2 py-1 text-right font-normal">{home.abbr}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.key} className="border-t border-line">
              <td className="px-2 py-1 text-chalk-3">{k.label}</td>
              <Cell r={awayRows.find((r) => r.key === k.key)} />
              <Cell r={homeRows.find((r) => r.key === k.key)} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SituationsTable({ away, home, s }: { away: Team; home: Team; s: { home: TeamSituations; away: TeamSituations } }) {
  return (
    <div className="mt-6">
      <p className="eyebrow">Situations</p>
      <h3 className="display mt-1 text-2xl font-bold text-chalk">What each side does on the downs that decide drives</h3>
      <p className="mono mt-1 text-xs text-chalk-3">
        From play-by-play through {asOf(s.home.asOf)}. {away.abbr} {s.away.games} games, {s.away.plays.offense} offensive snaps. {home.abbr} {s.home.games} games, {s.home.plays.offense} offensive snaps. Rank is inside the division among teams with 15 or more plays in the split; n= marks a split under that sample. Pass rates and tempo rank 1 = most pass-heavy or fastest. Defense rows are what the unit allowed.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <UnitTable side="Offense" away={away} home={home} awayRows={s.away.offense} homeRows={s.home.offense} />
        <UnitTable side="Defense (allowed)" away={away} home={home} awayRows={s.away.defense} homeRows={s.home.defense} />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {[
          { t: away, s: s.away },
          { t: home, s: s.home },
        ].map(({ t, s: ts }) => (
          <div key={t.id} className="card p-4">
            <p className="eyebrow">{t.short}: who gets the ball</p>
            <Names label="Third-down targets" list={ts.thirdTargets} />
            <Names label="Third-down carriers" list={ts.thirdCarriers} />
            <Names label="Red zone targets" list={ts.rzTargets} />
            <Names label="Red zone carriers" list={ts.rzCarriers} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Names({ label, list }: { label: string; list: TeamSituations["thirdTargets"] }) {
  return (
    <p className="mt-1.5 text-sm text-chalk-2">
      <span className="text-chalk-3">{label}: </span>
      {list.length === 0
        ? "none parsed"
        : list.map((p, i) => (
            <span key={`${p.name}-${i}`}>
              {i > 0 && ", "}
              {p.name}
              {p.unmatched ? " (as written in play text)" : ""} <span className="mono text-xs text-chalk-3">{p.n}</span>
            </span>
          ))}
    </p>
  );
}

export function SituationalCues({ cues }: { cues: SituationCue[] }) {
  if (!cues.length) return null;
  return (
    <div className="card mt-3 p-4">
      <p className="eyebrow">Situational cues</p>
      <ul className="mt-2 grid gap-1.5">
        {cues.map((c) => (
          <li key={`${c.key}-${c.offTeam}`} className="flex gap-3 text-sm text-chalk-2">
            <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-navy" />
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
      <p className="mono mt-2 text-xs text-chalk-3">Play-by-play splits with at least 15 plays on both sides. Ranks are inside the 32.</p>
    </div>
  );
}
