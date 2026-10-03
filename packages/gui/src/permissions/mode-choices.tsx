import { confirmationOf, describeKey, type EnvironmentView } from "@agent-harness/client-runtime";
import { SETTINGS, settingForm, type Mode } from "@agent-harness/contracts";
import { Check, Shield, ShieldAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useSettingsValues } from "../settings/settings-values.js";

type ModeKey = "permissions.defaultCeiling" | "permissions.unattended.mode";
const LABELS: Readonly<Record<Mode, string>> = {
  plan: "Plan only",
  acceptEdits: "Accept file edits",
  auto: "Automatic review",
  bypassPermissions: "Bypass permissions",
};
const NOTES: Readonly<Record<Mode, string>> = {
  plan: "Plan without changing files.",
  acceptEdits: "Accept file edits; ask before other actions when the provider supports it.",
  auto: "Let the provider review actions automatically where supported.",
  bypassPermissions: "Run without permission checks. The denylist still applies.",
};

/** Environment choices retain the contract's modes and bypass acknowledgement. */
export const ModeChoices = ({ view, name, writable }: { readonly view: EnvironmentView; readonly name: ModeKey; readonly writable: boolean }) => {
  const settings = useSettingsValues(view.environmentId);
  const id = useId();
  const [asking, ask] = useState(false);
  const [line, say] = useState<string>();
  const form = settingForm(name);
  if (settings.values === null || form.kind !== "choice") return null;
  const save = (mode: Mode, acknowledged = false) => {
    if (!acknowledged && confirmationOf(name, mode) !== undefined) return ask(true);
    say(undefined);
    void settings.save(name, mode, acknowledged).then((answer) => !answer.ok && say(`Not saved: ${answer.line}`));
  };
  return <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
    <span id={id} className="flex items-center gap-1.5 text-xs font-medium"><Shield aria-hidden="true" className="size-4" />{SETTINGS[name].label}</span>
    <span className="break-all font-mono text-2xs text-ink-faint">{name}</span>
    <p className="text-2xs text-ink-muted">{describeKey(name)}</p>
    {name === "permissions.defaultCeiling" && <p className="text-2xs text-ink-faint">Requests above a connection's ceiling are clamped. Providers offer only the modes they support.</p>}
    <div role="radiogroup" aria-labelledby={id} className="flex flex-col gap-0.5 p-1.5">
      {form.options.map((option) => {
        const mode = option as Mode;
        const selected = settings.values?.[name] === mode;
        const Icon = mode === "bypassPermissions" ? ShieldAlert : Shield;
        return <label key={mode} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 ${selected ? "bg-wash-strong" : "hover:bg-wash"} ${!writable ? "opacity-50" : ""} ${mode === "bypassPermissions" ? "text-signal" : "text-ink"}`}>
          <input type="radio" name={id} aria-label={LABELS[mode]} aria-describedby={`${id}-${mode}`} title={`${LABELS[mode]} (Arrow keys to choose)`} checked={selected} disabled={!writable} onChange={() => save(mode)} className="mt-[3px] size-3.5 shrink-0 appearance-none rounded-full border border-line-strong checked:border-beam checked:bg-beam checked:shadow-[inset_0_0_0_3px_var(--panel)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-beam" />
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-col"><span className="text-xs font-medium">{LABELS[mode]}</span><code className="font-mono text-2xs text-ink-faint">{mode}</code><span id={`${id}-${mode}`} className={`text-2xs ${mode === "bypassPermissions" ? "text-signal" : "text-ink-faint"}`}>{NOTES[mode]}</span></span>
        </label>;
      })}
    </div>
    {line !== undefined && <p role="status" className="text-xs text-signal">{line}</p>}
    <Dialog open={asking} onOpenChange={ask}>
      {asking && <DialogContent title={`Set ${SETTINGS[name].label} to bypassPermissions?`} description={confirmationOf(name, "bypassPermissions")?.sentence}>
        <div className="flex justify-end gap-1.5"><DialogClose asChild><Button title="Cancel (Esc)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button></DialogClose>
          <Button variant="destructive" title="Set it (Enter or Space)" onClick={() => { ask(false); save("bypassPermissions", true); }}><Check aria-hidden="true" data-icon="inline-start" />Set it</Button></div>
      </DialogContent>}
    </Dialog>
  </div>;
};
