import { isKnownUsageWindow } from "@agent-harness/contracts";
import type { Reading } from "@agent-harness/client-runtime";
import { classes } from "../ui/classes.js";

/** docs/specs/look.md §10.5: rings encode used share, with one drawing for status and Usage. */
export const UsageRing = ({ reading }: { readonly reading: Reading }) => {
  const used = reading.utilisation === null ? null : Math.max(0, Math.min(100, reading.utilisation * 100));
  const rejected = reading.pressure === "out";
  const share = rejected ? 100 : used ?? 0;
  const number = used === null ? (rejected ? "!" : "—") : String(Math.round(used));
  const tone = rejected || (used !== null && used >= 90) ? "text-signal" : used !== null && used >= 75 ? "text-amber" : used === null ? "text-ink-faint" : "text-mint";
  return (
    <svg role="img" aria-label={`${reading.label} ${reading.value}`} viewBox="0 0 36 36" width="24" height="24" className={classes("size-6 shrink-0 font-mono", tone)}>
      <circle cx="18" cy="18" r="16" fill="currentColor" opacity="0.12" />
      <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.2" />
      <circle data-usage-arc cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100" style={{ strokeDasharray: `${share} 100` }} transform="rotate(-90 18 18)" className="transition-[stroke-dasharray] duration-300 motion-reduce:transition-none" />
      <text x="18" y="18" textAnchor="middle" dominantBaseline="central" fill="currentColor" style={{ fontSize: number === "100" ? "12px" : "13.5px" }}>{number}</text>
    </svg>
  );
};

/** Detailed windows pair the same ring with a 4px bar and a percent/refusal label. */
export const WindowReading = ({ reading }: { readonly reading: Reading }) => {
  const width = reading.pressure === "out" ? 100 : Math.max(0, Math.min(100, (reading.utilisation ?? 0) * 100));
  const tone = reading.pressure === "out" || reading.pressure === "high" ? "text-signal" : reading.pressure === "raised" ? "text-amber" : reading.pressure === "low" ? "text-mint" : "text-ink-faint";
  return <>
    {isKnownUsageWindow(reading.window) && <><UsageRing reading={reading} />{" "}</>}
    <span aria-hidden="true" className="h-1 w-10 overflow-hidden rounded-full bg-wash-strong">
      <span className={classes("block h-full bg-current", tone)} style={{ width: `${width}%` }} />
    </span>
    <span className={tone}>{reading.value}</span>
  </>;
};
