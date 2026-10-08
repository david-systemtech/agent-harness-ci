import {
  ACCOUNT_STATUS_WORDS,
  MODE_BADGE_WORDS,
  UNREAD_ACCOUNT,
  aboveCeilingWords,
  containmentWords,
  identityWords,
  modelName,
  modelsOf,
  pickerModels,
  pinWords,
  readingWords,
  gaugeOf,
  sessionModeOf,
  setSessionContainment,
  setSessionMode,
  type CapabilityName,
  type ContainmentBadge,
  type RunChoice,
} from "@agent-harness/client-runtime";
import { ArrowRightLeft, Box, Check, Cpu, KeyRound, Layers, Plus, RefreshCw, Search, Shield, SlidersHorizontal, Star } from "lucide-react";
import { BYPASS_SENTENCE, CONTAINMENT_LEVELS, type AccountRecord, type ModelEntry } from "@agent-harness/contracts";
import { createContext, Fragment, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { classes } from "../ui/classes.js";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useHandOffOnto } from "./hand-off.js";
import { useSignInCard } from "./pane-dialogs.js";
import { MenuGroup, MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/menu.js";
import { SessionBrowserPicker } from "../browser/session-picker.js";
import { useSettingsIfHeld } from "../settings/settings-window.js";
import { RunChoiceRow, RunPickerColumn, RunPickerContent, RunPickerSteps, RunPickerTrigger, moveInColumns, useNarrowRunPicker, type RunStage } from "./run-picker-parts.js";
import { ModeSheet, focusModeSheet, trapModeSheetTab } from "./mode-sheet.js";
import { useHandedOnto, useModelChoice } from "./run-choices.js";

/**
 * The status line's pickers (docs/specs/gui.md, "A session pane": pickers
 * per environment; #402), each a menu opened from its button on the line and
 * each over the session's environment. Each asks the connection whether it
 * can do what it does (`capability`): one it cannot is dim with the
 * capability's reason, which a press says on the pane's line. Each is its
 * slash command's too (`/account`, `/model`, `/mode`, `/containment`),
 * which opens it from the composer or the command palette. What each
 * choice does and says is the client runtime's (`setSessionMode`,
 * `setSessionContainment`, the hand-off), so the terminal UI says the same.
 *
 * - **Accounts**: the environment's accounts, each with its identity, its
 *   sign-in status and its identity's plan reading, then Add an account.
 *   An account not signed in starts its sign-in on the sign-in card; a
 *   session's account is fixed, so another signed-in account hands the
 *   session off onto it, the hand-off picker's fork.
 * - **Models**: the models of the session's account (every account's, once
 *   each, while the session has none) with their efforts, the model's own
 *   first; the choice goes with the session's next run. The favourite models
 *   (`accounts.favouriteModels`, #1821) the account lists come first as
 *   one-click picks, else the provider's recommended models with how to pin
 *   favourites; every other model is under Other models, a flyout opened on
 *   hover, a click or the right arrow (shown under its row by a tap where the
 *   picker shows one column at a time, as on a phone), grouped by account
 *   while the session has none. A search typed lists every model that matches.
 * - **Modes**: the four, one above the connection's ceiling greyed with the
 *   ceiling named. It can still be chosen: the environment's clamp answers
 *   it, and the line says the clamp (a mode is lowered, never refused).
 * - **Containment**: the three levels, one the environment cannot enforce
 *   greyed with the probe's reason. It can still be chosen: the refusal
 *   (`containment_unavailable`) is one line.
 */

export type RunPickerCommand = "account" | "model" | "mode" | "containment";
/** A compact sheet hands its pending slash command to the existing picker after mounting. */
export const RunPickerRequest = createContext<{ readonly command: RunPickerCommand; readonly handled: () => void } | null>(null);

interface PickerButtonProps {
  /** What the picker picks: its button is named for it and the value it shows (`Mode: auto`). */
  readonly name: string;
  /** The value the button shows, in words. */
  readonly value: string;
  /** Whether the connection can do what the picker does. */
  readonly offer: Offer;
  readonly children: ReactNode;
  /** The menu's items. */
  readonly items: (close: () => void) => ReactNode;
  /** An extra warning appended to the button's tooltip. */
  readonly warning?: string | undefined;
  readonly columns?: boolean;
  readonly phoneItems?: (close: () => void) => ReactNode;
  /** The slash command that opens it. */
  readonly command: RunPickerCommand;
}

const TRIGGER = "h-[22px] max-w-[240px] min-w-0 gap-1 rounded-md bg-wash px-1.5 text-2xs font-normal text-ink-muted hover:bg-wash-strong aria-expanded:bg-wash-strong [&_svg]:size-3";
const PICKER_ICONS = { account: KeyRound, model: Cpu, mode: Shield, containment: Box };
/** Text renderers keep their badges; the window draws icons beside these words. */
export const modeLabel = (words: string): string => words.replace(/^[⏸⏵]+\s*/, "");
const containmentLabel = (words: string): string => words.replace(/^[○◐●]\s*/, "");

/**
 * A picker's button and its menu. While the connection cannot do what it
 * does, the button is dim with the reason in its tooltip and opens nothing:
 * a press says the reason on the pane's line.
 */
const PickerButton = ({ name, value, offer, children, items, command, warning, columns, phoneItems }: PickerButtonProps) => {
  const [, say] = usePaneLine();
  const [opening, setOpening] = useState({ open: false, id: 0 });
  const { open } = opening;
  const setOpen = (next: boolean) => setOpening(current => ({ open: next, id: next && !current.open ? current.id + 1 : current.id }));
  const close = () => setOpening(current => current.id === opening.id ? { ...current, open: false } : current);
  const narrow = useNarrowRunPicker();
  const phone = useNarrowRunPicker(640);
  const modeSheet = phone && phoneItems !== undefined;
  const sheet = !!columns && narrow || modeSheet;
  useSlashCommand(command, () => (offer.status === "absent" ? say(offer.message) : setOpen(true)), offer);
  const request = use(RunPickerRequest);
  useEffect(() => {
    if (request?.command !== command) return;
    request.handled();
    if (offer.status === "absent") say(offer.message);
    else setOpen(true);
  }, [request, command, offer, say]);
  const label = `${name}: ${value}`;
  const Icon = PICKER_ICONS[command];
  const content = <><Icon aria-hidden="true" /><span className="min-w-0 truncate">{children}</span></>;
  if (offer.status === "absent") {
    return (
      <Tooltip content={`${label} · /${command} · ${offer.message}`}>
        <Button aria-label={label} aria-disabled="true" className={classes(TRIGGER, name === "Account" ? "shrink" : "shrink-0", "cursor-default text-ink-faint hover:bg-transparent")} onClick={() => say(offer.message)}>
          {content}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Menu open={open} onOpenChange={setOpen} modal={!columns || narrow}>
      <Tooltip content={`${label} · /${command}${warning === undefined ? "" : ` · ${warning}`}`} keys="Enter to open">
        <RunPickerTrigger sheet={sheet} openSheet={() => setOpen(true)}>
          <Button aria-label={label} className={classes(TRIGGER, name === "Account" ? "shrink" : "shrink-0")}>
            {content}
          </Button>
        </RunPickerTrigger>
      </Tooltip>
      <RunPickerContent sheet={sheet}
        onFocusCapture={modeSheet ? event => { if (event.target === event.currentTarget) focusModeSheet(event.currentTarget); } : undefined}
        onKeyDownCapture={modeSheet ? trapModeSheetTab : undefined} side="top" align="start" role={sheet ? "dialog" : "menu"} aria-label={modeSheet ? "Mode" : columns ? "Run choices" : undefined} {...(columns || modeSheet ? { "aria-labelledby": undefined } : {})} className={modeSheet ? "phone-mode-sheet rounded-[10px] p-0" : columns ? classes("w-auto max-w-[calc(100vw-16px)] rounded-[10px] p-0", narrow ? "overflow-y-auto" : "overflow-hidden") : "w-72 max-h-[320px] overflow-y-auto"}>
        {modeSheet ? <Fragment key={opening.id}>{phoneItems(close)}</Fragment> : items(close)}
      </RunPickerContent>
    </Menu>
  );
};

/** One item of a picker: what it names, dim when it is greyed, with a note after it and a line under it. */
const Item = (props: { readonly onSelect: () => void; readonly dim?: boolean; readonly note?: string | undefined; readonly under?: string | undefined; readonly selected?: boolean; readonly tooltip?: string; readonly children: ReactNode }) => (
  <MenuItem title={`${props.tooltip ?? "Choose"} · Enter to choose · ↑ ↓ Home End`} className={classes(props.selected && "bg-wash")} onSelect={props.onSelect}>
    <span className="flex min-w-0 flex-col">
      <span className={classes("flex items-baseline gap-2", props.dim === true && "text-ink-faint")}>
        <span>{props.children}</span>
        {props.note !== undefined && <span className="text-xs text-ink-faint">{props.note}</span>}
      </span>
      {props.under !== undefined && <span className="text-xs text-ink-faint">{props.under}</span>}
    </span>
    {props.selected && <Check aria-hidden="true" className="ml-auto size-3" />}
  </MenuItem>
);

/** What a menu says while it has nothing to list: it is reading, or why it could not. */
const Waiting = ({ children }: { readonly children: ReactNode }) => <p className="px-2 py-1.5 text-xs text-ink-faint">{children}</p>;

/** Whether the connection can call `name` on the environment, as the runtime says. */
const useOffer = (environmentId: string, name: CapabilityName): Offer => {
  const runtime = useRuntime();
  // The connections' phases: the answer is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  return runtime.capability(environmentId, name);
};

const NO_FAVOURITES: readonly string[] = [];

/** The environment's favourite models (`accounts.favouriteModels`) as the request cache last read them; none until they are read, or where they cannot be. */
const useFavouriteModels = (environmentId: string): readonly string[] => {
  const runtime = useRuntime();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "settings.get", {}), [runtime, environmentId]));
  return answer.result?.values["accounts.favouriteModels"] ?? NO_FAVOURITES;
};

