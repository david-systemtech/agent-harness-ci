import {
  ACCOUNT_STATUS_WORDS,
  identityWords,
  modelName,
  readingWords,
  whenWords,
  type KnownDirectory,
  type NewSessionChips,
  type NewSessionView,
} from "@agent-harness/client-runtime";
import { RequestedDirectory, type WorkspaceRequest } from "@agent-harness/contracts";
import { useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { EnvironmentDot } from "../connections/environment-badge.js";
import { nameOf } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { Button, Input, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { repositoryWords, requestWords } from "./words.js";

/**
 * The new-session surface's chips (docs/specs/gui.md, "A new session";
 * workspace-picker spec, "The picker in the client runtime"; ADR 0005;
 * #420): environment, account, model, then workspace, each holding
 * `projections.newSession`'s preset until one is chosen on it, and changing
 * a chip re-runs the presets after it. An environment no session can start
 * on now is greyed with its reason. The workspace chip offers the
 * environment's known directories, each with its repository and a gone one
 * marked, and each hidden from this client's list by its own button; a
 * typed path; and scratch. The row is `CHIPS`, in order: a chip another
 * surface needs (#564's browser) joins it there, and the workspace chip's
 * ways (#421's Browse and Worktree) join `WorkspaceChip`.
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
              <EnvironmentDot view={environment} />
              {nameOf(environment)}
            </Option>
          ))
        )
      }
    >
      {chosen !== undefined && <EnvironmentDot view={chosen} />}
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
 * Where the session works: the environment's known directories, most
 * recent first, each with its repository, one found gone marked and not
 * offered, and each hidden from this client's list (`hiddenDirectories`)
 * until a session uses it again; a typed path, a full one or one from the
 * environment's home; and scratch.
 */
const WorkspaceChip = ({ view, sessionId, choose, say }: ChipProps) => {
  const runtime = useRuntime();
  const rows = useObservable(runtime.projections.sessionList).rows;
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const environmentId = view.environment.value;
  const { value, options } = view.workspace;
  const environment = view.environment.options.find((option) => option.environment.environmentId === environmentId)?.environment;
  const where = environment === undefined ? "the environment" : nameOf(environment);
  const words = value === null || environmentId === null ? { label: "none", path: undefined } : requestWords(value, environmentId, sessionId, rows);

  const take = (request: WorkspaceRequest) => {
    if (environmentId === null) return;
    choose({ workspace: { environmentId, request } });
    setOpen(false);
  };
  const typed = (event: FormEvent) => {
    event.preventDefault();
    const full = RequestedDirectory.safeParse(path.trim());
    if (!full.success) return say(`A workspace is a full path on ${where}, or one from its home (~).`);
    setPath("");
    take({ kind: "directory", path: full.data });
  };
  const hide = (directory: KnownDirectory) => {
    if (environmentId === null) return;
    runtime.knownDirectories.hide(environmentId, directory.path).catch((error: unknown) => say(`Not hidden: ${error instanceof Error ? error.message : String(error)}`));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button aria-label={`Workspace: ${words.label}`} title={words.path} disabled={environmentId === null} className={CHIP}>
          <Face name="Workspace">{words.label}</Face>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={`Where it works on ${where}`} className="flex w-96 flex-col gap-2">
        <p className="text-xs font-medium text-ink-muted">Where it works on {where}</p>
        {options.length > 0 && (
          <ul aria-label="Known directories" className="flex max-h-64 flex-col overflow-y-auto">
            {options.map((directory) => (
              <KnownDirectoryRow key={directory.path} directory={directory} take={() => take({ kind: "directory", path: directory.path })} hide={() => hide(directory)} />
            ))}
          </ul>
        )}
        <form onSubmit={typed} className="flex gap-1.5">
          <Input aria-label={`A directory on ${where}`} placeholder="/full/path or ~/in/home" value={path} onChange={(event) => setPath(event.target.value)} />
          <Button type="submit" disabled={path.trim() === ""}>
            Use
          </Button>
        </form>
        <Button className="self-start" onClick={() => take({ kind: "scratch" })}>
          Scratch: a directory of its own
        </Button>
      </PopoverContent>
    </Popover>
  );
};

/** A known directory: chosen by its path, with its repository or its gone mark, and hidden by its own button. */
const KnownDirectoryRow = ({ directory, take, hide }: { readonly directory: KnownDirectory; take(): void; hide(): void }) => {
  const gone = directory.missingSince === null ? undefined : `gone since ${whenWords(new Date(directory.missingSince))}`;
  const under = gone ?? (directory.repositoryIdentity === null ? undefined : repositoryWords(directory.repositoryIdentity));
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        disabled={gone !== undefined}
        onClick={take}
        className="flex min-w-0 flex-1 flex-col rounded-sm px-2 py-1 text-left text-sm text-ink outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam disabled:text-ink-faint disabled:hover:bg-transparent"
      >
        <span className="truncate">{directory.path}</span>
        {under !== undefined && <span className="truncate text-xs text-ink-faint">{under}</span>}
      </button>
      <Button aria-label={`Hide ${directory.path}`} title="Hide it from this client's list" className="h-6 px-1.5 text-xs font-normal text-ink-muted" onClick={hide}>
        Hide
      </Button>
    </li>
  );
};

/** The chips in their order: environment, account, model, workspace. */
export const CHIPS: readonly ComponentType<ChipProps>[] = [EnvironmentChip, AccountChip, ModelChip, WorkspaceChip];
