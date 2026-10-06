import { AccessUnavailable } from "../connections/limited-access.js";
import { DEFAULT_CHOICE_WORDS, accountChoiceWords, effortChoices, familyChoices, identityWords, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { ArrowLeft, ChevronDown, Cpu, Gauge, KeyRound, RefreshCw, Search } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { SettingsGroup } from "../settings/part.js";
import { Button, Checkbox, Menu, MenuContent, MenuTrigger, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { RunChoiceRow, RunPickerColumn, moveInColumns, useNarrowRunPicker, type RunStage } from "../status/run-picker-parts.js";
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
      <p className="text-2xs leading-relaxed text-ink-faint">{settingsRow("accounts.default-model").hint}</p>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && writer.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={writer}><p className="text-sm text-amber">Read-only: {writer.message}</p></AccessUnavailable>}
      {values === null ? (
        ready && <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the settings…" : `The settings could not be read: ${answer.error.message}`}</p>
      ) : (
        <>
          <DefaultChoices view={view} />
          <SettingsGroup title="Provider process"><GenericEditor view={view} keys={["providers.processIdleMinutes"]} saysWhyReadOnly={false} /></SettingsGroup>
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
  const accountAnswer = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const accounts = accountAnswer.value ?? [];
  const modelAnswer = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const catalogues = modelAnswer.value ?? [];
  const [line, setLine] = useState<string | undefined>(undefined);
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present";
  const narrow = useNarrowRunPicker(1200);
  const { values } = settings;
  if (values === null) return null;

  const save = async (key: DefaultKey, value: string | null) => {
    setLine(undefined);
    const saved = await settings.save(key, value);
    if (!saved.ok) setLine(`Not saved: ${saved.line}`);
    return saved.ok;
  };
  const valueOf = (key: DefaultKey): string | null => (values[key] as string | null | undefined) ?? null;
  const family = valueOf("accounts.defaultModelFamily");
  const families = familyChoices(catalogues);
  const efforts = effortChoices(catalogues, family);
  const accountListing = runtime.capability(environmentId, "accounts.list");
  const modelListing = runtime.capability(environmentId, "models.list");
  const options = {
    "accounts.defaultAccount": accounts.map((account) => ({ value: account.id, words: accountChoiceWords(account), under: `${identityWords(account)} · ${account.provider}` })),
    "accounts.defaultModelFamily": families.map(({ family, model }) => ({ value: family, words: model.label ?? model.id, machine: model.label === null ? undefined : model.id, hasEffort: model.efforts.length > 0, under: model.efforts.length > 0 ? "Supports effort" : "Uses its own effort" })),
    "accounts.defaultEffort": efforts.map((effort) => ({ value: effort, words: effort, under: "Reasoning effort for new sessions." })),
  };
  const selectedWords = (key: DefaultKey) => {
    const value = valueOf(key);
    return value === null ? DEFAULT_CHOICE_WORDS[key].unset : options[key].find((option) => option.value === value)?.words ?? DEFAULT_CHOICE_WORDS[key].missing(value);
  };
  const selectedModel = families.find((choice) => choice.family === family)?.model;
  const columns = (initial: RunStage) => <DefaultColumns initial={initial} narrow={narrow} writable={writable} options={options} valueOf={valueOf} save={save}
    accountReason={accountListing.status === "absent" ? accountListing.message : undefined}
    modelReason={modelListing.status === "absent" ? modelListing.message : undefined}
    accountState={accountAnswer.error ? `The accounts could not be read: ${accountAnswer.error.message}` : accountAnswer.value === null ? "Reading the accounts…" : undefined}
    modelState={modelAnswer.error ? `The models could not be read: ${modelAnswer.error.message}` : modelAnswer.value === null ? "Reading the models…" : undefined}
    refreshAccounts={() => runtime.requests.refresh(environmentId, "accounts.list", {})}
    refresh={() => runtime.requests.refresh(environmentId, "models.list", {})} />;

  return (
    <SettingsGroup title="New sessions">
      <DefaultTrigger name="Default account" stage="Accounts" words={selectedWords("accounts.defaultAccount")} writable={writable} narrow={narrow} icon={KeyRound}
        note="The account a new session starts on." columns={columns} />
      <DefaultTrigger name="Model family" stage="Models" words={selectedWords("accounts.defaultModelFamily")} machine={selectedModel?.label ? selectedModel.id : undefined} writable={writable} narrow={narrow} icon={Cpu}
        note="Use the strongest model in this family." columns={columns} />
      <DefaultTrigger name="Effort" stage={efforts.length > 0 || valueOf("accounts.defaultEffort") !== null ? "Effort" : "Models"} words={selectedWords("accounts.defaultEffort")} writable={writable} narrow={narrow} icon={Gauge}
        note="How much reasoning the model uses." columns={columns} />
      {line !== undefined && <p className="text-xs text-signal">{line}</p>}
    </SettingsGroup>
  );
};

const DefaultTrigger = ({ name, stage, words, machine, note, icon: Icon, writable, narrow, columns }: {
  readonly name: string; readonly stage: RunStage; readonly words: string; readonly machine?: string | undefined; readonly note: string;
  readonly icon: typeof Cpu; readonly writable: boolean; readonly narrow: boolean; readonly columns: (initial: RunStage) => ReactNode;
}) => <div className="flex flex-wrap items-center gap-3 text-xs text-ink">
  <div className="flex min-w-0 flex-1 basis-[224px] items-start gap-2"><Icon aria-hidden="true" className="mt-0.5 size-4 text-ink-muted" /><div><p>{name}</p><p className="mt-0.5 text-2xs text-ink-faint">{note}</p></div></div>
  <Menu modal={false}>
    <Tooltip content={name} keys="Enter to open · Escape to close"><MenuTrigger asChild>
      <Button variant="outline" aria-label={`${name}: ${words}`} disabled={!writable} data-default-choice={name} className="h-auto min-h-8 max-w-full justify-start px-2.5 py-1.5 text-left text-xs">
        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"><span className="block">{words}</span>{machine !== undefined && <span className="block font-mono text-2xs text-ink-muted">{machine}</span>}</span>
        <ChevronDown aria-hidden="true" className="size-3" />
      </Button>
    </MenuTrigger></Tooltip>
    <MenuContent side="bottom" align="start" aria-label="New-session defaults" aria-labelledby={undefined} role={narrow ? "dialog" : "menu"}
      className="w-auto max-w-[calc(100vw-16px)] overflow-y-auto rounded-[10px] p-0">{columns(stage)}</MenuContent>
  </Menu>
</div>;

interface DefaultOption {
  readonly value: string; readonly words: string; readonly machine?: string | undefined; readonly under?: string; readonly hasEffort?: boolean;
}

/** Defaults reuse run-picker rows, columns and keyboard navigation; writes stay with settings.update. */
const DefaultColumns = ({ initial, narrow, writable, options, valueOf, save, accountReason, modelReason, accountState, modelState, refreshAccounts, refresh }: {
  readonly initial: RunStage; readonly narrow: boolean; readonly writable: boolean;
  readonly options: Readonly<Record<DefaultKey, readonly DefaultOption[]>>;
  readonly valueOf: (key: DefaultKey) => string | null; readonly save: (key: DefaultKey, value: string | null) => Promise<boolean>;
  readonly accountReason: string | undefined; readonly modelReason: string | undefined;
  readonly accountState: string | undefined; readonly modelState: string | undefined; readonly refreshAccounts: () => void; readonly refresh: () => void;
}) => {
  const [activeColumn, setActiveColumn] = useState(initial);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState(true);
  const picker = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (narrow) picker.current?.querySelector<HTMLElement>(`[data-run-column="${activeColumn}"] [role="menuitem"]`)?.focus();
  }, [activeColumn, narrow]);
  const rows = (key: DefaultKey, icon: typeof Cpu, reason: string | undefined) => {
    const words = DEFAULT_CHOICE_WORDS[key];
    const value = valueOf(key);
    const all = options[key];
    const state = key === "accounts.defaultAccount" ? accountState : modelState;
    const shown = key !== "accounts.defaultModelFamily" ? all : all.filter((option, index) =>
      (query !== "" || !quick || index < 5 || option.value === value) && `${option.words} ${option.machine ?? ""} ${option.value}`.toLowerCase().includes(query.toLowerCase()));
    const select = async (next: string | null) => {
      if (!writable || reason !== undefined || !await save(key, next)) return;
      if (key === "accounts.defaultAccount") setActiveColumn("Models");
      if (key === "accounts.defaultModelFamily" && narrow && (next === null ? all[0] : all.find((option) => option.value === next))?.hasEffort) setActiveColumn("Effort");
    };
    return <>
      <RunChoiceRow icon={icon} label={words.unset} selected={value === null} dim={!writable || reason !== undefined} onSelect={() => void select(null)} />
      {value !== null && !all.some((option) => option.value === value) && <RunChoiceRow icon={icon} label={words.missing(value)} selected dim onSelect={() => undefined} />}
      {shown.map((option) => <RunChoiceRow key={option.value} icon={icon} label={option.words} machine={option.machine} under={option.under}
        selected={option.value === value} dim={!writable || reason !== undefined} onSelect={() => void select(option.value)} />)}
      {state !== undefined && <p className="px-2.5 py-2 text-2xs text-ink-muted">{state}</p>}
      {state === undefined && all.length === 0 && <p className="px-2.5 py-2 text-2xs text-ink-muted">{key === "accounts.defaultAccount" ? "No accounts yet." : key === "accounts.defaultModelFamily" ? "No models are listed yet." : "This model uses its own effort."}</p>}
      {all.length > 0 && shown.length === 0 && <p className="px-2.5 py-2 text-2xs text-ink-muted">No models match your search.</p>}
      {reason !== undefined && <p className="px-2.5 py-2 text-2xs text-ink-muted">{reason}</p>}
    </>;
  };
  return <div ref={picker} data-run-picker data-default-picker data-narrow={narrow ? "true" : undefined} onKeyDownCapture={moveInColumns}
      className={classes("flex flex-col", narrow && "w-[min(512px,calc(100vw-16px))]")}>
    {narrow && <div data-run-column="Steps" className="flex flex-wrap gap-2 border-b border-hairline p-1.5">
      <Button aria-label={activeColumn === "Effort" ? "Back to models" : "Back to accounts"} onClick={() => setActiveColumn(activeColumn === "Effort" ? "Models" : "Accounts")}><ArrowLeft aria-hidden="true" />Back</Button>
      <Button aria-label="Choose model" onClick={() => setActiveColumn("Models")}><Cpu aria-hidden="true" />Models</Button>
      {(options["accounts.defaultEffort"].length > 0 || valueOf("accounts.defaultEffort") !== null) && <Button aria-label="Choose effort" onClick={() => setActiveColumn("Effort")}><Gauge aria-hidden="true" />Effort</Button>}
    </div>}
    <div className={classes("flex min-w-0 divide-hairline", narrow ? "flex-col divide-y" : "divide-x")}>
      <RunPickerColumn name="Accounts" narrow={narrow} activeColumn={activeColumn} showEffortWithModel={false}>{rows("accounts.defaultAccount", KeyRound, accountReason)}
        {accountState !== undefined && <RunChoiceRow icon={RefreshCw} label="Refresh accounts" dim={accountReason !== undefined} onSelect={() => { if (accountReason === undefined) refreshAccounts(); }} />}
      </RunPickerColumn>
      <RunPickerColumn name="Models" narrow={narrow} activeColumn={activeColumn} showEffortWithModel={false}>
        {options["accounts.defaultModelFamily"].length > 12 && <label className="mb-1 flex items-center gap-2 rounded-md bg-wash px-2"><Search aria-hidden="true" className="size-3" /><input aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 min-w-0 w-full bg-transparent text-xs outline-none" /></label>}
        {options["accounts.defaultModelFamily"].length > 5 && <label className="flex items-center gap-2 px-2.5 py-2 text-2xs"><Checkbox checked={quick} onCheckedChange={(checked) => setQuick(checked === true)} />Quick choices only</label>}
        {rows("accounts.defaultModelFamily", Cpu, modelReason)}
        <RunChoiceRow icon={RefreshCw} label="Refresh models" dim={modelReason !== undefined} onSelect={() => { if (modelReason === undefined) refresh(); }} />
      </RunPickerColumn>
      {(options["accounts.defaultEffort"].length > 0 || valueOf("accounts.defaultEffort") !== null) && <RunPickerColumn name="Effort" narrow={narrow} activeColumn={activeColumn} showEffortWithModel={false}>{rows("accounts.defaultEffort", Gauge, modelReason)}</RunPickerColumn>}
    </div>
  </div>;
};
