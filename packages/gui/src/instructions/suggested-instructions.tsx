import { uuidv4 } from "@agent-harness/client-runtime";
import { CATALOGUE, CATALOGUE_SEED_INSTRUCTION_ID, type OwnedInstructionRow } from "@agent-harness/contracts";
import { useState } from "react";
import { Part, SettingsCardGrid } from "../settings/part.js";
import { Fold } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { InstructionButton } from "./instruction-button.js";
import { useInstructionCommand } from "./use-instruction-command.js";

/** Tick state and the Dismissed fold come only from instructions.list. */
export const SuggestedInstructions = ({
  environmentId,
  rows,
  dismissed,
}: {
  readonly environmentId: string;
  readonly rows: readonly OwnedInstructionRow[];
  readonly dismissed: readonly string[];
}) => {
  const runtime = useRuntime();
  const { send, sending, line } = useInstructionCommand(environmentId);
  const [expanded, expand] = useState(false);
  const create = runtime.capability(environmentId, "instructions.create");
  return (
    <Part title="Suggested instructions">
      {CATALOGUE.instructions.groups.map((group) => (
        <Part key={group.id} title={group.title}>
          {group.id === "custom" && <p className="text-sm text-ink-muted">Write your own with New instruction above.</p>}
          <SettingsCardGrid>{CATALOGUE.instructions.entries
            .filter((entry) => entry.group === group.id && !dismissed.includes(entry.id))
            .map((entry) => {
              const ticked = rows.some((row) => row.origin?.catalogueId === entry.id);
              return (
                <div key={entry.id} className="flex flex-col gap-1 rounded-md border border-line p-3">
                  <label className={ticked || create.status === "absent" ? "text-sm text-ink-faint" : "text-sm text-ink"}>
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={sending || ticked || create.status === "absent"}
                      onChange={() => void send("instructions.create", { id: uuidv4(), catalogueId: entry.id })}
                    />{" "}
                    {entry.title}
                  </label>
                  <p className="text-sm text-ink-muted">{entry.summary}</p>
                  {ticked && <p className="text-xs text-ink-muted">Owned above; remove its copies to untick.</p>}
                  {create.status === "absent" && <p className="text-xs text-ink-faint">{create.message}</p>}
                  <InstructionButton
                    environmentId={environmentId}
                    method="instructions.dismissSuggestion"
                    busy={sending}
                    {...(ticked && { reason: "Remove the owned copies to dismiss this suggestion." })}
                    run={() => void send("instructions.dismissSuggestion", { catalogueId: entry.id })}
                  >
                    Dismiss {entry.title}
                  </InstructionButton>
                </div>
              );
            })}</SettingsCardGrid>
        </Part>
      ))}
      <Fold summary="Dismissed" open={expanded} onOpenChange={expand}>
        <Part title="Dismissed suggestions">
          {dismissed.length === 0 && <p className="text-sm text-ink-muted">No suggestion is dismissed.</p>}
          {dismissed.map((id) => (
            <InstructionButton
              key={id}
              environmentId={environmentId}
              method="instructions.restoreSuggestion"
              busy={sending}
              run={() => void send("instructions.restoreSuggestion", { catalogueId: id })}
            >
              Restore {CATALOGUE.instructions.entries.find((entry) => entry.id === id)?.title ?? id}
            </InstructionButton>
          ))}
        </Part>
      </Fold>
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
    </Part>
  );
};

/**
 * Set up's Suggestions (setup-copy.md §5.10): each catalogue entry not
 * dismissed, but the seed that is Your note, as a tick with its one line.
 * A ticked one is a copy, which Settings › Instructions changes or removes.
 */
export const SetupSuggestions = ({ environmentId, rows, dismissed }: { readonly environmentId: string; readonly rows: readonly OwnedInstructionRow[]; readonly dismissed: readonly string[] }) => {
  const runtime = useRuntime();
  const { send, sending, line } = useInstructionCommand(environmentId);
  const create = runtime.capability(environmentId, "instructions.create");
  const entries = CATALOGUE.instructions.entries.filter((entry) => entry.id !== CATALOGUE_SEED_INSTRUCTION_ID && !dismissed.includes(entry.id));
  return (
    <Part title="Suggestions">
      <ul data-setup-suggestions className="flex flex-col gap-2">
        {entries.map((entry) => {
          const ticked = rows.some((row) => row.origin?.catalogueId === entry.id);
          return (
            <li key={entry.id} className="flex flex-col">
              <label className={ticked || create.status === "absent" ? "text-sm text-ink-muted" : "text-sm text-ink"}>
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={sending || ticked || create.status === "absent"}
                  onChange={() => void send("instructions.create", { id: uuidv4(), catalogueId: entry.id })}
                />{" "}
                {entry.title}
              </label>
              <p className="pl-5 text-sm text-ink-muted">{entry.summary}</p>
              {ticked && <p className="pl-5 text-xs text-ink-muted">Added. Change or remove it in Settings › Instructions.</p>}
            </li>
          );
        })}
      </ul>
      {create.status === "absent" && <p className="text-xs text-ink-faint">{create.message}</p>}
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
    </Part>
  );
};
