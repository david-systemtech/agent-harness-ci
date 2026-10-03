import { adminCall, uuidv7 } from "@agent-harness/client-runtime";
import type { CarryOverMemoryFolder } from "@agent-harness/contracts";
import { FolderInput } from "lucide-react";
import { useState } from "react";
import { Button, Select } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** An unmappable folder's repository picker, derived from this environment's session identities. */
export const MemoryAssignment = ({
  environmentId,
  accountId,
  folder,
}: {
  readonly environmentId: string;
  readonly accountId: string;
  readonly folder: CarryOverMemoryFolder;
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
  const [line, say] = useState<string | undefined>(undefined);
  const writable = runtime.capability(environmentId, "carryOver.assignMemory").status === "present";
  const assign = async () => {
    setBusy(true);
    say(undefined);
    const answer = await adminCall(() =>
      runtime.requests.call(environmentId, "carryOver.assignMemory", {
        commandId: uuidv7(clock.now()),
        accountId,
        folder: folder.folder,
        repositoryIdentity: repository,
      }),
    );
    setBusy(false);
    say(answer.ok ? `Assigned ${folder.folder} to ${repository}.` : `Not assigned: ${answer.line}`);
    if (answer.ok)
      runtime.requests.refresh(environmentId, "carryOver.inventory", {
        accountId,
      });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline p-3">
      <p className="text-sm text-ink-muted">Unmappable memory: {folder.path}</p>
      <Select
        title="Choose a repository · Tab, Arrow keys"
        aria-label={`Repository for ${folder.folder}`}
        value={repository}
        disabled={!writable || busy}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Choose a repository</option>
        {repositories.map((identity) => (
          <option key={identity} value={identity}>
            {identity}
          </option>
        ))}
      </Select>
      <Button variant="outline" title="Assign memory · Tab, Enter or Space" className="self-start" disabled={!writable || busy || !repositories.includes(repository)} onClick={() => void assign()}>
        <FolderInput aria-hidden="true" />Assign memory: {folder.folder}
      </Button>
      {repositories.length === 0 && <p className="text-sm text-ink-muted">No repository identities on this environment yet.</p>}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
    </div>
  );
};
