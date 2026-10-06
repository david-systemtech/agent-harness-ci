import { uuidv4 } from "@agent-harness/client-runtime";
import { MAX_INSTRUCTION_BODY, MAX_INSTRUCTION_TITLE, type OwnedInstructionRow } from "@agent-harness/contracts";
import { Save, X, Type, FileText } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, DialogContent, Field, Input, Tooltip } from "../ui/index.js";
import { MarkdownEditor } from "../ui/markdown-editor.js";
import { useRuntime } from "../window-context.js";
import { useInstructionCommand } from "./use-instruction-command.js";

export const MarkdownField = ({ value, change, disabled = false }: { readonly value: string; change(text: string): void; readonly disabled?: boolean }) => (
  <div className="flex flex-col gap-2">
    <span className="flex items-center gap-1 text-xs font-medium"><FileText aria-hidden="true" className="size-3.5" />Markdown body</span>
    <MarkdownEditor value={value} change={change} readOnly={disabled} maxLength={MAX_INSTRUCTION_BODY} />
  </div>
);

/** Only the typed draft is held here; saving never writes organisation state into presentation. */
export const InstructionEditor = ({ environmentId, row, close, inline = false }: { readonly environmentId: string; readonly row?: OwnedInstructionRow; readonly inline?: boolean; close(): void }) => {
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
  const form = (
        <form
          className="flex flex-col gap-3"
          onKeyDown={(event) => {
            if (inline && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && heading.trim() !== "") void save();
          }}
        >
          <Field label="Title">
            <span className="flex items-center gap-2"><Type aria-hidden="true" className="size-4" /><Tooltip content="Title · Type to edit"><Input aria-label="Title" maxLength={MAX_INSTRUCTION_TITLE} value={heading} onChange={(event) => typeHeading(event.target.value)} disabled={disabled} /></Tooltip></span>
          </Field>
          <MarkdownField value={body} change={setBody} disabled={disabled} />
          {offer.status === "absent" && <p className="text-sm text-ink-faint">{offer.message}</p>}
          {sending && <p role="status" className="text-2xs text-ink-muted">Saving…</p>}
          {line !== undefined && (
            <p role="status" className="text-sm text-signal">
              {line}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Tooltip content="Cancel" keys="Escape"><Button onClick={close}><X aria-hidden="true" />Cancel</Button></Tooltip>
            <Tooltip content="Save instruction" keys="Enter"><Button type="submit" disabled={disabled || heading.trim() === ""}>
              <Save aria-hidden="true" />Save instruction
            </Button></Tooltip>
          </div>
        </form>
  );
  const title = row === undefined ? "New instruction" : `Edit ${row.title}`;
  return inline ? <section data-local-escape aria-label={title} className="flex min-w-0 flex-col gap-2"><h4 className="text-xs font-medium">{title}</h4>{form}</section> : (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={title} description="Markdown appended to runs of the accounts this instruction reaches.">{form}</DialogContent>
    </Dialog>
  );
};
