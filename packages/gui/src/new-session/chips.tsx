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
import { useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { glyphOf } from "../connections/environment-glyphs.js";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { nameOf } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { Button, Tooltip, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { WorkspacePopover } from "../workspace/picker.js";
import { BrowserChoiceMenu } from "../browser/choice-menu.js";
import { Check, Cpu, Folder, GitBranch, KeyRound, Server } from "lucide-react";
import { useSettings } from "../settings/settings-window.js";
import { checkRequest } from "./check.js";
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
const ChipMenu = ({ name, value, children, items, columns = false }: { readonly name: string; readonly value: string; readonly children: ReactNode; readonly items: ReactNode; readonly columns?: boolean }) => (
  <Menu modal={!columns}>
    <Tooltip content={`${name}: ${value} · Enter to open · ↑ ↓ to choose · Escape to close`}>
      <MenuTrigger asChild>
        <Button data-new-session-chip aria-label={`${name}: ${value}`} className={classes(CHIP, name === "Account" && "shrink")}>
          <Face>{children}</Face>
        </Button>
      </MenuTrigger>
    </Tooltip>
    <MenuContent side="top" align="start" className={columns ? "w-auto max-w-[calc(100vw-16px)] rounded-[10px] p-0" : "max-h-[320px] max-w-md overflow-y-auto"}>
      {items}
    </MenuContent>
  </Menu>
);

/** Options carry their selection, sign-in state and reason as words and an icon. */
const Option = (props: { readonly onSelect: () => void; readonly absent?: string | null; readonly note?: string | undefined; readonly selected?: boolean; readonly keepOpen?: boolean; readonly children: ReactNode }) => (
  <MenuItem title={["Enter to choose · ↑ ↓ Home End · Tab next column", props.note, props.absent].filter(Boolean).join(" · ")} onSelect={(event) => { if (props.keepOpen) event.preventDefault(); props.onSelect(); }} disabled={props.absent != null} className={classes("items-start gap-2 px-2.5 py-2 text-xs", props.selected && "bg-wash")}>
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

/** Arrows stay within a dependency list; Tab moves between the two columns. */
const moveInColumns = (event: KeyboardEvent<HTMLDivElement>) => {
  const target = event.target as HTMLElement;
  const column = target.closest("[data-new-session-list]");
  if (column === null) return;
  const rows = [...column.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])')];
  let next: HTMLElement | undefined;
  if (event.key === "Tab") {
    const columns = [...event.currentTarget.querySelectorAll("[data-new-session-list]")];
    const destination = columns[(columns.indexOf(column) + 1) % columns.length];
    next = destination?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])') ?? undefined;
  } else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows.at(-1);
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const at = rows.indexOf(target.closest<HTMLElement>('[role="menuitem"]') ?? target);
    next = rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
  }
  if (next !== undefined) { event.preventDefault(); event.stopPropagation(); next.focus(); }
};

/** A new session chooses through its projection; no session or hand-off exists yet. */
const AccountModelOptions = ({ view, choose }: ChipProps) => {
  const settings = useSettings();
  const environmentId = view.environment.value;
  const reading = readingWords(view.account.gauge ?? undefined);
  return <div className="flex flex-col sm:flex-row" onKeyDown={moveInColumns}>
    <div role="group" aria-label="Environment and account" className="w-[224px] max-w-full border-b border-hairline sm:border-r sm:border-b-0">
      <p className="px-4 py-2 text-xs font-medium">Environment and account</p>
      <div data-new-session-list className="max-h-[320px] overflow-y-auto p-1.5">
        {view.environment.options.map(({ environment, unusable }) => <Option key={environment.environmentId} selected={environment.environmentId === environmentId} absent={unusable} keepOpen onSelect={() => choose({ environmentId: environment.environmentId })}>
          <ChipGlyph view={environment} />{nameOf(environment)}
        </Option>)}
        {environmentId === null || view.account.options.length === 0 ? <Nothing>{environmentId === null ? "Choose an environment first." : "The environment holds no account yet."}</Nothing> : view.account.options.map((account) => <Option
          key={account.id} selected={account.id === view.account.value?.id} keepOpen={account.status.state === "signed-in"}
          note={[identityWords(account), account.provider, ACCOUNT_STATUS_WORDS[account.status.state], account.id === view.account.value?.id ? reading : undefined, account.id === view.account.value?.id ? HELD : undefined].filter(Boolean).join(" · ")}
          onSelect={() => choose({ account: { environmentId, accountId: account.id } })}
        ><KeyRound aria-hidden="true" className="size-3" /><span className="min-w-0 truncate font-medium">{account.label}</span></Option>)}
        {environmentId !== null && <Option onSelect={() => settings.open("accounts.accounts", environmentId)}><KeyRound aria-hidden="true" className="size-3" />{view.account.options.length === 0 ? "Sign in an account" : "Manage accounts"}</Option>}
      </div>
    </div>
    <div role="group" aria-label="Models" className="w-[256px] max-w-full">
      <p className="px-4 py-2 text-xs font-medium">Models</p>
      <div data-new-session-list className="max-h-[320px] overflow-y-auto p-1.5">
        {view.model.options.length === 0 ? <Nothing>{view.account.value === null ? "Choose an account first: its models are the ones offered." : "The account offers no model yet."}</Nothing> : view.model.options.map((model) => <Option key={model.id} selected={model.id === view.model.value?.id} note={model.id === view.model.value?.id ? HELD : undefined} onSelect={() => choose({ model: model.id })}>
          <Cpu aria-hidden="true" className="size-3" />{modelName(model)}
        </Option>)}
      </div>
    </div>
  </div>;
};

const AccountChip = (props: ChipProps) => {
  const value = props.view.account.value;
  const words = value === null ? "none" : `${value.label} ${identityWords(value)}`;
  return <ChipMenu name="Account" value={words} columns items={<AccountModelOptions {...props} />}><KeyRound aria-hidden="true" /><span className="truncate">{words}</span></ChipMenu>;
};

const ModelChip = (props: ChipProps) => {
  const value = props.view.model.value;
  const words = value === null ? "none" : modelName(value);
  return <ChipMenu name="Model" value={words} columns items={<AccountModelOptions {...props} />}><Cpu aria-hidden="true" /><span className="truncate">{words}</span></ChipMenu>;
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={[`Workspace: ${words.label}`, words.path, "Enter to open · Escape to close", environment === undefined ? "Choose an environment first." : undefined].filter(Boolean).join(" · ")}>
        <PopoverTrigger asChild>
          <Button data-new-session-chip aria-label={`Workspace: ${words.label}`} title={words.path} disabled={environment === undefined} className={classes(CHIP, "font-mono")}>
            <Folder aria-hidden="true" />{value?.kind === "worktree" && <GitBranch aria-hidden="true" />}<span className="truncate">{words.label}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {environment !== undefined && (
        <WorkspacePopover align="start" environment={environment} sessionId={sessionId} known={options} take={(request) => take(request, environment)} close={() => setOpen(false)} />
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
