import { useMemo, useState } from "react";
import type { CachedAnswer, EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { Part, SettingsCardGrid } from "../settings/part.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InstructionEditor } from "./instruction-editor.js";
import { InstructionButton } from "./instruction-button.js";
import { OwnedInstructionCard } from "./owned-instruction.js";
import { SuggestedInstructions } from "./suggested-instructions.js";
import { Orientation } from "./orientation.js";
import { afterReach, reachWords } from "../settings/generic-editor.js";
import { StepLinks } from "../settings/step-links.js";

/** The user layer on the picked environment, read from the runtime's live request cache. */
export const InstructionsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <InstructionsContent key={picked.environmentId} view={picked} />;
};

/** The environment's instructions as the runtime's request cache holds them: live, or this window's last read. */
export const useListedInstructions = (view: EnvironmentView): CachedAnswer<"instructions.list"> => {
  const runtime = useRuntime();
  return useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "instructions.list", {}), [runtime, view.environmentId]));
};

/** Where the listed instructions stand while the environment is not ready, or its last read was refused. */
export const ListedReach = ({ view, listed }: { readonly view: EnvironmentView; readonly listed: CachedAnswer<"instructions.list"> }) => {
  const runtime = useRuntime();
  return (
    <>
      {view.phase !== "ready" && (
        <p className="text-sm text-amber">
          {listed.result === null ? "No cached instructions." : "Cached instructions, stale."} {afterReach(reachWords(runtime, view), "read-only.")}
        </p>
      )}
      {listed.error !== null && listed.result !== null && <p className="text-sm text-amber">Cached instructions, stale. {listed.error.message}</p>}
    </>
  );
};

/** Settings › Instructions: what agents are told about this computer, the owned instructions with their reach and order, and the catalogue. */
export const InstructionsContent = ({ view }: { readonly view: EnvironmentView }) => {
  const listed = useListedInstructions(view);
  const result = listed.result;
  const [editing, edit] = useState<string | null>(null);
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("knowledge.instructions").hint}</p>
      <StepLinks steps={["instructions"]} />
      <ListedReach view={view} listed={listed} />
      {result !== null && <Orientation view={view} row={result.orientation} />}
      <Part title="Owned instructions">
        <InstructionButton environmentId={view.environmentId} method="instructions.create" run={() => edit("new")}>
          New instruction
        </InstructionButton>
        {result === null ? (
          <p className="text-sm text-ink-muted">{listed.error?.message ?? "Reading the instructions…"}</p>
        ) : result.instructions.length === 0 ? (
          <p className="text-sm text-ink-muted">No owned instruction on this environment.</p>
        ) : (
          <SettingsCardGrid>{result.instructions.map((row) => <OwnedInstructionCard key={row.id} environmentId={view.environmentId} row={row} rows={result.instructions} edit={() => edit(row.id)} {...(editing === row.id && { editor: <InstructionEditor inline environmentId={view.environmentId} row={row} close={() => edit(null)} /> })} />)}</SettingsCardGrid>
        )}
      </Part>
      {result !== null && <SuggestedInstructions environmentId={view.environmentId} rows={result.instructions} dismissed={result.dismissed} />}
      {editing === "new" && (
        <InstructionEditor environmentId={view.environmentId} close={() => edit(null)} />
      )}
    </>
  );
};
