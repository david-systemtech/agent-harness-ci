import { X } from "lucide-react";
import type { SceneGeometry } from "../scene-registry.js";
import { Button } from "../../src/ui/button.js";

export const platform = "web";
export const presentation = { textSize: 16 };
export const geometry: readonly SceneGeometry[] = [
  { selector: "html", fontSize: 16 },
  { selector: "[data-foundation]", contentFits: true },
  { selector: "[data-foundation] button", hitArea: 44 },
  { selector: "[data-foundation-compact]", width: 28, height: 28 },
  { selector: "[data-foundation-row]", minimumHeight: 48, contentFits: true },
  { selector: "[data-foundation-header]", minimumHeight: 52, contentFits: true },
];

/** Compact painted controls and comfortable rows share one phone type/spacing layer. */
export default function PhoneFoundationSpecimen() {
  return <main data-foundation className="flex h-dvh flex-col gap-phone-4 overflow-y-auto bg-abyss p-phone-4 text-phone-body text-ink">
    <h1 className="text-phone-title font-semibold">Phone foundation</h1>
    <section aria-label="Type ramp" className="space-y-phone-2">
      <p className="text-phone-caption text-ink-muted">Caption · 12px</p>
      <p className="text-phone-label">Label · 14px</p>
      <p className="text-phone-body">Body · 16px</p>
      <p className="text-phone-title">Title · 20px</p>
      <p className="text-phone-display">Display · 30px</p>
      <code className="font-mono text-phone-label">src/example.ts</code>
    </section>
    <section aria-label="Buttons" className="flex items-center gap-phone-6 py-phone-2">
      <Button variant="default">Continue</Button>
      <Button size="icon-sm" data-foundation-compact aria-label="Close specimen"><X aria-hidden="true" /></Button>
    </section>
    <section aria-label="Rows">
      <div data-foundation-row className="flex min-h-[var(--phone-row-height)] items-center">Single line row</div>
      <div data-foundation-row className="flex min-h-[var(--phone-row-detail-height)] flex-col justify-center">
        <span>Row with detail</span><span className="text-phone-caption text-ink-muted">Comfortable spacing stays fixed.</span>
      </div>
    </section>
    <section aria-label="Sheet header" className="rounded-phone-control bg-panel p-phone-3">
      <header data-foundation-header className="flex min-h-[var(--phone-bar-height)] items-center justify-between gap-phone-4">
        <h2 className="text-phone-title font-semibold">Run settings</h2>
        <Button size="icon" aria-label="Close sheet"><X aria-hidden="true" /></Button>
      </header>
    </section>
  </main>;
}
