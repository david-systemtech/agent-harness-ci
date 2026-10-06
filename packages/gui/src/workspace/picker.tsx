import { repositoryWords, whenWords, type EnvironmentView, type KnownDirectory } from "@agent-harness/client-runtime";
import { RequestedDirectory, type WorkspaceRequest } from "@agent-harness/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { nameOf } from "../connections/words.js";
import { Input, PopoverContent } from "../ui/index.js";
import type { ComponentProps } from "react";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { Folder, ArrowLeft, EyeOff, GitBranch, Check } from "lucide-react";
import { Tooltip } from "../ui/tooltip.js";
import { useRuntime, useShell } from "../window-context.js";
import { Branches } from "./branches.js";
import { Browse, type BrowseAt } from "./browse.js";
import { Entry, PickerLine, ViewTitle } from "./parts.js";

/**
 * The workspace picker (workspace-picker spec, "Renderers" and "Browsing an
 * environment's directories"; docs/specs/gui.md, "A new session" and "A
 * session pane"; #420, #421): where a session works on its environment. It
 * offers the environment's known directories (a gone one marked and not
 * offered, each hidden from this client's list by its own button), a typed
 * path, browsing the environment (`workspaces.browse`), this computer's
 * directory dialog on the local environment, a worktree (a repository, then
 * its branch, `branches.tsx`), and scratch. The new-session
 * surface's workspace chip opens it, and so does a missing session's Choose
 * a workspace. What is chosen goes to `take` as a workspace request; while
 * the environment answers the picker waits, and a refusal is its one line,
 * the picker staying open for another choice.
 */

export interface WorkspacePickerProps {
  /** The environment it picks on. */
  readonly environment: EnvironmentView;
  /** The session the workspace is for: a new worktree branch's preset name is `agent-harness/` and its first eight characters. */
  readonly sessionId: string;
  /** The environment's known directories, less those hidden on this client. */
  readonly known: readonly KnownDirectory[];
  /** Takes a request: the refusal's one line, or nothing once it is taken, when the picker closes. */
  take(request: WorkspaceRequest): Promise<string | undefined>;
  /** Closes the picker. */
  close(): void;
}

/** The picker as a popover's content, beside what opens it, named for the environment it picks on. */
export const WorkspacePopover = ({ align, onCloseAutoFocus, ...picker }: WorkspacePickerProps & { readonly align: "start" | "end"; readonly onCloseAutoFocus?: ComponentProps<typeof PopoverContent>["onCloseAutoFocus"] }) => (
  <PopoverContent data-workspace-picker onCloseAutoFocus={onCloseAutoFocus} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); picker.close(); } event.stopPropagation(); }} align={align} aria-label={`Where it works on ${nameOf(picker.environment)}`} className="flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-xl p-4">
    <p className="text-sm text-ink-muted">Changing a workspace may need a new session.</p>
    <WorkspacePicker {...picker} />
  </PopoverContent>
);

/**
 * Which of its views the picker shows: its start; a browse, for a directory
 * to work in or a repository to make a worktree of; a worktree's repository,
 * then its branch. Back leaves each for the view it came from.
 */
type View =
  | { readonly kind: "start" }
  | { readonly kind: "browse"; readonly at: BrowseAt; readonly seeks: "directory" | "repository"; readonly back: View }
  | { readonly kind: "repository"; readonly back: View }
  | { readonly kind: "branch"; readonly repository: string; readonly back: View };

const START: View = { kind: "start" };

