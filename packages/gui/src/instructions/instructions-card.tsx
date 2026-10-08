import type { EnvironmentView, SetupStepView } from "@agent-harness/client-runtime";
import { unreadSetupSteps } from "@agent-harness/contracts";
import { useState } from "react";
import { Part } from "../settings/part.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InstructionButton } from "./instruction-button.js";
import { InstructionError } from "./instruction-error.js";
import { InstructionEditor } from "./instruction-editor.js";
import { ListedReach, useListedInstructions } from "./instructions-pane.js";
import { GoToSteps, Orientation } from "./orientation.js";
import { useOrientationPreview } from "./setup-orientation.js";
import { isSetupNote, SetupSeed } from "./setup-seed.js";
import { SetupSuggestions } from "./suggested-instructions.js";

/**
 * The Instructions step (setup-copy.md §5.10): its line, with Go to the step
 * of each part of this computer's setup the block could not read; Your note,
 * the seeded About my setup and the notes the person wrote, each with Edit;
 * Suggestions; Write your own; and the fold of what agents are told about
 * this computer. Owned lists, their order and account reach stay in
 * Settings › Instructions. Only opening this card seeds About my setup.
 */
export const InstructionsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      {view !== undefined && <SetupInstructions key={environmentId} view={view} step={step} />}
    </>
  );
};

const SetupInstructions = ({ view, step }: { readonly view: EnvironmentView; readonly step: SetupStepView }) => {
  const listed = useListedInstructions(view);
  const result = listed.result;
  const [editing, edit] = useState<string | null>(null);
  const preview = useOrientationPreview(view, result?.orientation);
  const unread = step.result?.failing.includes("instructions.orientation-renders") === true ? unreadSetupSteps(preview.row?.unreadRegistries ?? []) : [];
  const notes = result === null ? [] : [...result.instructions.filter(isSetupNote), ...result.instructions.filter((row) => !isSetupNote(row) && row.origin === null)];
  return (
    <>
      {unread.length > 0 && <GoToSteps environmentId={view.environmentId} steps={unread} />}
      <SetupSeed view={view} listed={listed} />
      <ListedReach view={view} listed={listed} />
      {result === null ? (
        listed.error !== null ? <InstructionError>{listed.error.message}</InstructionError> : <p className="text-sm text-ink-muted">Reading the instructions…</p>
      ) : (
        <>
          {notes.length > 0 && (
            <Part title="Your note">
              {notes.map((row) => (
                <section key={row.id} aria-label={row.title} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-ink">{row.title}</span>
                    <InstructionButton environmentId={view.environmentId} method="instructions.edit" run={() => edit(row.id)}>Edit</InstructionButton>
                  </div>
                  {editing === row.id && <InstructionEditor inline environmentId={view.environmentId} row={row} close={() => edit(null)} />}
                </section>
              ))}
            </Part>
          )}
          <SetupSuggestions environmentId={view.environmentId} rows={result.instructions} dismissed={result.dismissed} />
        </>
      )}
      <InstructionButton environmentId={view.environmentId} method="instructions.create" run={() => edit("new")}>Write your own</InstructionButton>
      {preview.row !== undefined && <Orientation view={view} row={preview.row} setup />}
      {preview.error !== undefined && <InstructionError>Could not preview the run: {preview.error}</InstructionError>}
      {editing === "new" && <InstructionEditor environmentId={view.environmentId} close={() => edit(null)} />}
    </>
  );
};
