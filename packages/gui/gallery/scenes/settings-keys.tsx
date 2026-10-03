import { presetSettings, type SettingsKey } from "@agent-harness/contracts";
import { useState } from "react";
import { SettingField } from "../../src/settings/generic-editor.js";

const keys = ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays", "permissions.defaultCeiling"] as const satisfies readonly SettingsKey[];

/** Settings labels and all three generic forms, using the same fields as the live editor. */
export default function SettingsKeysScene() {
  const [values, setValues] = useState<Readonly<Record<string, unknown>>>(presetSettings);
  return <main className="min-h-screen bg-abyss p-6 text-ink">
    <section aria-label="Settings fields" className="mx-auto flex max-w-[768px] flex-col gap-3">
      <h1 className="text-sm font-semibold">Session settings</h1>
      {keys.map((key) => <SettingField key={key} name={key} value={values[key]} writable line={undefined} save={(value) => setValues((held) => ({ ...held, [key]: value }))} />)}
    </section>
  </main>;
}

/** look.md §12.2: body width cap; §5: 32px inputs and fixed 32×18.4 switch. */
export const geometry = [
  { selector: "section[aria-label='Settings fields']", width: 768, tolerance: 0.1 },
  { selector: "input, select", height: 32, tolerance: 0.1 },
  { selector: "[role=switch]", width: 32, height: 18.4, tolerance: 0.1 },
] as const;
export const ladders = ["light", "dark"] as const;
