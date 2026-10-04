import { useEffect, useRef, useState } from "react";
import type { AttentionTargetStatus } from "@agent-harness/contracts";
import { AttentionSettingsPane } from "../src/web/attention-settings.js";

/** Actual Settings leaf, bounded to the phone viewport without a desktop shell. */
export const phoneAttentionScene = (width: number, height: number, failed: boolean, textSize = 16) => function PhoneAttentionScene() {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(textSize / 14));
    const card = scroll.current?.querySelector("article");
    if (height <= 420 && scroll.current && card) scroll.current.scrollTop += card.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
  }, []);
  const [targets, setTargets] = useState<readonly AttentionTargetStatus[]>([
    { id: "phone-push", transport: "push", enabled: true, completion: false, global: false, state: failed ? "failed" : "pending", failure: failed ? "Delivery failed. Check the configured transport." : null },
    { id: "configured-fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "unavailable", failure: null },
  ]);
  return <main data-phone-attention style={{ width: `min(${width}px,100vw)`, maxWidth: 390, height: `min(${height}px,100dvh)`, fontSize: textSize, margin: "auto" }} className="flex min-w-0 flex-col overflow-hidden bg-abyss p-4 text-ink">
    <h1 className="mb-3 shrink-0 text-base font-semibold">Attention</h1>
    <div ref={scroll} data-attention-scroll className="min-h-0 overflow-y-auto">
      <AttentionSettingsPane targets={targets} admin={false} busy={false} onRefresh={() => undefined}
        onConfigure={(id, enabled, completion) => setTargets(current => current.map(target => target.id === id ? { ...target, enabled, completion } : target))}
        onRemove={id => setTargets(current => current.filter(target => target.id !== id))} />
    </div>
  </main>;
};
export const phoneAttentionGeometry = [
  { selector: "[data-phone-attention]", maxWidth: 390 },
  { selector: "[data-attention-settings]", contentFits: true },
  { selector: "[data-attention-settings] button", minimumHeight: 44 },
  { selector: "[data-attention-settings] label", minimumHeight: 44 },
];
