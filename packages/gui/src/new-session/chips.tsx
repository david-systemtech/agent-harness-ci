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
import { useState, type ComponentType, type ReactNode } from "react";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { nameOf } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { WorkspacePopover } from "../workspace/picker.js";
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

const CHIP = "h-7 min-w-0 max-w-64 gap-1 border border-line px-2 text-xs font-normal text-ink-muted";

/** A chip's face: what it picks, and the value it holds. */
const Face = ({ name, children }: { readonly name: string; readonly children: ReactNode }) => (
  <>
    <span className="text-ink-faint">{name}</span>
    <span className="flex min-w-0 items-center gap-1 truncate text-ink">{children}</span>
  </>
);

/** A chip opening a menu of its options. */
const ChipMenu = ({ name, value, children, items }: { readonly name: string; readonly value: string; readonly children: ReactNode; readonly items: ReactNode }) => (
  <Menu>
    <MenuTrigger asChild>
      <Button aria-label={`${name}: ${value}`} className={CHIP}>
        <Face name={name}>{children}</Face>
      </Button>
    </MenuTrigger>
    <MenuContent align="start" className="max-h-96 max-w-md overflow-y-auto">
      {items}
    </MenuContent>
  </Menu>
);

/** One option of a chip's menu, dim with its reason under it while it cannot be chosen, and with a note after it. */
const Option = (props: { readonly onSelect: () => void; readonly absent?: string | null; readonly note?: string | undefined; readonly children: ReactNode }) => (
  <MenuItem onSelect={props.onSelect} disabled={props.absent != null}>
    <span className="flex min-w-0 flex-col">
      <span className={classes("flex items-center gap-2", props.absent != null && "text-ink-faint")}>
        {props.children}
        {props.note !== undefined && <span className="text-xs text-ink-faint">{props.note}</span>}
      </span>
      {props.absent != null && <span className="text-xs text-ink-faint">{props.absent}</span>}
    </span>
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
              note={environment.environmentId === value ? HELD : undefined}
              onSelect={() => choose({ environmentId: environment.environmentId })}
            >
              <EnvironmentGlyph view={environment} />
              {nameOf(environment)}
            </Option>
          ))
        )
      }
    >
      {chosen !== undefined && <EnvironmentGlyph view={chosen} />}
      {words}
    </ChipMenu>
  );
};

/** The account the session's runs use: the environment's accounts, with their sign-in status; its plan reading beside it. */
const AccountChip = ({ view, choose }: ChipProps) => {
  const environmentId = view.environment.value;
  const { value, options, gauge } = view.account;
  const words = value === null ? "none" : `${value.label} ${identityWords(value)}`;
  const reading = readingWords(gauge ?? undefined);
  return (
    <ChipMenu
      name="Account"
      value={words}
      items={
        environmentId === null || options.length === 0 ? (
          <Nothing>{environmentId === null ? "Choose an environment first." : "The environment holds no account yet."}</Nothing>
        ) : (
          options.map((account) => (
            <Option
              key={account.id}
              note={[ACCOUNT_STATUS_WORDS[account.status.state], ...(account.id === value?.id ? [HELD] : [])].join(" · ")}
              onSelect={() => choose({ account: { environmentId, accountId: account.id } })}
            >
              <span className="font-medium">{account.label}</span> <span className="text-ink-muted">{identityWords(account)}</span>
            </Option>
          ))
        )
      }
    >
      {words}
      {reading !== undefined && <span className="text-ink-faint">{reading}</span>}
    </ChipMenu>
  );
};

/** The model the session's runs use: the models its account offers. */
const ModelChip = ({ view, choose }: ChipProps) => {
  const { value, options } = view.model;
  const words = value === null ? "none" : modelName(value);
  return (
    <ChipMenu
      name="Model"
      value={words}
      items={
        options.length === 0 ? (
          <Nothing>{view.account.value === null ? "Choose an account first: its models are the ones offered." : "The account offers no model yet."}</Nothing>
        ) : (
          options.map((model) => (
            <Option key={model.id} note={model.id === value?.id ? HELD : undefined} onSelect={() => choose({ model: model.id })}>
              {modelName(model)}
            </Option>
          ))
        )
      }
    >
      {words}
    </ChipMenu>
  );
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
      <PopoverTrigger asChild>
        <Button aria-label={`Workspace: ${words.label}`} title={words.path} disabled={environment === undefined} className={CHIP}>
          <Face name="Workspace">{words.label}</Face>
        </Button>
      </PopoverTrigger>
      {environment !== undefined && (
        <WorkspacePopover align="start" environment={environment} sessionId={sessionId} known={options} take={(request) => take(request, environment)} close={() => setOpen(false)} />
      )}
    </Popover>
  );
};

/** The chips in their order: environment, account, model, workspace. */
export const CHIPS: readonly ComponentType<ChipProps>[] = [EnvironmentChip, AccountChip, ModelChip, WorkspaceChip];