/** The environment's name as the line says it. */
const useEnvironmentName = (environmentId: string): string => {
  const environments = useObservable(useRuntime().projections.environments);
  return environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;
};

/** The session's title as a line says it. */
const useSessionName = (environmentId: string, sessionId: string): string => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  return projection.summary?.title ?? "this session";
};

interface AccountPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly accountId: string | null;
}
interface ModelPickerProps extends AccountPickerProps {
  readonly model: RunChoice | undefined;
}

/** Both account and model chips expose the same runtime-owned dependencies. */
export const RunPickerColumns = ({ environmentId, sessionId, accountId, model, initialStage, close, compact = false }: ModelPickerProps & { readonly initialStage: "Accounts" | "Models"; readonly close: () => void; readonly compact?: boolean }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const environment = environments.find((view) => view.environmentId === environmentId);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const usage = useObservable(runtime.projections.usage);
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const listingModels = useOffer(environmentId, "models.list");
  const listingAccounts = useOffer(environmentId, "accounts.list");
  const adding = useOffer(environmentId, "accounts.add");
  const signingIn = useOffer(environmentId, "accounts.signin.start");
  const openSignIn = useSignInCard();
  const handOffOnto = useHandOffOnto(environmentId, sessionId);
  const [, choose] = useModelChoice(environmentId, sessionId);
  const [, say] = usePaneLine();
  const session = useSessionName(environmentId, sessionId);
  const windowIsNarrow = useNarrowRunPicker();
  const narrow = compact || windowIsNarrow;
  const [activeColumn, setActiveColumn] = useState<RunStage>(initialStage);
  const [query, setQuery] = useState("");
  const [othersOpen, setOthersOpen] = useState(false);
  const othersList = useRef<HTMLDivElement>(null);
  // Rows shown under Other models come into view in the list, which scrolls.
  useEffect(() => { if (othersOpen) othersList.current?.scrollIntoView?.({ block: "nearest" }); }, [othersOpen]);
  const favourites = useFavouriteModels(environmentId);
  const settingsWindow = useSettingsIfHeld();
  const models = catalogues.value === null ? [] : modelsOf(catalogues.value, accountId);
  const picked = pickerModels(catalogues.value ?? [], accountId, favourites, model?.model);
  const pin = pinWords(picked, favourites);
  const selected = models.find((entry) => entry.id === model?.model);
  const live = ["starting", "running", "parked"].includes(runs.state);
  const reason = live ? "Wait for this run to end before changing its account or model." : undefined;
  const chosen = (id: string, effort: string | null) => {
    if (reason !== undefined) return say(reason);
    if (listingModels.status === "absent") return say(listingModels.message);
    choose({ model: id, effort });
    if (narrow && models.find((entry) => entry.id === id)?.efforts.length) setActiveColumn("Effort");
    say(`The next run of ${session} goes out on ${id} at ${effort === null ? "its own effort" : `${effort} effort`}.`);
  };
  const pickAccount = (candidate: AccountRecord) => {
    if (reason !== undefined) return say(reason);
    if (listingAccounts.status === "absent") return say(listingAccounts.message);
    if (candidate.status.state !== "signed-in") {
      if (signingIn.status === "absent") return say(`Cannot sign ${candidate.label} in on ${environment?.name ?? THIS_MACHINE}: ${signingIn.message}`);
      close();
      return openSignIn(candidate);
    }
    close();
    handOffOnto(candidate);
  };
  const active = activeColumn === "Effort" && (selected?.efforts.length ?? 0) === 0 ? "Models" : activeColumn;
  const column = (name: "Accounts" | "Models" | "Effort", children: ReactNode) => <RunPickerColumn name={name} narrow={narrow} activeColumn={active} showEffortWithModel={false}>{children}</RunPickerColumn>;
  const visible = models.filter((entry) => `${entry.label ?? ""} ${entry.id}`.toLowerCase().includes(query.toLowerCase()));
  const accountLabel = (id: string) => accounts.value?.find((entry) => entry.id === id)?.label ?? id;
  const modelRow = (entry: ModelEntry) => <RunChoiceRow key={entry.id} icon={favourites.includes(entry.id) ? Star : Cpu} label={modelName(entry)} primary={entry.label ?? entry.id} machine={entry.label === null ? undefined : entry.id}
    selected={model?.model === entry.id} dim={live || listingModels.status === "absent"} note={entry.efforts.length > 0 ? "Supports effort" : "Uses its own effort"}
    onSelect={() => { setOthersOpen(false); chosen(entry.id, model?.model === entry.id && (model.effort === null || entry.efforts.includes(model.effort)) ? model.effort : null); }} />;
  // Other models: a flyout beside the column; in one column at a time (a phone's sheet), rows shown under their row, where a flyout has no room.
  const othersNote = `${picked.others.reduce((count, group) => count + group.models.length, 0)} more`;
  const otherGroups = picked.others.map((group) => <MenuGroup key={group.accountId} aria-label={picked.grouped ? accountLabel(group.accountId) : undefined}>
    {picked.grouped && <MenuLabel className="px-2.5 py-1.5">{accountLabel(group.accountId)}</MenuLabel>}
    {group.models.map(modelRow)}
  </MenuGroup>);
  return <div data-run-picker data-narrow={narrow ? "true" : undefined} className={classes("flex flex-col", narrow && "w-[min(512px,calc(100vw-16px))]")}
    onKeyDownCapture={moveInColumns}>
    {narrow && <RunPickerSteps stage={active} effort={(selected?.efforts.length ?? 0) > 0} change={setActiveColumn} />}
    {reason !== undefined && <Waiting>{reason}</Waiting>}
    <div className={classes("flex min-w-0 divide-hairline", narrow ? "flex-col divide-y" : "divide-x")}>
      {column("Accounts", <>
        {accounts.value === null ? <Waiting>{accounts.error ? `The accounts could not be read: ${accounts.error.message}` : "Reading the accounts…"}</Waiting> : <>
          {accounts.value.length === 0 && <Waiting>No accounts yet. Add an account to sign in.</Waiting>}
          {accounts.value.map((candidate) => <RunChoiceRow key={candidate.id} icon={candidate.id === accountId ? KeyRound : ArrowRightLeft}
            label={`${candidate.label} ${identityWords(candidate)}`} selected={candidate.id === accountId} dim={live || listingAccounts.status === "absent"}
            note={[ACCOUNT_STATUS_WORDS[candidate.status.state], candidate.id === accountId ? "this session" : candidate.status.state === "signed-in" ? "Fork onto this account" : "Sign in", candidate.provider].join(" · ")}
            under={readingWords(gaugeOf(usage.gauges, environmentId, candidate.id))} onSelect={() => pickAccount(candidate)} />)}
        </>}
        {accountId !== null && accounts.value !== null && !accounts.value.some((entry) => entry.id === accountId) && <Waiting>Stored account {accountId} is not listed on this environment.</Waiting>}
        {accounts.error !== null && <RunChoiceRow icon={RefreshCw} label="Refresh accounts" onSelect={() => runtime.requests.refresh(environmentId, "accounts.list", {})} />}
        {listingAccounts.status === "absent" && <Waiting>{listingAccounts.message}</Waiting>}
        <MenuSeparator />
        <RunChoiceRow icon={Plus} label="Add an account…" dim={adding.status === "absent"} under={adding.status === "absent" ? adding.message : undefined}
          onSelect={() => { close(); if (adding.status === "absent") say(`Cannot add an account on ${environment?.name ?? THIS_MACHINE}: ${adding.message}`); else openSignIn(null); }} />
      </>)}
      {column("Models", <>
        {catalogues.value === null ? <Waiting>{catalogues.error ? `The models could not be read: ${catalogues.error.message}` : "Reading the models…"}</Waiting> : <>
          {models.length > 12 && <label title="Search models · Type to filter · Tab next column" className="mb-1 flex items-center gap-2 rounded-md bg-wash px-2"><Search aria-hidden="true" className="size-3" /><input aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 min-w-0 w-full bg-transparent text-xs outline-none" /></label>}
          {query !== "" ? visible.map(modelRow) : <>
            {pin !== undefined && models.length > 0 && <Waiting>{pin}</Waiting>}
            {picked.quick.map(modelRow)}
            {picked.others.length > 0 && (narrow ? <>
              <RunChoiceRow icon={Layers} label="Other models" note={othersNote} expanded={othersOpen} onSelect={() => setOthersOpen(!othersOpen)} />
              {othersOpen && <div ref={othersList} role="group" aria-label="Other models" data-other-models-list className="ml-3 border-l border-hairline pl-1">{otherGroups}</div>}
            </> : <MenuSub open={othersOpen} onOpenChange={setOthersOpen}>
              <MenuSubTrigger aria-label="Other models" title="Other models · Right arrow to open · ↑ ↓ Home End" data-other-models className="items-start gap-2 px-2.5 py-2 text-xs [&_svg]:size-3">
                <Layers aria-hidden="true" className="mt-0.5" /><span className="min-w-0 flex-1"><span className="block font-medium">Other models</span><span className="block text-2xs text-ink-muted">{othersNote}</span></span>
              </MenuSubTrigger>
              <MenuSubContent aria-label="Other models" data-other-models-list className="w-72 max-h-[320px] overflow-y-auto p-1.5">{otherGroups}</MenuSubContent>
            </MenuSub>)}
            {settingsWindow !== null && models.length > 0 && <RunChoiceRow icon={Star} label={picked.pinned ? "Edit favourites…" : "Pin favourites…"} under="In Settings, Default account and model."
              onSelect={() => { close(); settingsWindow.open("accounts.default-model", environmentId); }} />}
          </>}
          {model !== undefined && selected === undefined && <Waiting>Stored model {model.model} is not listed for this account. Choose an available model for the next run.</Waiting>}
          {models.length === 0 && <Waiting>No model is listed for this account.</Waiting>}
          {models.length > 0 && visible.length === 0 && <Waiting>No models match your search.</Waiting>}
        </>}
        {catalogues.error !== null && <RunChoiceRow icon={RefreshCw} label="Refresh models" onSelect={() => runtime.requests.refresh(environmentId, "models.list", {})} />}
        {listingModels.status === "absent" && <Waiting>{listingModels.message}</Waiting>}
      </>)}
      {selected !== undefined && selected.efforts.length > 0 && column("Effort", <>
        {[null, ...selected.efforts].map((effort) => <RunChoiceRow key={effort ?? "own"} icon={SlidersHorizontal} label={effort ?? "its own effort"}
          selected={model?.effort === effort} dim={live || listingModels.status === "absent"} note={model?.effort === effort ? "this session" : undefined}
          under={effort === null ? "Let the model choose its effort." : "Reasoning effort for the next run."}
          onSelect={() => { chosen(selected.id, effort); if (!live && listingModels.status === "present") close(); }} />)}
        {model?.effort !== null && model?.effort !== undefined && !selected.efforts.includes(model.effort) && <Waiting>Stored effort {model.effort} is not supported by this model.</Waiting>}
      </>)}
    </div>
    <div role="group" aria-label="More choices" data-run-column="More choices" className="flex items-center gap-2 border-t border-hairline p-1.5">
      <ModeSubmenu environmentId={environmentId} sessionId={sessionId} />
      <SessionBrowserPicker environmentId={environmentId} sessionId={sessionId} submenu />
    </div>
  </div>;
};

/** A session never moves environment; choosing another account invokes the runtime's fork. */
export const AccountPicker = ({ environmentId, sessionId, accountId }: AccountPickerProps) => {
  const runtime = useRuntime();
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [choice] = useModelChoice(environmentId, sessionId);
  const names = useObservable(useMemo(() => runtime.projections.accountNames(environmentId), [runtime, environmentId]));
  const account = accounts.value?.find((candidate) => candidate.id === accountId);
  // Until the environment lists the account, the name this window last saw of it, else that it was never read: never its id.
  const kept = accountId === null ? undefined : names.names[accountId];
  const value = accountId === null ? "default account" : account !== undefined ? `${account.label} ${identityWords(account)}` : kept !== undefined ? `${kept} · last seen` : UNREAD_ACCOUNT;
  const model = choice ?? (projection.summary?.model ? { model: projection.summary.model, effort: null } : undefined);
  return <PickerButton name="Account" command="account" value={value} offer={useOffer(environmentId, "accounts.list")} columns
    items={(close) => <RunPickerColumns environmentId={environmentId} sessionId={sessionId} accountId={accountId} model={model} initialStage="Accounts" close={close} />}>
    <span className="truncate">{value}</span>
  </PickerButton>;
};

export const ModelPicker = ({ environmentId, sessionId, accountId, model }: ModelPickerProps) => {
  const runtime = useRuntime();
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const [choice] = useModelChoice(environmentId, sessionId);
  const handedOnto = useHandedOnto(environmentId, sessionId);
  const current = choice ?? model;
  const unavailable = current !== undefined && catalogues.value !== null && !modelsOf(catalogues.value, accountId ?? handedOnto ?? null).some((entry) => entry.id === current.model);
  const words = current === undefined ? "default model" : current.effort !== null ? `${current.model} ${current.effort}` : current.model;
  return <PickerButton name="Model" command="model" value={words} offer={useOffer(environmentId, "models.list")} columns
    items={(close) => <RunPickerColumns environmentId={environmentId} sessionId={sessionId} accountId={accountId} model={current} initialStage="Models" close={close} />}
    warning={unavailable ? "This stored model is not listed for this account. Choose an available model for the next run." : undefined}>
    <span className={unavailable ? "text-amber" : current === undefined ? "text-ink-faint" : "text-ink"}>{words}</span>
  </PickerButton>;
};

interface ModePickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The mode badge the status line shows, with its clamp, in words. */
  readonly value: string;
  readonly children: ReactNode;
}

