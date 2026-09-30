import {
  clockTime,
  confirmationOf,
  describeKey,
  parseTyped,
  saveSetting,
  uuidv7,
  valueWords,
  writerOf,
  type EnvironmentView,
  type Runtime,
} from "@agent-harness/client-runtime";
import { settingForm, type Confirmation, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, DialogContent, Input, Switch } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

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

/** A value the editor wrote, shown over the cached answer until the cache is fetched again. */
interface Written {
  /** When the cached answer it is shown over was fetched. */
  readonly over: string | null;
  readonly values: Readonly<Record<string, unknown>>;
}

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

/** Why nothing shown of an environment not ready can be written, over what this window read of it, if anything. */
export const readOnlyLine = (runtime: Runtime, view: EnvironmentView, read: boolean): string =>
  `${reachWords(runtime, view)}: ${read ? "the values this window last read, read-only." : "this window has read none of its values."}`;

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
  const clock = useClock();
  const answer = useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "settings.get", {}), [runtime, view.environmentId]));
  const [written, setWritten] = useState<Written | undefined>(undefined);
  const [lines, setLines] = useState<ReadonlyMap<SettingsKey, string>>(new Map());
  const [asking, setAsking] = useState<Asking | undefined>(undefined);
  const fetchedAt = useRef(answer.fetchedAt);
  useLayoutEffect(() => {
    fetchedAt.current = answer.fetchedAt;
  });

  const ready = view.phase === "ready";
  const read = answer.result?.values ?? null;
  const values: Readonly<Record<string, unknown>> | null = read === null ? null : written?.over === answer.fetchedAt ? { ...read, ...written.values } : read;
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
    void saveSetting(runtime, view.environmentId, key, value, { commandId: uuidv7(clock.now()), acknowledgeBypass: acknowledged }).then((saved) => {
      if (!saved.ok) return say(key, `Not saved: ${saved.line}`);
      const over = fetchedAt.current;
      setWritten((now) => ({ over, values: { ...(now?.over === over ? now.values : {}), ...saved.values } }));
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {!ready && saysWhyReadOnly && (
<p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>
      )}
      {lacking.map((line) => (
        <p key={line} className="text-sm text-amber">
          Read-only: {line}
        </p>
      ))}
      {values === null
        ? ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the settings…" : `The settings could not be read: ${answer.error.message}`}</p>
        : keys.map((key) => {
            const writer = writerOf(key);
            const writable = ready && writer !== null && runtime.capability(view.environmentId, writer).status === "present";
            return <KeyField key={key} name={key} value={values[key]} writable={writable} line={lines.get(key)} save={(value) => save(key, value)} />;
          })}
      <Dialog open={asking !== undefined} onOpenChange={(open) => !open && setAsking(undefined)}>
        {asking !== undefined && (
          <DialogContent title={`Set ${asking.key} to ${valueWords(asking.value)}?`} description={asking.confirmation.sentence}>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                tone="danger"
                onClick={() => {
                  setAsking(undefined);
                  save(asking.key, asking.value, true);
                }}
              >
                Set it
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};

interface KeyFieldProps {
  readonly name: SettingsKey;
  readonly value: unknown;
  readonly writable: boolean;
  /** Why the last write did not save, in one line. */
  readonly line: string | undefined;
  readonly save: (value: unknown) => void;
}

/** One key: its name, what it is for, its value drawn by its form, and why its last write did not save. */
const KeyField = ({ name, value, writable, line, save }: KeyFieldProps) => {
  const label = useId();
  return (
    <div role="group" aria-labelledby={label} className="flex flex-col gap-1.5 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <span id={label} className="font-mono text-sm text-ink">
          {name}
        </span>
        <FormControl name={name} label={label} value={value} writable={writable} save={save} />
      </div>
      <p className="text-xs text-ink-muted">{describeKey(name)}</p>
      {writerOf(name) === null && <p className="text-xs text-ink-faint">The environment records it itself; nothing sets it.</p>}
      {line !== undefined && <p className="text-xs text-signal">{line}</p>}
    </div>
  );
};

/** A key's value drawn by its form (`settingForm`): a switch, a choice among its values, or typed text read as the key's. */
const FormControl = ({ name, label, value, writable, save }: Omit<KeyFieldProps, "line"> & { readonly label: string }) => {
  const form = settingForm(name);
  switch (form.kind) {
    case "switch":
      return <Switch aria-labelledby={label} checked={value === true} disabled={!writable} onCheckedChange={(on) => save(on)} />;
    case "choice": {
      const at = form.options.findIndex((option) => option === value);
      return (
        <select
          aria-labelledby={label}
          value={String(at)}
          disabled={!writable}
          onChange={(event) => save(form.options[Number(event.target.value)])}
          className="h-8 rounded-md border border-line bg-inset px-2 text-sm text-ink outline-none focus-visible:border-beam disabled:text-ink-faint"
        >
          {at < 0 && <option value="-1">{valueWords(value)}</option>}
          {form.options.map((option, index) => (
            <option key={String(option)} value={String(index)}>
              {valueWords(option)}
            </option>
          ))}
        </select>
      );
    }
    case "text":
      return <TypedValue key={JSON.stringify(value) ?? ""} name={name} label={label} value={value} writable={writable} save={save} />;
  }
};

/** A value typed as JSON or words (`parseTyped`), saved with its button; what the key does not take is said, and nothing is sent. */
const TypedValue = ({ name, label, value, writable, save }: Omit<KeyFieldProps, "line"> & { readonly label: string }) => {
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
    <form onSubmit={submit} className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Input
          aria-labelledby={label}
          value={text}
          disabled={!writable}
          onChange={(event) => {
            setText(event.target.value);
            setRefused(undefined);
          }}
          className="w-48"
        />
        <Button type="submit" disabled={!writable || text.trim() === ""}>
          Save
        </Button>
      </div>
      {refused !== undefined && <p className="text-xs text-signal">{refused}</p>}
    </form>
  );
};
