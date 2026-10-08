import { AccessUnavailable } from "../connections/limited-access.js";
import { DEFAULT_CHOICE_WORDS, accountChoiceWords, addFavourite, effortChoices, familyChoices, favouriteCandidates, identityWords, modelDisplayName, modelName, moveFavourite, removeFavourite, type EnvironmentView } from "@agent-harness/client-runtime";
import { FAVOURITE_MODELS_MAX, settingsRow, type ModelEntry } from "@agent-harness/contracts";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Cpu, Gauge, KeyRound, Plus, RefreshCw, Search, Star, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { SettingsGroup } from "../settings/part.js";
import { Button, Checkbox, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from "../ui/index.js";
import { MenuGroup } from "../ui/menu.js";
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
 * gives a run), the favourite models the model picker offers first (#1821),
 * and the process idle time in the generic editor. Each is
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
          <FavouriteModels view={view} />
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

/** What a person focuses on purpose, as against a container that catches a dropped focus. */
const CONTROL = "button, input, select, textarea, a[href], [role^='menuitem'], [contenteditable='true'], [tabindex]:not([tabindex='-1'])";

/**
 * Where the keyboard goes once the list is drawn again after an edit: a
 * favourite's button, or (no `id`) Add a favourite. Where that is gone or
 * disabled, the section itself takes it, so the keyboard stays here.
 */
interface Touched {
  readonly id: string | undefined;
  readonly edit?: "up" | "down" | "remove";
}

/**
 * The favourite models, `accounts.favouriteModels` (#1821): the models the
 * account and model picker offers first, in the order kept here. A model is
 * added from those the signed-in accounts list (Add a favourite, by account
 * while several list models), moved one place up or down, or removed; each
 * edit writes the whole list through `settings.update`, a refused one said
 * in one line; the list and Add a favourite are held until a write is
 * answered, so the next edit starts from what it wrote. A favourite no
 * signed-in account lists stays, said so, until it is removed. Greyed while the environment cannot be reached or without
 * `admin`, whose line the pane says.
 */
const FavouriteModels = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const settings = useSettingsValues(environmentId);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value ?? [];
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId])).value ?? [];
  const [line, setLine] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const touched = useRef<Touched | undefined>(undefined);
  const favourites = (settings.values?.["accounts.favouriteModels"] as readonly string[] | undefined) ?? [];
  useLayoutEffect(() => {
    const last = touched.current;
    if (last === undefined || saving) return;
    touched.current = undefined;
    // A control the person moved to before the answer keeps the keyboard; a dropped focus (the body, the dialog) is taken back.
    const active = document.activeElement;
    if (active?.matches(CONTROL) === true && section.current?.contains(active) === false) return;
    const row = last.id === undefined ? undefined : list.current?.querySelector<HTMLElement>(`[data-favourite="${CSS.escape(last.id)}"]`);
    const buttons = [...(row?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const adding = add.current?.disabled === false ? add.current : undefined;
    (buttons.find((button) => button.dataset["edit"] === last.edit) ?? buttons[0] ?? adding ?? section.current)?.focus();
  }, [favourites, saving]);
  if (settings.values === null) return null;
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present" && !saving;
  // Each model the signed-in accounts list, as the first account listing it names it.
  const signedIn = new Set(accounts.filter((account) => account.status.state === "signed-in").map((account) => account.id));
  const listed = new Map<string, ModelEntry>();
  for (const entry of catalogues.filter((catalogue) => signedIn.has(catalogue.accountId)).flatMap((catalogue) => catalogue.models)) if (!listed.has(entry.id)) listed.set(entry.id, entry);
  const candidates = favouriteCandidates(catalogues, accounts, favourites);
  const full = favourites.length >= FAVOURITE_MODELS_MAX;
  const accountLabel = (id: string) => accounts.find((account) => account.id === id)?.label ?? id;
  // Named as the model picker names it: the display table's name, else the provider's label, else the id.
  const nameOf = (id: string) => modelDisplayName(id, listed.get(id)?.label ?? null);
  // A refused edit leaves the list as it was, so the keyboard goes back to the button pressed.
  const save = async (next: readonly string[], after?: Touched, pressed: Touched | undefined = after) => {
    setLine(undefined);
    setSaving(true);
    touched.current = after;
    try {
      const saved = await settings.save("accounts.favouriteModels", next);
      if (!saved.ok) {
        touched.current = pressed;
        setLine(`Not saved: ${saved.line}`);
      }
    } finally {
      setSaving(false);
    }
  };
  // After a removal the keyboard goes to the next favourite's Remove, the previous one's for the last, or Add a favourite.
  const afterRemoving = (index: number): Touched => ({ id: favourites[index + 1] ?? favourites[index - 1], edit: "remove" });
  const candidate = (entry: ModelEntry) => <MenuItem key={entry.id} aria-label={modelName(entry)} onSelect={() => void save(addFavourite(favourites, entry.id), { id: undefined })} className="items-start text-xs">
    <Cpu aria-hidden="true" className="mt-0.5 size-3" />
    <span className="min-w-0 flex-1"><span className="block">{modelDisplayName(entry.id, entry.label)}</span>{modelDisplayName(entry.id, entry.label) !== entry.id && <span className="block font-mono text-2xs text-ink-muted">{entry.id}</span>}</span>
  </MenuItem>;
  return (
    <SettingsGroup title="Favourite models">
      <div ref={section} tabIndex={-1} className="flex flex-col gap-2 text-xs text-ink outline-none">
        <p className="text-2xs text-ink-faint">The account and model picker offers these first, in this order; every other model is under Other models.</p>
        {favourites.length === 0 ? <p className="text-ink-muted">No favourites yet: the model picker offers the provider's recommended models.</p> : (
          <ol ref={list} aria-label="Favourite models, in order" className="flex flex-col gap-1">
            {favourites.map((id, index) => {
              const entry = listed.get(id);
              return <li key={id} data-favourite={id} className="flex items-center gap-2 rounded-md bg-wash px-2 py-1.5">
                <Star aria-hidden="true" className="size-3 shrink-0 text-ink-muted" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block">{nameOf(id)}</span>
                  {nameOf(id) !== id && <span className="block font-mono text-2xs text-ink-muted">{id}</span>}
                  {entry === undefined && <span className="block text-2xs text-ink-faint">No signed-in account lists it: the picker passes it over.</span>}
                </span>
                <IconButton label={`Move ${nameOf(id)} up`} data-edit="up" disabled={!writable || index === 0} onClick={() => void save(moveFavourite(favourites, id, -1), { id, edit: "up" })}><ArrowUp aria-hidden="true" /></IconButton>
                <IconButton label={`Move ${nameOf(id)} down`} data-edit="down" disabled={!writable || index === favourites.length - 1} onClick={() => void save(moveFavourite(favourites, id, 1), { id, edit: "down" })}><ArrowDown aria-hidden="true" /></IconButton>
                <IconButton label={`Remove ${nameOf(id)}`} data-edit="remove" disabled={!writable} onClick={() => void save(removeFavourite(favourites, id), afterRemoving(index), { id, edit: "remove" })}><X aria-hidden="true" /></IconButton>
              </li>;
            })}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Menu modal={false}>
            <MenuTrigger asChild>
              <Button ref={add} variant="outline" aria-label="Add a favourite" disabled={!writable || full || candidates.length === 0} className="h-8 text-xs"><Plus aria-hidden="true" />Add a favourite</Button>
            </MenuTrigger>
            <MenuContent side="bottom" align="start" aria-label="Models to add" aria-labelledby={undefined} className="w-72 max-h-[320px] overflow-y-auto">
              {candidates.map((group) => <MenuGroup key={group.accountId} aria-label={candidates.length > 1 ? accountLabel(group.accountId) : undefined}>
                {candidates.length > 1 && <MenuLabel>{accountLabel(group.accountId)}</MenuLabel>}
                {group.models.map(candidate)}
              </MenuGroup>)}
            </MenuContent>
          </Menu>
          {full ? <span className="text-2xs text-ink-faint">{`At most ${FAVOURITE_MODELS_MAX} favourites.`}</span>
            : candidates.length === 0 && <span className="text-2xs text-ink-faint">{favourites.length === 0 ? "No signed-in account lists a model yet." : "Every model the signed-in accounts list is a favourite."}</span>}
        </div>
        {line !== undefined && <p className="text-xs text-signal">{line}</p>}
      </div>
    </SettingsGroup>
  );
};
