import { useMemo, useState } from "react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { Part, SettingsCardGrid } from "../settings/part.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InstructionEditor } from "./instruction-editor.js";
import { InstructionButton } from "./instruction-button.js";
import { OwnedInstructionCard } from "./owned-instruction.js";
import { SuggestedInstructions } from "./suggested-instructions.js";
import { SetupOrientation } from "./setup-orientation.js";
import { SetupSeed } from "./setup-seed.js";
import { Orientation } from "./orientation.js";
import { afterReach, reachWords } from "../settings/generic-editor.js";
import { StepLinks } from "../settings/step-links.js";

/** The user layer on the picked environment, read from the runtime's live request cache. */
export const InstructionsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <InstructionsContent key={picked.environmentId} view={picked} />;
};

export const InstructionsContent = ({ view, setup = false }: { readonly view: EnvironmentView; readonly setup?: boolean }) => {
  const runtime = useRuntime();
  const listed = useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "instructions.list", {}), [runtime, view.environmentId]));
  const result = listed.result;
  const [editing, edit] = useState<string | null>(null);
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("knowledge.instructions").hint}</p>
      {!setup && <StepLinks steps={["instructions"]} />}
      {setup && <SetupSeed view={view} listed={listed} />}
      {view.phase !== "ready" && (
        <p className="text-sm text-amber">
          {result === null ? "No cached instructions." : "Cached instructions, stale."} {afterReach(reachWords(runtime, view), "read-only.")}
        </p>
      )}
      {listed.error !== null && result !== null && <p className="text-sm text-amber">Cached instructions, stale. {listed.error.message}</p>}
      {result !== null && (setup ? <SetupOrientation view={view} row={result.orientation} /> : <Orientation view={view} row={result.orientation} />)}
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
      {result !== null && <SuggestedInstructions environmentId={view.environmentId} rows={result.instructions} dismissed={result.dismissed} {...(setup && { custom: () => edit("new") })} />}
      {editing === "new" && (
        <InstructionEditor environmentId={view.environmentId} close={() => edit(null)} />
      )}
    </>
  );
};
