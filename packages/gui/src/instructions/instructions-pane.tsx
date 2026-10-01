import { useMemo, useState } from "react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { Part } from "../settings/part.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InstructionEditor } from "./instruction-editor.js";
import { InstructionButton } from "./instruction-button.js";
import { OwnedInstructionCard } from "./owned-instruction.js";
import { SuggestedInstructions } from "./suggested-instructions.js";
import { Orientation } from "./orientation.js";
import { reachWords } from "../settings/generic-editor.js";
import { StepLinks } from "../settings/step-links.js";

/** The user layer on the picked environment, read from the runtime's live request cache. */
export const InstructionsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <InstructionsContent key={picked.environmentId} view={picked} />;
};

export const InstructionsContent = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const listed = useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "instructions.list", {}), [runtime, view.environmentId]));
  const result = listed.result;
  const [editing, edit] = useState<string | null>(null);
  const editingRow = result?.instructions.find((row) => row.id === editing);
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("knowledge.instructions").hint}</p>
      <StepLinks steps={["instructions"]} />
      {view.phase !== "ready" && (
        <p className="text-sm text-amber">
          {result === null ? "No cached instructions." : "Cached instructions, stale."} {reachWords(runtime, view)}: read-only.
        </p>
      )}
      {listed.error !== null && result !== null && <p className="text-sm text-amber">Cached instructions, stale. {listed.error.message}</p>}
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
          result.instructions.map((row) => <OwnedInstructionCard key={row.id} environmentId={view.environmentId} row={row} rows={result.instructions} edit={() => edit(row.id)} />)
        )}
      </Part>
      {result !== null && <SuggestedInstructions environmentId={view.environmentId} rows={result.instructions} dismissed={result.dismissed} />}
      {(editing === "new" || editingRow !== undefined) && (
        <InstructionEditor environmentId={view.environmentId} {...(editingRow !== undefined && { row: editingRow })} close={() => edit(null)} />
      )}
    </>
  );
};
