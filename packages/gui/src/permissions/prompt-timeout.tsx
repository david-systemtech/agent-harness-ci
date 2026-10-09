import { describeKey, isTimeout, plainRefusal, promptTimeoutChoices, type EnvironmentView } from "@agent-harness/client-runtime";
import { SETTINGS, type ParkedPromptTtl } from "@agent-harness/contracts";
import { Clock } from "lucide-react";
import { useId, useState } from "react";
import { useSettingsValues } from "../settings/settings-values.js";
import { Select } from "../ui/index.js";
import { FieldError } from "./field-error.js";

const KEY = "permissions.parkedPrompt.ttl";

/**
 * If nobody answers a question (setup-copy.md §5.12; permissions spec,
 * "Prompts, parked prompts and the TTL"): Deny it after 1 hour, 24 hours, 2
 * days or Never deny it, chosen from a list, with a value set elsewhere kept
 * as a choice of its own. Written through `permissions.settings.set` as soon
 * as it is chosen; a refusal is an error in the refusal mapper's words.
 */
export const PromptTimeout = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const settings = useSettingsValues(view.environmentId);
  const label = useId();
  const [refused, say] = useState<{ readonly line: string; readonly details: readonly string[] }>();
  if (settings.values === null) return null;
  const current = settings.values[KEY] as ParkedPromptTtl;
  const choices = promptTimeoutChoices(current);
  const choose = (index: number) => {
    const choice = choices[index];
    if (choice === undefined) return;
    say(undefined);
    void settings.save(KEY, choice.value).then((saved) => {
      if (saved.ok) return;
      say(saved.refusal === undefined ? { line: saved.line, details: [] } : plainRefusal(saved.refusal, choice.label));
    });
  };
  return (
    <div role="group" aria-labelledby={label} className="flex flex-col gap-1.5">
      <span id={label} className="flex items-center gap-1.5 text-xs font-medium text-ink"><Clock aria-hidden="true" className="size-4" />{SETTINGS[KEY].label}</span>
      <p className="text-2xs text-ink-muted">{describeKey(KEY)}</p>
      <label className="flex flex-wrap items-center gap-2 text-xs text-ink">
        Deny it after
        <Select aria-label="Deny it after" title="Deny it after (Arrow keys to choose)" disabled={!writable} value={String(choices.findIndex((choice) => isTimeout(choice.value, current)))} onChange={(event) => choose(Number(event.target.value))}>
          {choices.map((choice, index) => <option key={choice.label} value={index}>{choice.label}</option>)}
        </Select>
      </label>
      {refused !== undefined && <FieldError line={refused.line} details={refused.details} />}
    </div>
  );
};
