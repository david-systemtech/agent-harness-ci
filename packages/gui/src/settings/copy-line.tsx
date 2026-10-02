import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { useId } from "react";
import { Button } from "../ui/index.js";
import { useRuntime, useShell } from "../window-context.js";

/** A line to copy, under its label: its text to select, and Copy where the shell has a clipboard. */
export const CopyLine = ({ label, text }: { readonly label: string; readonly text: string }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const heading = useId();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1">
      <h5 id={heading} className="text-xs text-ink-muted">
        {label}
      </h5>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 rounded-md bg-inset p-2 font-mono text-xs break-all whitespace-pre-wrap text-ink select-all">{text}</pre>
        {clipboard !== undefined && <Button onClick={() => void clipboard.writeText(text)}>Copy</Button>}
      </div>
    </section>
  );
};
