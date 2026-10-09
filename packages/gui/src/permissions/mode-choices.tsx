import { MODE_WORDS, confirmationOf, describeKey, plainRefusal, type EnvironmentView } from "@agent-harness/client-runtime";
import { SETTINGS, settingForm, type Mode } from "@agent-harness/contracts";
import { Shield, ShieldAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Badge, Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { TechnicalDetails } from "../setup/details.js";
import { useDetails } from "../setup/use-details.js";
import { FieldError } from "./field-error.js";

type ModeKey = "permissions.defaultCeiling" | "permissions.unattended.mode";

/** The choice most people should keep, and each key's preset (setup-copy.md §5.12). */
const RECOMMENDED: Mode = "acceptEdits";

/** What the bypass confirmation says on scheduled runs (setup-copy.md §5.12). */
const NEVER_ASK = {
  heading: "Never ask on scheduled runs?",
  body: "Agents will act without asking and can do anything your account can, inside the sandbox you chose.",
} as const;

/**
 * How much agents may do without asking (setup-copy.md §5.12; permissions
 * spec, "Ceilings", "Attended and unattended runs"; ADR 0006): each mode
 * the key takes as a plain choice with its sentence, Edit files, ask for
 * the rest marked Recommended, Never ask in the warning tone, and the key
 * and the mode ids only in Details. Never ask on scheduled runs asks first,
 * and the agreement goes with the write. A refusal is an error in the
 * refusal mapper's words.
 */
export const ModeChoices = ({ view, name, writable }: { readonly view: EnvironmentView; readonly name: ModeKey; readonly writable: boolean }) => {
  const settings = useSettingsValues(view.environmentId);
  const details = useDetails();
  const id = useId();
  const [asking, ask] = useState(false);
  const [refused, say] = useState<{ readonly line: string; readonly details: readonly string[] }>();
  const form = settingForm(name);
  if (settings.values === null || form.kind !== "choice") return null;
  const current = settings.values[name] as Mode;
  const modes = form.options as readonly Mode[];
  const save = (mode: Mode, acknowledged = false) => {
    if (!acknowledged && confirmationOf(name, mode) !== undefined) return ask(true);
    say(undefined);
    void settings.save(name, mode, acknowledged).then((answer) => {
      if (answer.ok) return;
      say(answer.refusal === undefined ? { line: answer.line, details: [] } : plainRefusal(answer.refusal, MODE_WORDS[mode].label));
    });
  };
  return <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
    <span id={id} className="flex items-center gap-1.5 text-xs font-medium"><Shield aria-hidden="true" className="size-4" />{SETTINGS[name].label}</span>
    <p className="text-2xs text-ink-muted">{describeKey(name)}</p>
    <div role="radiogroup" aria-labelledby={id} className="flex flex-col gap-0.5 p-1.5">
      {modes.map((mode) => {
        const selected = current === mode;
        const warning = mode === "bypassPermissions";
        const Icon = warning ? ShieldAlert : Shield;
        const { label, note } = MODE_WORDS[mode];
        return <label key={mode} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 ${selected ? "bg-wash-strong" : "hover:bg-wash"} ${!writable ? "opacity-50" : ""} ${warning ? "text-amber" : "text-ink"}`}>
          <input type="radio" name={id} aria-label={label} aria-describedby={`${id}-${mode}`} title={`${label} (Arrow keys to choose)`} checked={selected} disabled={!writable} onChange={() => save(mode)} className="mt-[3px] size-3.5 shrink-0 appearance-none rounded-full border border-line-strong checked:border-beam checked:bg-beam checked:shadow-[inset_0_0_0_3px_var(--panel)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-beam" />
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{label}{mode === RECOMMENDED && <Badge variant="secondary">Recommended</Badge>}</span>
            <span id={`${id}-${mode}`} className={`text-2xs ${warning ? "text-amber" : "text-ink-faint"}`}>{note}</span>
          </span>
        </label>;
      })}
    </div>
    <TechnicalDetails {...details({ line: `${SETTINGS[name].label}: ${MODE_WORDS[current].label}.`, details: [`${name}: ${current}`, ...modes.map((mode) => `${MODE_WORDS[mode].label}: ${mode}`)] })} />
    {refused !== undefined && <FieldError line={refused.line} details={refused.details} />}
    <Dialog open={asking} onOpenChange={ask}>
      {asking && <DialogContent title={NEVER_ASK.heading} description={NEVER_ASK.body}>
        <div className="flex justify-end gap-1.5"><DialogClose asChild><Button title="Cancel (Esc)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button></DialogClose>
          <Button variant="destructive" title="Never ask (Enter or Space)" onClick={() => { ask(false); save("bypassPermissions", true); }}><ShieldAlert aria-hidden="true" data-icon="inline-start" />Never ask</Button></div>
      </DialogContent>}
    </Dialog>
  </div>;
};
