import { ReadOnlyAccess } from "../connections/limited-access.js";
import { clockTime, confirmationOf, describeKey, parseTyped, valueWords, writerOf, type EnvironmentView, type Runtime } from "@agent-harness/client-runtime";
import { SETTINGS, settingForm, type Confirmation, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { Check, Save, SlidersHorizontal, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, DialogContent, Input, Select, Switch, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useSettingsValues } from "./settings-values.js";

/**
 * The generic editor (docs/specs/gui.md, "Settings": a row whose feature is
 * not built shows the generic editor for its keys; ADR 0027): each key of the
 * row on one environment, drawn by its form (a switch, a choice, typed text)
 * and written by the method that writes it (`settings.update`, or the one
 * its rule gives it), the words, the typed values and the writes being the
 * client runtime's, which the terminal UI's `/settings` shares. The values
 * are `settings.get` from the request cache. Without the writer's scope
 * (`admin`) every key is read-only with the capability's line; while the
 * environment cannot be reached its values show as this window last read
 * them, read-only, with since when.
 */

/** A value waiting on its confirmation before it is written. */
interface Asking {
  readonly key: SettingsKey;
  readonly value: unknown;
  readonly confirmation: Confirmation;
}

/** Since when the environment has not been reached, or what its connection says while it is on its way. */
export const reachWords = (runtime: Runtime, view: EnvironmentView): string => {
  if (view.unreachableSince !== null) return `Unreachable since ${clockTime(view.unreachableSince)}`;
  const answer = runtime.capability(view.environmentId, "settings.get");
  return answer.status === "absent" ? answer.message.replace(/\.$/, "") : "Not reached yet";
};

/**
 * `reach` and what follows from it: one clause after a colon; or, after a
 * line that already says what to do in a clause or a sentence of its own (a
 * block's, #1772; a limited pairing's, #1837), a sentence of its own.
 */
export const afterReach = (reach: string, rest: string): string =>
  /[:.] /.test(reach) ? `${reach}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : `${reach}: ${rest}`;

/** Why nothing shown of an environment not ready can be written, over what this window read of it, if anything. */
export const readOnlyLine = (runtime: Runtime, view: EnvironmentView, read: boolean, reach: string = reachWords(runtime, view)): string =>
  afterReach(reach, read ? "the values this window last read, read-only." : "this window has read none of its values.");

/** The methods that write `keys`, each once; none for a key the environment records itself. */
export const writersOf = (keys: readonly SettingsKey[]): readonly MethodName[] => [...new Set(keys.flatMap((key) => writerOf(key) ?? []))];

/** The lines of the capabilities the connection lacks to call `methods`, each once. */
export const lackingLines = (runtime: Runtime, environmentId: string, methods: readonly MethodName[]): readonly string[] => [
  ...new Set(
    methods.flatMap((method) => {
      const answer = runtime.capability(environmentId, method);
      return answer.status === "absent" ? [answer.message] : [];
    }),
  ),
];

interface GenericEditorProps {
  readonly view: EnvironmentView;
  readonly keys: readonly SettingsKey[];
  /**
   * Whether it says why its keys are read-only, since when the environment
   * has not been reached or the capability lacking: preset true; false where
   * what holds it says so for everything it shows (a Your machines card).
   */
  readonly saysWhyReadOnly?: boolean;
}

export const GenericEditor = ({ view, keys, saysWhyReadOnly = true }: GenericEditorProps) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(view.environmentId);
  const { answer, values } = settings;
  const [lines, setLines] = useState<ReadonlyMap<SettingsKey, string>>(new Map());
  const [asking, setAsking] = useState<Asking | undefined>(undefined);

  const ready = view.phase === "ready";
  const lacking = ready && saysWhyReadOnly ? lackingLines(runtime, view.environmentId, writersOf(keys)) : [];

  const say = (key: SettingsKey, line: string | undefined) =>
    setLines((now) => {
      const next = new Map(now);
      if (line === undefined) next.delete(key);
      else next.set(key, line);
      return next;
    });

  const save = (key: SettingsKey, value: unknown, acknowledged = false) => {
    const confirmation = confirmationOf(key, value);
    if (confirmation !== undefined && !acknowledged) return setAsking({ key, value, confirmation });
    say(key, undefined);
    void settings.save(key, value, acknowledged).then((saved) => !saved.ok && say(key, `Not saved: ${saved.line}`));
  };

  return (
    <div className="flex flex-col gap-3">
      {!ready && saysWhyReadOnly && (
        <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>
      )}
      {lacking.map((line) => (
        <ReadOnlyAccess key={line} environmentId={view.environmentId} line={line}><p className="text-sm text-amber">Read-only: {line}</p></ReadOnlyAccess>
      ))}
      {values === null
        ? ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the settings…" : `The settings could not be read: ${answer.error.message}`}</p>
        : keys.map((key) => {
            const writer = writerOf(key);
            const writable = ready && writer !== null && runtime.capability(view.environmentId, writer).status === "present";
            return <SettingField key={key} name={key} value={values[key]} writable={writable} line={lines.get(key)} save={(value) => save(key, value)} />;
          })}
      <Dialog open={asking !== undefined} onOpenChange={(open) => !open && setAsking(undefined)}>
        {asking !== undefined && (
          <DialogContent title={`Set ${SETTINGS[asking.key].label} to ${valueWords(asking.value)}?`} description={asking.confirmation.sentence}>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button title="Cancel (Esc)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                title="Confirm this setting (Enter or Space)"
                onClick={() => {
                  setAsking(undefined);
                  save(asking.key, asking.value, true);
                }}
              >
                <Check aria-hidden="true" data-icon="inline-start" />Set it
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};

interface SettingFieldProps {
  readonly name: SettingsKey;
  readonly value: unknown;
  readonly writable: boolean;
  /** Why the last write did not save, in one line. */
  readonly line: string | undefined;
  readonly save: (value: unknown) => void;
}

/** One setting: human label, smaller key detail, help, form and write failure. */
export const SettingField = ({ name, value, writable, line, save }: SettingFieldProps) => {
  const label = useId();
  return (
    <div role="group" aria-labelledby={label} className="@container flex min-w-0 flex-col gap-1.5 rounded-lg border border-hairline p-3">
      <div className="flex min-w-0 flex-col gap-3 @sm:flex-row @sm:items-center @sm:justify-between">
        <div className="min-w-0">
          <span id={label} className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            {SETTINGS[name].label}
          </span>
          <span className="block break-all font-mono text-2xs text-ink-faint">{name}</span>
        </div>
        <FormControl name={name} label={label} value={value} writable={writable} save={save} />
      </div>
      <p className="text-2xs text-ink-muted">{describeKey(name)}</p>
      {writerOf(name) === null && <p className="text-xs text-ink-faint">The environment records it itself; nothing sets it.</p>}
      {line !== undefined && <p className="text-xs text-signal">{line}</p>}
    </div>
  );
};

/** A key's value drawn by its form (`settingForm`): a switch, a choice among its values, or typed text read as the key's. */
const FormControl = ({ name, label, value, writable, save }: Omit<SettingFieldProps, "line"> & { readonly label: string }) => {
  const form = settingForm(name);
  switch (form.kind) {
    case "switch":
      return <Tooltip content={SETTINGS[name].label} keys="Space to toggle"><Switch aria-labelledby={label} checked={value === true} disabled={!writable} onCheckedChange={(on) => save(on)} /></Tooltip>;
    case "choice": {
      const at = form.options.findIndex((option) => option === value);
      return (
        <Select
          title={`${SETTINGS[name].label} (Arrow keys to choose)`}
          aria-labelledby={label}
          value={String(at)}
          disabled={!writable}
          onChange={(event) => save(form.options[Number(event.target.value)])}
          className="w-48 max-w-full"
        >
          {at < 0 && <option value="-1">{valueWords(value)}</option>}
          {form.options.map((option, index) => (
            <option key={String(option)} value={String(index)}>
              {valueWords(option)}
            </option>
          ))}
        </Select>
      );
    }
    case "text":
      return <TypedValue key={JSON.stringify(value) ?? ""} name={name} label={label} value={value} writable={writable} save={save} />;
  }
};

/** A value typed as JSON or words (`parseTyped`), saved with its button; what the key does not take is said, and nothing is sent. */
const TypedValue = ({ name, label, value, writable, save }: Omit<SettingFieldProps, "line"> & { readonly label: string }) => {
  const [text, setText] = useState(valueWords(value));
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseTyped(name, text);
    if (!parsed.ok) return setRefused(`Not saved: ${parsed.line}`);
    setRefused(undefined);
    save(parsed.value);
  };
  return (
    <form onSubmit={submit} className="flex max-w-full flex-col items-end gap-1">
      <div className="flex max-w-full flex-wrap gap-2">
        <Input
          aria-labelledby={label}
          title={`${SETTINGS[name].label} (Enter to save)`}
          value={text}
          disabled={!writable}
          onChange={(event) => {
            setText(event.target.value);
            setRefused(undefined);
          }}
          className="w-48 max-w-full"
        />
        <Button type="submit" title={`Save ${SETTINGS[name].label} (Enter)`} disabled={!writable || text.trim() === ""}>
          <Save aria-hidden="true" data-icon="inline-start" />Save
        </Button>
      </div>
      {refused !== undefined && <p className="text-xs text-signal">{refused}</p>}
    </form>
  );
};
