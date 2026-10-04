import { isTooEarly, type GatedValue } from "@/lib/gate";

/**
 * Renders a gated value. A real value renders as-is inside `className`; a
 * too-early marker renders as muted "too early (n of min)" so nobody reads a
 * three-game hit rate as a track record.
 */
export function Gated({ value, className }: { value: GatedValue; className?: string }) {
  if (isTooEarly(value)) {
    return (
      <span className="display block text-2xl font-semibold leading-tight text-chalk-3" title={`Needs ${value.min}, has ${value.n}`}>
        too early
        <span className="mono block text-xs font-normal tracking-normal">({value.n} of {value.min})</span>
      </span>
    );
  }
  return <span className={className}>{value}</span>;
}
