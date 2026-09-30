import { derived, workspaceGoneLine, type DispatchFailure, type KnownDirectory } from "@agent-harness/client-runtime";
import type { WorkspaceRequest } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { resolverRefusal, type RefusalPlace } from "../new-session/words.js";
import { Button, Popover, PopoverContent, PopoverTrigger } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { WorkspacePicker } from "./picker.js";

/**
 * A session whose workspace is missing (workspace-picker spec, "Missing
 * workspaces" and "Renderers"; ADR 0021; #328, #421): its composer is
 * replaced by the gone path and Choose a workspace, which opens the
 * workspace picker on the session's environment and sends
 * `sessions.setWorkspace` with what is chosen there. The environment's
 * answer is awaited on the picker: accepted, the list's patch clears the
 * mark and the composer returns; refused, the picker says why in one line
 * and stays open. The pane's own line (a rename refused, say) is said under
 * it, as it is under the composer.
 */

/**
 * The session's workspace while the environment has found it gone: its
 * path, from the session's list row, which the environment's mark and
 * `sessions.setWorkspace` patch (#328); undefined while it is there.
 */
export const useGoneWorkspace = (environmentId: string, sessionId: string): string | undefined => {
  const runtime = useRuntime();
  return useObservable(
    useMemo(
      () =>
        derived([runtime.projections.sessionList] as const, (list) => {
          const summary = list.rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase())?.summary;
          return summary === undefined || summary.workspaceMissingSince === null ? undefined : summary.workspace.path;
        }),
      [runtime, environmentId, sessionId],
    ),
  );
};

export interface MissingWorkspaceProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The gone workspace's path. */
  readonly path: string;
  /** The pane's line. */
  readonly line: string | undefined;
}

/** Why the environment did not give the session the workspace chosen, in one line: the resolver's refusal, else what it says. */
const notChangedLine = (failure: DispatchFailure, request: WorkspaceRequest, place: RefusalPlace): string =>
  resolverRefusal(failure.data ?? {}, request, place) ?? `The workspace was not changed: ${failure.message}`;

export const MissingWorkspace = ({ environmentId, sessionId, path, line }: MissingWorkspaceProps) => {
  const runtime = useRuntime();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const known = useObservable(useMemo(() => runtime.projections.knownDirectories(environmentId), [runtime, environmentId]));
  const [open, setOpen] = useState(false);
  const setting = runtime.capability(environmentId, "sessions.setWorkspace");
  const absent = setting.status === "absent" ? setting.message : environment === undefined ? "This client no longer holds the session's environment." : undefined;

  const take = async (request: WorkspaceRequest): Promise<string | undefined> => {
    const answer = await runtime.commands.dispatch(environmentId, "sessions.setWorkspace", { sessionId, workspace: request });
    if (answer.ok) return undefined;
    const where = environment === undefined ? "the environment" : nameOf(environment);
    return notChangedLine(answer.error, request, { where, environmentId, rows: runtime.projections.sessionList.read().rows });
  };
  const hide = (directory: KnownDirectory): Promise<string | undefined> =>
    runtime.knownDirectories.hide(environmentId, directory.path).then(
      () => undefined,
      (error: unknown) => `Not hidden: ${error instanceof Error ? error.message : String(error)}`,
    );

  return (
    <div role="group" aria-label="The workspace is gone" className="flex shrink-0 flex-col gap-1.5 border-t border-hairline px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-amber">{workspaceGoneLine(path)}</p>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button tone="primary" disabled={absent !== undefined} title={absent}>
              Choose a workspace
            </Button>
          </PopoverTrigger>
          {environment !== undefined && (
            <PopoverContent align="end" aria-label={`Where it works on ${nameOf(environment)}`} className="flex w-96 flex-col gap-2">
              <WorkspacePicker environment={environment} sessionId={sessionId} known={known} take={take} hide={hide} close={() => setOpen(false)} />
            </PopoverContent>
          )}
        </Popover>
      </div>
      {absent !== undefined && <p className="text-xs text-ink-faint">{absent}</p>}
      {line !== undefined && (
        <p role="status" className="text-xs text-ink-muted">
          {line}
        </p>
      )}
    </div>
  );
};
