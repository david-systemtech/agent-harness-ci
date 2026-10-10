import { adminCall, plainRefusal, uuidv7, type PlainRefusal } from "@agent-harness/client-runtime";
import type { CarryOverMemoryFolder } from "@agent-harness/contracts";
import { FolderInput } from "lucide-react";
import { useState } from "react";
import type { TechnicalDetailsProps } from "../setup/details.js";
import { SetupNotice } from "../setup/notice.js";
import { Button, Select } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/**
 * A notes folder no transcript maps to a project (setup-copy.md §5.3): its
 * project picker, from the repositories of this environment's sessions, and
 * Use for these notes; before any chat is brought over there is none to pick.
 */
export const MemoryAssignment = ({
  environmentId,
  accountId,
  folder,
  details,
}: {
  readonly environmentId: string;
  readonly accountId: string;
  readonly folder: CarryOverMemoryFolder;
  readonly details: (line: string, details: readonly string[]) => TechnicalDetailsProps;
}) => {
  const runtime = useRuntime();
  const clock = useClock();
  const rows = useObservable(runtime.projections.sessionList).rows;
  const repositories = [
    ...new Set(
      rows.flatMap((row) =>
        row.environmentId === environmentId && row.summary.repositoryIdentity !== null ? [row.summary.repositoryIdentity] : [],
      ),
    ),
  ].sort();
  const [repository, choose] = useState("");
  const [busy, setBusy] = useState(false);
  const [assigned, setAssigned] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<PlainRefusal | undefined>(undefined);
  const writable = runtime.capability(environmentId, "carryOver.assignMemory").status === "present";
  const assign = async () => {
    setBusy(true);
    setAssigned(undefined);
    setRefused(undefined);
    const answer = await adminCall(() =>
      runtime.requests.call(environmentId, "carryOver.assignMemory", {
        commandId: uuidv7(clock.now()),
        accountId,
        folder: folder.folder,
        repositoryIdentity: repository,
      }),
    );
    setBusy(false);
    if (answer.ok) setAssigned(repository);
    else setRefused(plainRefusal(answer.refusal, "Use for these notes"));
    if (answer.ok)
      runtime.requests.refresh(environmentId, "carryOver.inventory", {
        accountId,
      });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline p-3">
      <p className="text-sm text-ink">Notes from {folder.folder} do not match a project here. Choose the project they belong to:</p>
      <Select
        title="Choose a project · Tab, Arrow keys"
        aria-label={`Project for the notes from ${folder.folder}`}
        value={repository}
        disabled={!writable || busy}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Choose a project</option>
        {repositories.map((identity) => (
          <option key={identity} value={identity}>
            {identity}
          </option>
        ))}
      </Select>
      <Button variant="outline" title="Use for these notes · Tab, Enter or Space" className="self-start" disabled={!writable || busy || !repositories.includes(repository)} onClick={() => void assign()}>
        <FolderInput aria-hidden="true" />Use for these notes
      </Button>
      {repositories.length === 0 && <p className="text-sm text-ink-muted">Bring your chats over first. Then you can choose a project for these notes.</p>}
      {assigned !== undefined && <p role="status" className="text-sm text-ink-muted">These notes now belong to {assigned}.</p>}
      {refused !== undefined && <SetupNotice tone="error" title={refused.line} details={details(refused.line, [`Folder: ${folder.path}`, ...refused.details])} />}
    </div>
  );
};