const WorkspacePicker = ({ environment, sessionId, known, take, close }: WorkspacePickerProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const { environmentId } = environment;
  const where = nameOf(environment);
  const [view, setView] = useState<View>(START);
  const [line, say] = useState<string | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [path, setPath] = useState("");
  // A choice answered after the picker closed says nothing: the picker is gone.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const show = (next: View) => {
    say(undefined);
    setView(next);
  };
  /** Takes `request`, waiting for the answer: closes when it says nothing, else says its line. */
  const choose = (request: WorkspaceRequest) => {
    if (waiting) return;
    setWaiting(true);
    say(`Waiting for ${where}'s answer…`);
    void take(request)
      .catch((error: unknown) => `${where} did not answer: ${error instanceof Error ? error.message : String(error)}`)
      .then((refused) => {
        if (!open.current) return;
        setWaiting(false);
        say(refused);
        if (refused === undefined) close();
      });
  };
  /** Takes a known directory off this client's list, until a session uses it again (`hiddenDirectories`). */
  const hide = (directory: KnownDirectory) =>
    void runtime.knownDirectories.hide(environmentId, directory.path).catch((error: unknown) => {
      if (open.current) say(`Not hidden: ${error instanceof Error ? error.message : String(error)}`);
    });

  const typed = RequestedDirectory.safeParse(path.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!typed.success) return say(`A workspace is a full path on ${where}, or one from its home (~).`);
    choose({ kind: "directory", path: typed.data });
  };
  const browsing = runtime.capability(environmentId, "workspaces.browse");
  const dialog = runtime.capability(environmentId, "shell.dialogs");
  /** The local environment's directory, from this computer's own dialog: checked by the environment like any path; a dialog that fails is the picker's line. */
  const pickHere = async () => {
    try {
      const picked = await shell?.dialogs?.openDirectory({ title: `Where the session works on ${where}` });
      if (picked !== undefined && open.current) choose({ kind: "directory", path: picked });
    } catch (error: unknown) {
      if (open.current) say(`This computer's dialog did not open: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const from = typed.success ? typed.data : undefined;
  /** The way to browse the environment, from the path typed when it is one. */
  const browse = (seeks: "directory" | "repository") => (
    <Way absent={browsing.status === "absent" ? browsing.message : undefined} disabled={waiting} onClick={() => show({ kind: "browse", at: { path: from, hidden: false }, seeks, back: view })}>
      {from === undefined ? `Browse ${where}…` : `Browse from ${from}…`}
    </Way>
  );

  if (view.kind === "browse") {
    const worktree = view.seeks === "repository";
    return (
      <Browse
        environmentId={environmentId}
        where={where}
        at={view.at}
        takeWords={(listed) => (worktree ? `Make the worktree from ${listed}` : `Work in ${listed}`)}
        take={(listed) => (worktree ? show({ kind: "branch", repository: listed, back: view }) : choose({ kind: "directory", path: listed }))}
        go={(to) => show({ ...view, at: { ...view.at, path: to }, back: view })}
        relist={(at) => show({ ...view, at })}
        back={() => show(view.back)}
        line={line}
        waiting={waiting}
      />
    );
  }
  if (view.kind === "branch") {
    return (
      <Branches
        place={{ where, environmentId, rows: runtime.projections.sessionList.read().rows }}
        repository={view.repository}
        sessionId={sessionId}
        choose={choose}
        back={() => show(view.back)}
        line={line}
        waiting={waiting}
      />
    );
  }
  if (view.kind === "repository") {
    const repository = (event: FormEvent) => {
      event.preventDefault();
      if (!typed.success) return say(`A repository is a full path on ${where}, or one from its home (~).`);
      show({ kind: "branch", repository: typed.data, back: view });
    };
    return (
      <>
        <ViewTitle>A worktree on {where}: its repository</ViewTitle>
        <ul aria-label="Known directories" className="flex max-h-64 flex-col overflow-y-auto">
          {known
            .filter((directory) => directory.missingSince === null)
            .map((directory) => (
              <Entry
                key={directory.path}
                name={directory.path}
                detail={directory.repositoryIdentity === null ? undefined : repositoryWords(directory.repositoryIdentity)}
                choose={() => show({ kind: "branch", repository: directory.path, back: view })}
              />
            ))}
        </ul>
        <form onSubmit={repository} className="flex gap-1.5">
          <Input className="min-w-0 font-mono" aria-label={`A repository on ${where}`} placeholder="a path in a repository" value={path} onChange={(event) => setPath(event.target.value)} />
          <Button icon={Check} keys="Enter" type="submit" disabled={path.trim() === ""}>
            Next
          </Button>
        </form>
        {browse("repository")}
        <PickerLine line={line} />
        <Button icon={ArrowLeft} className="self-start" onClick={() => show(view.back)}>
          Back
        </Button>
      </>
    );
  }

  return (
    <>
      <ViewTitle>Where it works on {where}</ViewTitle>
      {known.length > 0 && (
        <ul aria-label="Known directories" className="flex max-h-64 flex-col overflow-y-auto">
          {known.map((directory) => (
            <KnownDirectoryRow
              key={directory.path}
              directory={directory}
              disabled={waiting}
              take={() => choose({ kind: "directory", path: directory.path })}
              hide={() => hide(directory)}
            />
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex gap-1.5">
        <Input className="min-w-0 font-mono" aria-label={`A directory on ${where}`} placeholder="/full/path or ~/in/home" value={path} onChange={(event) => setPath(event.target.value)} />
        <Button icon={Check} keys="Enter" type="submit" disabled={path.trim() === "" || waiting}>
          Use
        </Button>
      </form>
      {browse("directory")}
      {environment.kind === "local" && (
        <Way absent={dialog.status === "absent" ? dialog.message : undefined} disabled={waiting} onClick={() => void pickHere()}>
          Pick on this computer…
        </Way>
      )}
      <Button icon={GitBranch} className="self-start" disabled={waiting} onClick={() => show({ kind: "repository", back: view })}>
        A worktree…
      </Button>
      <Button icon={Folder} className="self-start" disabled={waiting} onClick={() => choose({ kind: "scratch" })}>
        Scratch: a directory of its own
      </Button>
      <PickerLine line={line} />
    </>
  );
};

/** A way to choose a workspace that the connection or the shell may not offer: dim, with why under it, when not. */
const Way = ({ absent, disabled, onClick, children }: { readonly absent: string | undefined; readonly disabled: boolean; onClick(): void; readonly children: string }) => (
  <div className="flex flex-col items-start">
    <Button icon={Folder} title={absent} disabled={absent !== undefined || disabled} onClick={onClick}>
      {children}
    </Button>
    {absent !== undefined && <span className="px-3 text-xs text-ink-faint">{absent}</span>}
  </div>
);

/** A known directory: chosen by its path, with its repository or its gone mark, and hidden by its own button. */
const KnownDirectoryRow = ({ directory, disabled, take, hide }: { readonly directory: KnownDirectory; readonly disabled: boolean; take(): void; hide(): void }) => {
  const gone = directory.missingSince === null ? undefined : `gone since ${whenWords(new Date(directory.missingSince))}`;
  const under = gone ?? (directory.repositoryIdentity === null ? undefined : repositoryWords(directory.repositoryIdentity));
  return (
    <li className="flex items-center gap-2 rounded-lg border border-hairline bg-inset/60 px-2 py-1">
      <Tooltip content={gone ? `${directory.path} · ${gone}` : directory.path} keys="Enter / Space">
      <span role={gone ? "group" : undefined} tabIndex={gone ? 0 : undefined} aria-label={gone ? `${directory.path} · ${gone}` : undefined} className="min-w-0 flex-1">
      <button
        type="button"
        disabled={gone !== undefined || disabled}
        onClick={take}
        className="flex w-full min-w-0 flex-col rounded-lg px-2 py-1 text-left text-sm text-ink outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam disabled:text-ink-faint disabled:hover:bg-transparent"
      >
        <span className="flex min-w-0 items-center gap-2 font-mono"><Folder aria-hidden="true" className="size-4 shrink-0" /><span className="truncate">{directory.path}</span></span>
        {under !== undefined && <span className="truncate text-xs text-ink-faint">{under}</span>}
      </button>
      </span>
      </Tooltip>
      <Button icon={EyeOff} aria-label={`Hide ${directory.path}`} title="Hide it from this client's list" className="h-6 px-1.5 text-xs font-normal text-ink-muted" onClick={hide}>
        Hide
      </Button>
    </li>
  );
};
