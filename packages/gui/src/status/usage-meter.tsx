import { usageWindowMeterLabel } from "@agent-harness/contracts";
import { elapsedClock, gaugeOf, gaugeWho, meterReadingsOf, NO_PLAN_READING, NO_WINDOWS_READ, readingsOf, type UsageGauge, type UsageView } from "@agent-harness/client-runtime";
import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { UsageRing, WindowReading } from "./window-reading.js";

/** Provider windows only, pooled by the runtime's account identity; details refresh that same cache. */
export const UsageMeter = ({ environmentId, accountId }: { readonly environmentId: string; readonly accountId: string | null }) => {
  const runtime = useRuntime();
  const usage = useObservable(runtime.projections.usage);
  const gauge = gaugeOf(usage.gauges, environmentId, accountId);
  const readings = meterReadingsOf(gauge);
  const [open, setOpen] = useState(false);
  const refresh = () => {
    for (const id of new Set([environmentId, ...(gauge?.accounts.map((account) => account.environmentId) ?? [])])) runtime.requests.refresh(id, "accounts.usage", {});
  };
  return <span role="group" aria-label="Plan usage" className="ml-auto flex min-w-0 items-center">
    <Popover open={open} onOpenChange={(shown) => { setOpen(shown); if (shown) refresh(); }}>
      <Tooltip content={readings.map((reading) => `${reading.label} ${reading.value}`).join(" · ") || "Usage details"} keys="Enter to open">
        <PopoverTrigger asChild>
          <Button aria-label="Usage details" className="h-auto min-w-0 shrink gap-2 rounded-md px-0 py-0 text-2xs [&_svg]:size-6">
            {readings.length === 0 ? <Gauge aria-hidden="true" /> : readings.map((reading) => <span key={reading.window} className="flex min-w-0 items-center gap-1"><span className="min-w-0 truncate">{usageWindowMeterLabel(reading.window)}</span> <UsageRing reading={reading} /></span>)}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {open && <PopoverContent side="top" align="start" aria-label="Usage details" className="w-72 px-3">
        <UsageDetails environmentId={environmentId} gauge={gauge} usage={usage} refresh={refresh} />
      </PopoverContent>}
    </Popover>
  </span>;
};

/** Mounting only while open limits the reading-age/countdown clock to the visible popover. */
const UsageDetails = ({ environmentId, gauge, usage, refresh }: { readonly environmentId: string; readonly gauge: UsageGauge | undefined; readonly usage: UsageView; readonly refresh: () => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [tick, redraw] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const timer = clock.setTimeout(redraw, 1000);
    return () => timer.cancel();
  }, [clock, tick]);
  const now = runtime.environmentNow(environmentId).getTime();
  const age = gauge === undefined ? null : Math.max(0, now - Date.parse(gauge.readAt));
  const readings = readingsOf(gauge);
  const sources = usage.environments.filter((answer) => answer.environmentId === environmentId || gauge?.accounts.some((account) => account.environmentId === answer.environmentId));
  return <section className="flex flex-col gap-2 text-xs">
    <h3 className="font-medium text-ink">{gauge === undefined ? "Plan usage" : gaugeWho(gauge)}</h3>
    {readings.length === 0 && <p className="text-ink-faint">{gauge?.unavailableReason ?? (gauge === undefined ? NO_PLAN_READING : NO_WINDOWS_READ)}</p>}
    {readings.map((reading) => <div key={reading.window} className="flex flex-col gap-1">
      <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{reading.label}</span><WindowReading reading={reading} /></div>
      <p className="font-mono text-2xs text-ink-faint">{reading.resetsAt === null ? "Reset time unknown." : <>Resets <time dateTime={reading.resetsAt}>{reading.resetsAt}</time> · {now < Date.parse(reading.resetsAt) ? `in ${elapsedClock(Date.parse(reading.resetsAt) - now)}` : "reset time passed"}</>}</p>
    </div>)}
    {age !== null && <p aria-label="Reading age" className="text-ink-faint">Read {elapsedClock(age)} ago{age >= 360_000 ? " · stale" : ""} · <time dateTime={gauge?.readAt}>{gauge?.readAt}</time></p>}
    {sources.filter((answer) => answer.error !== null).map((answer) => <p key={answer.environmentId} className="text-amber">{answer.error?.message}</p>)}
    <p className="text-ink-faint">Current request context appears in the Context meter when supported.</p>
    <Tooltip content="Refresh usage" keys="Enter to refresh"><Button aria-label="Refresh usage" className="h-6 gap-1 self-start px-2 text-xs [&_svg]:size-3" onClick={refresh}><RefreshCw aria-hidden="true" />Refresh</Button></Tooltip>
  </section>;
};