const ModeRows = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const runtime = useRuntime();
  const picker = useObservable(useMemo(() => runtime.projections.modes(environmentId), [runtime, environmentId]));
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [, say] = usePaneLine();
  const session = projection.summary?.title ?? "this session";
  const own = sessionModeOf(projection.summary?.mode, picker.ceiling);
  return picker.modes.map(({ mode, allowed }) => (
      <Item
        key={mode}
        onSelect={() => void setSessionMode(runtime, environmentId, sessionId, mode, session).then((set) => say(set.line))}
        dim={!allowed}
        selected={mode === own}
        tooltip={modeLabel(MODE_BADGE_WORDS[mode])}
        note={!allowed ? aboveCeilingWords(picker.ceiling) : mode === own ? "this session" : undefined}
        under={mode === "bypassPermissions" ? BYPASS_SENTENCE : undefined}
      >
        <Shield aria-hidden="true" className="mr-1 inline size-3" />{modeLabel(MODE_BADGE_WORDS[mode])}
      </Item>
    ));
};

const ModeSubmenu = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const offer = useOffer(environmentId, "permissions.mode.set");
  return <MenuSub>
    <MenuSubTrigger title={`Mode · Right arrow to open${offer.status === "absent" ? ` · ${offer.message}` : ""}`} disabled={offer.status === "absent"}><Shield aria-hidden="true" />Mode</MenuSubTrigger>
    <MenuSubContent aria-label="Mode" className="w-72 max-h-[320px] overflow-y-auto"><ModeRows environmentId={environmentId} sessionId={sessionId} /></MenuSubContent>
  </MenuSub>;
};

