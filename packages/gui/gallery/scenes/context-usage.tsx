import type { ContextFacts } from "@agent-harness/client-runtime";
import { ContextMeter } from "../../src/status/context-meter.js";

const cases: readonly { label: string; facts: ContextFacts }[] = [
  { label: "Before run", facts: { supported: true, model: "model-a", tokens: null, window: 1000, percent: null } },
  { label: "Known zero", facts: { supported: true, model: "model-a", tokens: 0, window: 1000, percent: 0 } },
  { label: "Actual run model changed", facts: { supported: true, model: "model-b", tokens: 800, window: 1000, percent: 80 } },
  { label: "Clamped share", facts: { supported: true, model: "model-b", tokens: 1200, window: 1000, percent: 100 } },
  { label: "Unknown scale", facts: { supported: true, model: "model-c", tokens: 400, window: null, percent: null } },
  { label: "Absent capability", facts: { supported: false, model: "model-d", tokens: null, window: null, percent: null } },
];

export default function ContextUsageScene() {
  return <section aria-label="Context cases" className="flex flex-col gap-4 p-4">
    {cases.map(({ label, facts }) => <div key={label} aria-label={label} className="flex items-center gap-3"><span className="text-xs">{label}</span><ContextMeter facts={facts} /></div>)}
  </section>;
}

export const geometry = [{ selector: '[aria-label="Context cases"] svg[role="img"]', width: 24, height: 24 }];
