import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { Copy } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../ui/index.js";
import { useRuntime, useShell } from "../window-context.js";

/** A line to copy, under its label: its text to select, and Copy where the shell has a clipboard. */
export const CopyLine = ({ label, text, copyLabel = "Copy" }: { readonly label: string; readonly text: string; readonly copyLabel?: string }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const heading = useId();
  const [failure, setFailure] = useState<string>();
  const copy = async () => {
    setFailure(undefined);
    try { await clipboard?.writeText(text); }
    catch { setFailure("Could not copy. Select the text and copy it instead."); }
  };
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1">
      <h5 id={heading} className="text-xs text-ink-muted">
        {label}
      </h5>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 rounded-none border border-hairline bg-inset px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-ink select-all">{text}</pre>
        {clipboard !== undefined && <Button variant="outline" size="xs" aria-label={copyLabel} title={`${copyLabel} (Enter or Space)`} onClick={() => void copy()}><Copy aria-hidden="true" data-icon="inline-start" />Copy</Button>}
      </div>
      {failure !== undefined && <p role="status" className="text-2xs text-signal">{failure}</p>}
    </section>
  );
};
