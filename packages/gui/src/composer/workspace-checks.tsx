import { workspaceName, type ChecksView } from "@agent-harness/client-runtime";
import { useMemo } from "react";
import { Folder, GitBranch, Hand, Terminal, CircleCheck, CircleMinus, CircleAlert } from "lucide-react";
import { usePaneGrid } from "../grid/grid.js";
import { useHandoffPicker } from "../status/pane-dialogs.js";
import { PhoneComposerSheet } from "./phone-composer-sheet.js";
import { Button, Dialog, DialogTrigger, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from "../ui/index.js";
import type { Offer } from "../keys/key-dispatch.js";
import { VerbButton } from "../session/verb-button.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { useSlashCommand } from "./slash-commands.js";

/** Configuration and execution belong to the Environment; this surface only reads and asks. */
export const useWorkspaceChecks = (environmentId: string, sessionId: string, say: (line: string | undefined) => void): ChecksView => {
  const runtime = useRuntime();
  const view = useObservable(useMemo(() => runtime.projections.checks(environmentId, sessionId), [runtime, environmentId, sessionId]));
  useSlashCommand("check", (argument) => {
    if (view.availability.status === "absent") return say(view.availability.message);
    const form = argument.trim();
    if (form === "") {
      void runtime.checks.get(environmentId, sessionId).then((answer) => {
        runtime.requests.refresh(environmentId, "checks.get", { sessionId });
        say(!answer.ok ? answer.error.message : answer.result.command === null ? `Check is off for ${answer.result.workspace}.` : `$ ${answer.result.command}`);
      });
    } else if (form === "now") {
      void runtime.checks.run(environmentId, sessionId).then((answer) => {
        const error = !answer.ok ? answer.error : answer.result.receipt.status === "rejected" ? answer.result.receipt.error : undefined;
        say(error === undefined ? "Check running on the Environment." : `${error.data?.["reason"] ?? error.code}: ${error.message}`);
      });
    } else {
      void runtime.checks.set(environmentId, sessionId, form === "off" ? null : argument).then((answer) => {
        say(!answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : form === "off" ? "Check is off." : "Check saved for this Workspace.");
      });
    }
  }, view.availability);
  return view;
};

export const WorkspaceCheck = ({ view, sendFailure, sending, compact = false }: { readonly view: ChecksView; readonly sendFailure: () => void; readonly sending: Offer; readonly compact?: boolean }) => {
  const shell = useShell();
  // The browser disclosure owns missing-rights guidance; do not repeat it above the message field.
  if (!compact && shell === undefined && view.availability.status === "absent" && view.availability.reason === "scope") return null;
  if (compact) {
    const state = view.availability.status === "absent" ? "unavailable" : view.offer !== null ? "failure ready to send" : view.value === null ? "reading" : view.value.command === null ? "off" : "configured";
    const Icon = state === "off" ? CircleMinus : state === "configured" ? CircleCheck : CircleAlert;
    return <Dialog>
      <DialogTrigger asChild><Button aria-label={`Workspace check: ${state}`}><Icon aria-hidden="true" className="size-4" /></Button></DialogTrigger>
      <PhoneComposerSheet title="Workspace check">
        {view.availability.status === "absent" ? <p className="text-sm text-ink-muted">{view.availability.message}</p> : view.value === null ? <p>{view.error?.message ?? "Reading Workspace check…"}</p> : <>
          <p className="break-all font-mono text-sm">{view.value.workspace}</p>
          {view.value.command === null ? <p>Check is off.</p> : <pre className="overflow-x-auto rounded-none bg-abyss p-2 text-sm">{`$ ${view.value.command}`}</pre>}
          <p className="text-sm text-ink-muted">Use /check &lt;command&gt; to configure, /check now to run, or /check off to clear.</p>
        </>}
        {view.offer !== null && <VerbButton does="Send the offered check output to the agent · /check" keys="Enter in an empty message" availability={sending} run={sendFailure}><Terminal aria-hidden="true" />Send failure</VerbButton>}
      </PhoneComposerSheet>
    </Dialog>;
  }
  return <section aria-label="Workspace check" className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
    {view.availability.status === "absent" ? <p className="text-ink-faint">{view.availability.message}</p> : view.value === null ? <p>{view.error?.message ?? "Reading Workspace check…"}</p> : (
      <>
        <p className="truncate font-mono text-2xs" title={view.value.workspace}>{view.value.workspace}</p>
        {view.value.command === null ? <p>Check is off.</p> : <pre className="flex min-w-0 items-center gap-1.5 truncate" title={view.value.command}><Terminal aria-hidden="true" className="size-3 shrink-0" />{`$ ${view.value.command}`}</pre>}
      </>
    )}
    {view.offer !== null && <VerbButton does="Send the offered check output to the agent · /check" keys="Enter in an empty message" availability={sending} run={sendFailure}><Terminal aria-hidden="true" className="size-3" />Send failure</VerbButton>}
  </section>;
};


/** Recent folders start a new session; an existing session's present workspace cannot be moved. */
export const WorkspaceRow = ({ environmentId, sessionId, compact = false }: { readonly environmentId: string; readonly sessionId: string; readonly compact?: boolean }) => {
  const runtime = useRuntime();
  const grid = usePaneGrid();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const known = useObservable(useMemo(() => runtime.projections.knownDirectories(environmentId), [runtime, environmentId]));
  const handoff = useHandoffPicker();
  const workspace = projection.summary?.workspace;
  const label = workspace === undefined ? undefined : workspaceName(workspace);
  const chooseDirectory = (path: string) => {
    const id = grid.newSession(environmentId);
    grid.chooseChips(id, (held) => ({ ...held, environmentId, workspace: { environmentId, request: { kind: "directory", path } } }));
  };
  if (compact) return <>
    <Dialog>
      <DialogTrigger asChild><Button aria-label={`Workspace: ${label ?? "Reading workspace"}`} data-workspace-chip className="min-w-0 flex-1 gap-1 rounded-md bg-wash px-2">
        <Folder aria-hidden="true" className="size-4 shrink-0" /><span className="truncate">{label ?? "Workspace"}</span>
      </Button></DialogTrigger>
      <PhoneComposerSheet title="Workspace">
        <p className="break-all font-mono text-sm">{workspace?.path ?? "Reading workspace…"}</p>
        {workspace?.kind === "worktree" && <p className="break-all text-sm">Branch: {workspace.branch}</p>}
        <h3 className="text-sm font-medium">Start a session in a recent folder</h3>
        {known.length === 0 && <p className="text-sm text-ink-muted">No recent folders</p>}
        {known.map(directory => <Button key={directory.path} disabled={directory.missingSince !== null} className="h-auto justify-start whitespace-normal break-all text-left" onClick={() => chooseDirectory(directory.path)}>
          <Folder aria-hidden="true" className="shrink-0" />{directory.path}{directory.missingSince !== null && " · Missing"}
        </Button>)}
      </PhoneComposerSheet>
    </Dialog>
    <Button aria-label="Hand off" data-handoff-chip onClick={() => handoff()}><Hand aria-hidden="true" className="size-4" /></Button>
  </>;
  return <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
    <Menu>
      <Tooltip content={`${workspace?.path ?? "Reading workspace…"} · Recent folders`} keys="Enter opens; arrows choose">
        <MenuTrigger asChild><Button aria-label="Recent folders" data-workspace-chip className="h-[22px] min-w-0 max-w-60 gap-1 rounded-md bg-wash px-1.5 font-mono text-2xs hover:bg-wash-strong">
          <Folder aria-hidden="true" className="size-3!" /><span className="truncate">{label ?? "Workspace"}</span>
          {workspace?.kind === "worktree" && <><GitBranch aria-hidden="true" className="size-3!" /><span className="truncate">{workspace.branch}</span></>}
        </Button></MenuTrigger>
      </Tooltip>
      <MenuContent align="start" aria-label="Recent folders">
        <MenuLabel>Start a session in</MenuLabel>
        {known.length === 0 && <MenuItem disabled><Folder aria-hidden="true" />No recent folders</MenuItem>}
        {known.map((directory) => <MenuItem key={directory.path} disabled={directory.missingSince !== null} title={`${directory.path}${directory.missingSince === null ? "" : " · Workspace is missing"} · Enter selects; arrows choose`} onSelect={() => {
          const id = grid.newSession(environmentId);
          grid.chooseChips(id, (held) => ({ ...held, environmentId, workspace: { environmentId, request: { kind: "directory", path: directory.path } } }));
        }}><Folder aria-hidden="true" /><span className="max-w-72 truncate font-mono text-xs">{directory.path}</span>{directory.missingSince !== null && <span className="text-amber">Missing</span>}</MenuItem>)}
      </MenuContent>
    </Menu>
    <Tooltip content="Hand off to another account · /handoff"><Button aria-label="Hand off" data-handoff-chip className="ml-auto h-[22px] gap-1 rounded-md px-1.5 text-2xs" onClick={() => handoff()}><Hand aria-hidden="true" className="size-3!" />Hand off</Button></Tooltip>
  </div>;
};
