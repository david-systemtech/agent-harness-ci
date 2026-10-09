import type { SandboxSetup } from "@agent-harness/client-runtime";
import { useState } from "react";
import type { ServiceRestart } from "../connections/service-restart.js";
import { CopyLine } from "../settings/copy-line.js";
import { Button, Fold } from "../ui/index.js";

/**
 * How to set up or fix a sandbox this computer cannot give yet (setup-copy.md
 * §5.12): a fold, shut until chosen, saying what to do, each of the OS's
 * commands to copy under its label, then the restart that checks the sandbox
 * again.
 */
export const SandboxSetupFold = ({ summary, setups, restart }: { readonly restart?: ServiceRestart | undefined; readonly summary: "How to set it up" | "How to fix it"; readonly setups: readonly SandboxSetup[] }) => {
  const [open, setOpen] = useState(false);
  return (
    <Fold summary={summary} open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 flex-col gap-2 pt-1">
        {setups.map((setup) => (
          <div key={setup.line} className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-ink">{setup.line}</p>
            {setup.commands.map((command) => <CopyLine key={command.text} label={command.label} text={command.text} />)}
            {setup.restart !== undefined && (restart === undefined
              ? <CopyLine label={`${setup.restart.label}:`} text={setup.restart.text} />
              : <Button className="w-fit" disabled={restart.disabled} onClick={restart.start}>{restart.restarting ? "Restarting…" : "Restart agent-harness"}</Button>)}
          </div>
        ))}
      </div>
    </Fold>
  );
};
