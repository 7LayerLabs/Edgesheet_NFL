import type { ScoreTag } from "@/lib/score";

export function ScoutScore({ score, tag, size = "md" }: { score: number; tag?: ScoreTag; size?: "sm" | "md" | "lg" }) {
  const num = size === "lg" ? "text-7xl" : size === "md" ? "text-4xl" : "text-2xl";
  const tone = tag === "Hidden Gem" ? "text-turf" : tag === "Thin" ? "text-chalk-3" : "text-flag";
  return (
    <div className={`flex flex-col ${size === "lg" ? "gap-2" : "gap-1"}`}>
      <div className="flex items-baseline gap-2">
        <span className={`display font-extrabold leading-none ${num} ${tone}`}>{score}</span>
        {tag && (
          <span className={`eyebrow ${tag === "Hidden Gem" ? "text-turf" : ""}`}>{tag}</span>
        )}
      </div>
      <div className="meter" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Watch Score">
        <span style={{ width: `${score}%`, background: tag === "Hidden Gem" ? "var(--turf)" : undefined }} />
      </div>
    </div>
  );
}
