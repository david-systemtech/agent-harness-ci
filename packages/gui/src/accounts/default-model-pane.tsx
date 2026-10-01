import { DEFAULT_CHOICE_WORDS, accountChoiceWords, effortChoices, familyChoices, familyWords, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useId, useMemo, useState } from "react";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { Select } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** The three defaults the pane picks from lists; the fourth, the process idle time, is typed. */
type DefaultKey = keyof typeof DEFAULT_CHOICE_WORDS;

/**
 * Default account and model, `accounts.default-model` (docs/specs/gui.md,
 * "Settings"; the Set up specification, "Account"; ADR 0018, ADR 0027;
 * #414), on the environment its picker names: the Account step's four keys,
 * the default account picked from `accounts.list`, the model family and
 * effort from `models.list` (the effort among those of the model the family
 * gives a run), and the process idle time in the generic editor. Each is
 * read from `settings.get` in the request cache and written through
 * `settings.update` (`useSettingsValues`). Without `admin` it is read-only
 * with the capability's line; while the environment cannot be reached its
 * values show as this window last read them, read-only.
 */
export const DefaultModelPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <DefaultModelOn key={picked.environmentId} view={picked} />;
};

const DefaultModelOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { answer, values } = useSettingsValues(environmentId);
  const ready = view.phase === "ready";
  const writer = runtime.capability(environmentId, "settings.update");

  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("accounts.default-model").hint}</p>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && writer.status === "absent" && <p className="text-sm text-amber">Read-only: {writer.message}</p>}
      {values === null ? (
        ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the settings…" : `The settings could not be read: ${answer.error.message}`}</p>
      ) : (
        <>
          <DefaultChoices view={view} />
          <GenericEditor view={view} keys={["providers.processIdleMinutes"]} saysWhyReadOnly={false} />
        </>
      )}
    </>
  );
};

/**
 * The default account, model family and effort as choices, as the Default
 * account and model row and the Account step's card (#575) draw them: the
 * accounts from `accounts.list`, the families from `models.list` and the
 * efforts of the model the family gives a run, each read from `settings.get`
 * and written through `settings.update`, a refused write said in one line.
 * Nothing until the settings are read; greyed while the environment cannot
 * be reached or without `admin`, whose line is the caller's to say.
 */
export const DefaultChoices = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const settings = useSettingsValues(environmentId);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value ?? [];
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId])).value ?? [];
  const [line, setLine] = useState<string | undefined>(undefined);
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present";
  const { values } = settings;
  if (values === null) return null;

  const save = (key: DefaultKey, value: string | null) => {
    setLine(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setLine(`Not saved: ${saved.line}`));
  };
  const valueOf = (key: DefaultKey): string | null => (values[key] as string | null | undefined) ?? null;
  const family = valueOf("accounts.defaultModelFamily");

  return (
    <>
      <DefaultChoice
        name="Default account"
        setting="accounts.defaultAccount"
        value={valueOf("accounts.defaultAccount")}
        options={accounts.map((account) => ({ value: account.id, words: accountChoiceWords(account) }))}
        writable={writable}
        save={save}
      />
      <DefaultChoice
        name="Model family"
        setting="accounts.defaultModelFamily"
        value={family}
        options={familyChoices(catalogues).map((choice) => ({ value: choice.family, words: familyWords(choice) }))}
        writable={writable}
        save={save}
      />
      <DefaultChoice
        name="Effort"
        setting="accounts.defaultEffort"
        value={valueOf("accounts.defaultEffort")}
        options={effortChoices(catalogues, family).map((effort) => ({ value: effort, words: effort }))}
        writable={writable}
        save={save}
      />
      {line !== undefined && <p className="text-sm text-signal">{line}</p>}
    </>
  );
};

interface DefaultChoiceProps {
  /** What the picker is named. */
  readonly name: string;
  readonly setting: DefaultKey;
  /** The value set; null while it is unset. */
  readonly value: string | null;
  /** What it offers, each value with its words. */
  readonly options: readonly { readonly value: string; readonly words: string }[];
  readonly writable: boolean;
  readonly save: (key: DefaultKey, value: string | null) => void;
}

/**
 * One default as a choice: unset first (the empty value, which no account
 * id, family or effort is), then what it offers, and a value set that it no
 * longer offers named with what runs take instead.
 */
const DefaultChoice = ({ name, setting, value, options, writable, save }: DefaultChoiceProps) => {
  const id = useId();
  const words = DEFAULT_CHOICE_WORDS[setting];
  const missing = value !== null && !options.some((option) => option.value === value) ? value : undefined;
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-ink">
      <label htmlFor={id}>{name}</label>
      <Select id={id} value={value ?? ""} disabled={!writable} onChange={(event) => save(setting, event.target.value === "" ? null : event.target.value)}>
        <option value="">{words.unset}</option>
        {missing !== undefined && <option value={missing}>{words.missing(missing)}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.words}
          </option>
        ))}
      </Select>
    </div>
  );
};
