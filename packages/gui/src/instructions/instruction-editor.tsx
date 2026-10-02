import { uuidv4 } from "@agent-harness/client-runtime";
import { MAX_INSTRUCTION_BODY, MAX_INSTRUCTION_TITLE, type OwnedInstructionRow } from "@agent-harness/contracts";
import { useState } from "react";
import { Button, Dialog, DialogContent, Field, Input } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useInstructionCommand } from "./use-instruction-command.js";

export const MarkdownField = ({ value, change, disabled = false }: { readonly value: string; change(text: string): void; readonly disabled?: boolean }) => (
  <Field label="Markdown body">
    <textarea
      className="min-h-40 rounded-md border border-line bg-inset p-2 text-sm text-ink outline-none focus-visible:border-beam disabled:text-ink-faint"
      maxLength={MAX_INSTRUCTION_BODY}
      value={value}
      onChange={(event) => change(event.target.value)}
      disabled={disabled}
    />
  </Field>
);

/** Only the typed draft is held here; saving never writes organisation state into presentation. */
export const InstructionEditor = ({ environmentId, row, close }: { readonly environmentId: string; readonly row?: OwnedInstructionRow; close(): void }) => {
  const runtime = useRuntime();
  const [heading, typeHeading] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  const [id] = useState(uuidv4);
  const { send, sending, line } = useInstructionCommand(environmentId);
  const method = row === undefined ? "instructions.create" : "instructions.edit";
  const offer = runtime.capability(environmentId, method);
  const disabled = sending || offer.status === "absent";
  const save = async () => {
    const saved =
      row === undefined ? await send("instructions.create", { id, title: heading, body }) : await send("instructions.edit", { instructionId: row.id, title: heading, body });
    if (saved) close();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={row === undefined ? "New instruction" : `Edit ${row.title}`} description="Markdown appended to runs of the accounts this instruction reaches.">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && heading.trim() !== "") void save();
          }}
        >
          <Field label="Title">
            <Input maxLength={MAX_INSTRUCTION_TITLE} value={heading} onChange={(event) => typeHeading(event.target.value)} disabled={disabled} />
          </Field>
          <MarkdownField value={body} change={setBody} disabled={disabled} />
          {offer.status === "absent" && <p className="text-sm text-ink-faint">{offer.message}</p>}
          {line !== undefined && (
            <p role="status" className="text-sm text-signal">
              {line}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" disabled={disabled || heading.trim() === ""}>
              Save instruction
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
