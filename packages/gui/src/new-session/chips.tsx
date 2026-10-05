import {
  ACCOUNT_STATUS_WORDS,
  identityWords,
  modelName,
  readingWords,
  type EnvironmentView,
  type NewSessionChips,
  type NewSessionView,
} from "@agent-harness/client-runtime";
import type { WorkspaceRequest } from "@agent-harness/contracts";
import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { glyphOf } from "../connections/environment-glyphs.js";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { nameOf } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { Button, Tooltip, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { WorkspacePopover } from "../workspace/picker.js";
import { BrowserChoiceMenu } from "../browser/choice-menu.js";
import { Check, Cpu, Folder, GitBranch, KeyRound, Server, SlidersHorizontal } from "lucide-react";
import { useSettings } from "../settings/settings-window.js";
import { checkRequest } from "./check.js";
import { usePhoneOverlay } from "../ui/phone.js";
import { RunPickerColumn, RunPickerSteps, moveInColumns, useNarrowRunPicker, type RunStage } from "../status/run-picker-parts.js";
import { requestWords } from "./words.js";

/**
 * The new-session surface's chips (docs/specs/gui.md, "A new session";
 * workspace-picker spec, "The picker in the client runtime"; ADR 0005;
 * #420): environment, account, model, then workspace, each holding
 * `projections.newSession`'s preset until one is chosen on it, and changing
 * a chip re-runs the presets after it. An environment no session can start
 * on now is greyed with its reason. The workspace chip opens the workspace
 * picker (`../workspace/picker.tsx`, #421). The row is `CHIPS`, in order: a
 * chip another surface needs (#564's browser) joins it there.
 */

/** What each chip is drawn from, and what choosing on it does. */
export interface ChipProps {
  readonly view: NewSessionView;
  /** The id the session is created under: a new worktree branch's preset name shows it. */
  readonly sessionId: string;
  readonly effort?: string | null;
  /** Sets the chips chosen, the presets after them following. */
  choose(chips: NewSessionChips): void;
  /** Says a line on the surface: what could not be done. */
  say(line: string): void;
}

/** Every chip has an icon even before its environment advertises one. */
const ChipGlyph = ({ view }: { readonly view: EnvironmentView | undefined }) => glyphOf(view?.icon ?? null) === undefined ? <Server aria-hidden="true" className="size-3" /> : <EnvironmentGlyph view={view} />;

const CHIP = "h-[22px] min-w-0 max-w-[240px] gap-1 rounded-md bg-wash px-1.5 text-2xs font-normal text-ink-muted hover:bg-wash-strong aria-expanded:bg-wash-strong [&_svg]:size-3";

/** Keep each value on one line, with its full words in the trigger's tooltip. */
const Face = ({ children }: { readonly children: ReactNode }) => <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>;

/** A chip opening its options, with the account/model dependencies in one popup. */
const ChipMenu = ({ name, value, children, items, columns = false }: { readonly name: string; readonly value: string; readonly children: ReactNode; readonly items: ReactNode; readonly columns?: boolean }) => {
  const phone = usePhoneOverlay();
  const narrow = useNarrowRunPicker() || phone;
  return (
    <Menu modal={!columns || narrow}>
      <Tooltip content={`${name}: ${value} · Enter to open · ↑ ↓ to choose · Escape to close`}>
        <MenuTrigger asChild>
          <Button data-new-session-chip aria-label={`${name}: ${value}`} className={classes(CHIP, name === "Account" && "shrink")}>
            <Face>{children}</Face>
          </Button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent data-run-sheet={columns && narrow ? "" : undefined} role={columns && narrow ? "dialog" : "menu"} aria-label={columns ? "Run choices" : undefined} {...(columns ? { "aria-labelledby": undefined } : {})} side="top" align="start" className={columns ? "w-auto max-w-[calc(100vw-16px)] rounded-[10px] p-0" : "max-h-[320px] max-w-md overflow-y-auto"}>
        {items}
      </MenuContent>
    </Menu>
  );
};

/** Options carry their selection, sign-in state and reason as words and an icon. */
const Option = (props: { readonly onSelect: () => void; readonly absent?: string | null; readonly note?: string | undefined; readonly selected?: boolean; readonly keepOpen?: boolean; readonly children: ReactNode }) => (
  <MenuItem title={["Enter to choose · ↑ ↓ Home End · Tab next column", props.note, props.absent].filter(Boolean).join(" · ")} onSelect={(event) => { if (props.keepOpen) event.preventDefault(); props.onSelect(); }} disabled={props.absent != null} className={classes("items-start gap-2 px-2.5 py-2 text-xs [overflow-wrap:anywhere]", props.selected && "bg-wash")}>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className={classes("flex items-center gap-2", props.absent != null && "text-ink-faint")}>{props.children}</span>
      {props.note !== undefined && <span className="pl-5 text-2xs text-ink-muted [overflow-wrap:anywhere]">{props.note}</span>}
      {props.absent != null && <span className="text-2xs text-ink-faint">{props.absent}</span>}
    </span>
    {props.selected && <Check aria-hidden="true" className="mt-0.5 size-3" />}
  </MenuItem>
);

/** What a menu with nothing to list says. */
const Nothing = ({ children }: { readonly children: string }) => <p className="px-2 py-1.5 text-xs text-ink-faint">{children}</p>;

const HELD = "the chip's now";

/** The environment the session starts on: every environment this client knows, one no session can start on greyed with why. */
const EnvironmentChip = ({ view, choose }: ChipProps) => {
  const { value, options } = view.environment;
  const chosen = options.find((option) => option.environment.environmentId === value)?.environment;
  const words = chosen === undefined ? "none can start a session" : nameOf(chosen);
  return (
    <ChipMenu
      name="Environment"
      value={words}
      items={
        options.length === 0 ? (
          <Nothing>No environment is known here: pair one first.</Nothing>
        ) : (
          options.map(({ environment, unusable }) => (
            <Option
              key={environment.environmentId}
              absent={unusable}
              selected={environment.environmentId === value}
              note={environment.environmentId === value ? HELD : undefined}
              onSelect={() => choose({ environmentId: environment.environmentId })}
            >
              <ChipGlyph view={environment} />
              {nameOf(environment)}
            </Option>
          ))
        )
      }
    >
      <ChipGlyph view={chosen} />
      <span className="truncate">{words}</span>
    </ChipMenu>
  );
};

/** A new session chooses through its projection; no session or hand-off exists yet. */
const AccountModelOptions = ({ view, choose, effort, initialStage }: ChipProps & { readonly initialStage: RunStage }) => {
  const settings = useSettings();
  const phone = usePhoneOverlay();
  const narrow = useNarrowRunPicker() || phone;
  const [activeColumn, setActiveColumn] = useState<RunStage>(initialStage);
  const environmentId = view.environment.value;
  const reading = readingWords(view.account.gauge ?? undefined);
  const model = view.model.value;
  const hasEffort = (model?.efforts.length ?? 0) > 0;
  const active = activeColumn === "Effort" && !hasEffort ? "Models" : activeColumn;
  const column = (name: RunStage, children: ReactNode) => <RunPickerColumn name={name} narrow={narrow} activeColumn={active} showEffortWithModel={false}>{children}</RunPickerColumn>;
  return <div data-run-picker className={classes("flex flex-col", narrow && "w-[min(512px,calc(100vw-16px))]")} onKeyDownCapture={moveInColumns}>
    {narrow && <RunPickerSteps stage={active} effort={hasEffort} change={setActiveColumn} />}
    <div className={classes("flex min-w-0 divide-hairline", narrow ? "flex-col divide-y" : "divide-x")}>
      {column("Accounts", <>
        {environmentId === null || view.account.options.length === 0 ? <Nothing>{environmentId === null ? "Choose an environment first." : "The environment holds no account yet."}</Nothing> : view.account.options.map((account) => <Option
          key={account.id} selected={account.id === view.account.value?.id} keepOpen={account.status.state === "signed-in"}
          note={[identityWords(account), account.provider, ACCOUNT_STATUS_WORDS[account.status.state], account.id === view.account.value?.id ? reading : undefined, account.id === view.account.value?.id ? HELD : undefined].filter(Boolean).join(" · ")}
          onSelect={() => { choose({ account: { environmentId, accountId: account.id } }); if (narrow) setActiveColumn("Models"); }}
        ><KeyRound aria-hidden="true" className="size-3" /><span className="min-w-0 font-medium">{account.label}</span></Option>)}
        {environmentId !== null && <Option onSelect={() => settings.open("accounts.accounts", environmentId)}><KeyRound aria-hidden="true" className="size-3" />{view.account.options.length === 0 ? "Sign in an account" : "Manage accounts"}</Option>}
      </>)}
      {column("Models", <>
        {view.model.options.length === 0 ? <Nothing>{view.account.value === null ? "Choose an account first: its models are the ones offered." : "The account offers no model yet."}</Nothing> : view.model.options.map((entry) => <Option key={entry.id} selected={entry.id === model?.id} keepOpen={entry.efforts.length > 0} note={entry.id === model?.id ? HELD : undefined} onSelect={() => { choose({ model: entry.id }); if (narrow && entry.efforts.length > 0) setActiveColumn("Effort"); }}>
          <Cpu aria-hidden="true" className="size-3" />{modelName(entry)}
        </Option>)}
      </>)}
      {model !== null && hasEffort && column("Effort", <>
        {[null, ...model.efforts].map(value => <Option key={value ?? "own"} selected={(effort ?? null) === value} onSelect={() => choose({ model: model.id, effort: value })}>
          <SlidersHorizontal aria-hidden="true" className="size-3" />{value ?? "its own effort"}
        </Option>)}
      </>)}
    </div>
  </div>;
};

const AccountChip = (props: ChipProps) => {
  const value = props.view.account.value;
  const words = value === null ? "none" : `${value.label} ${identityWords(value)}`;
  return <ChipMenu name="Account" value={words} columns items={<AccountModelOptions {...props} initialStage="Accounts" />}><KeyRound aria-hidden="true" /><span className="truncate">{words}</span></ChipMenu>;
};

const ModelChip = (props: ChipProps) => {
  const value = props.view.model.value;
  const words = value === null ? "none" : modelName(value);
  return <ChipMenu name="Model" value={words} columns items={<AccountModelOptions {...props} initialStage="Models" />}><Cpu aria-hidden="true" /><span className="truncate">{words}</span></ChipMenu>;
};

/**
 * Where the session works: the workspace picker (`WorkspacePicker`) on the
 * chosen environment, over its known directories less those hidden here.
 * What is chosen there is checked against the environment first
 * (`checkRequest`), so the resolver's refusal is the picker's one line and
 * the picker stays open; what it takes sets the chip.
 */
const WorkspaceChip = ({ view, sessionId, choose }: ChipProps) => {
  const runtime = useRuntime();
  const rows = useObservable(runtime.projections.sessionList).rows;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const phone = usePhoneOverlay();
  const environmentId = view.environment.value;
  const { value, options } = view.workspace;
  const environment = view.environment.options.find((option) => option.environment.environmentId === environmentId)?.environment;
  const words = value === null || environmentId === null ? { label: "none", path: undefined } : requestWords(value, environmentId, sessionId, rows);

  const take = async (request: WorkspaceRequest, on: EnvironmentView): Promise<string | undefined> => {
    const refused = await checkRequest(runtime, sessionId, request, { where: nameOf(on), environmentId: on.environmentId, rows: runtime.projections.sessionList.read().rows });
    if (refused === undefined) choose({ workspace: { environmentId: on.environmentId, request } });
    return refused;
  };

  return (
    <Popover modal={phone} open={open} onOpenChange={setOpen}>
      <Tooltip content={[`Workspace: ${words.label}`, words.path, "Enter to open · Escape to close", environment === undefined ? "Choose an environment first." : undefined].filter(Boolean).join(" · ")}>
        <PopoverTrigger asChild>
          <Button ref={trigger} data-new-session-chip aria-label={`Workspace: ${words.label}`} title={words.path} disabled={environment === undefined} className={classes(CHIP, "font-mono")}>
            <Folder aria-hidden="true" />{value?.kind === "worktree" && <GitBranch aria-hidden="true" />}<span className="truncate">{words.label}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {environment !== undefined && (
        <WorkspacePopover onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} align="start" environment={environment} sessionId={sessionId} known={options} take={(request) => take(request, environment)} close={() => setOpen(false)} />
      )}
    </Popover>
  );
};

/** The browser preset follows the account until a person chooses on its chip. */
const BrowserChip = ({ view, choose }: ChipProps) => (
  <BrowserChoiceMenu rows={view.browser.options} choose={(value) => choose({ browser: value })} className={CHIP} />
);

/** The chips in their order: environment, account, model, workspace, browser. */
export const CHIPS: readonly ComponentType<ChipProps>[] = [EnvironmentChip, AccountChip, ModelChip, WorkspaceChip, BrowserChip];