/** The mode picker: the four modes, one above the connection's ceiling greyed with the ceiling named, and the clamp said once set. */
export const ModePicker = ({ environmentId, sessionId, value, children }: ModePickerProps) => {
  const setting = useOffer(environmentId, "permissions.mode.set");
  const items = () => <ModeRows environmentId={environmentId} sessionId={sessionId} />;
  return (
    <PickerButton name="Mode" command="mode" value={value} offer={setting} items={items} phoneItems={(close) => <ModeSheet environmentId={environmentId} sessionId={sessionId} close={close} />}>
      {children}
    </PickerButton>
  );
};

interface ContainmentPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The level the status line shows: the session's own, or the default marked so. */
  readonly containment: ContainmentBadge | undefined;
}

/** The containment picker: the three levels, one the environment cannot enforce greyed with the probe's reason. */
export const ContainmentPicker = ({ environmentId, sessionId, containment }: ContainmentPickerProps) => {
  const runtime = useRuntime();
  const permissions = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const setting = useOffer(environmentId, "permissions.containment.set");
  const [, say] = usePaneLine();
  const session = useSessionName(environmentId, sessionId);
  const environment = useEnvironmentName(environmentId);
  const report = permissions?.result?.containment;
  const value = containment === undefined ? "containment not read yet" : containmentLabel(containmentWords(containment.level, containment.isDefault));

  const items = () => (
    <>
      {CONTAINMENT_LEVELS.map((level) => {
        const availability = report?.levels.find((candidate) => candidate.level === level);
        const unavailable = availability?.available === false ? (availability.reason ?? "the environment cannot enforce it") : undefined;
        const marked = containment?.level === level ? (containment.isDefault ? "the default" : "this session") : undefined;
        return (
          <Item
            key={level}
            onSelect={() => void setSessionContainment(runtime, environmentId, sessionId, level, { session, environment }).then((set) => say(set.line))}
            dim={unavailable !== undefined}
            selected={containment?.level === level}
            tooltip={containmentLabel(containmentWords(level, false))}
            note={unavailable !== undefined ? `not available here: ${unavailable}` : marked}
          >
            <Box aria-hidden="true" className="mr-1 inline size-3" />{containmentLabel(containmentWords(level, false))}
          </Item>
        );
      })}
      {permissions?.error && <Waiting>What {environment} can enforce could not be read: {permissions.error.message}</Waiting>}
    </>
  );
  return (
    <PickerButton name="Containment" command="containment" value={value} offer={setting} items={items}>
      <span className={containment?.level === "off" ? "text-amber" : undefined}>{value}</span>
    </PickerButton>
  );
};
