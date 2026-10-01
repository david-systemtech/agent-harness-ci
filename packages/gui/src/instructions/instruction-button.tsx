import { useId, type ReactNode } from "react";
import type { MethodName } from "@agent-harness/contracts";
import { Button } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/** Absent actions keep their place and say why beneath the dim control. */
export const InstructionButton = ({
  environmentId,
  method,
  busy = false,
  reason,
  children,
  run,
}: {
  readonly environmentId: string;
  readonly method: MethodName;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly children: ReactNode;
  run(): void;
}) => {
  const id = useId();
  const offer = useRuntime().capability(environmentId, method);
  const absent = offer.status === "absent" ? offer.message : reason;
  return (
    <div className="flex flex-col gap-1">
      <Button disabled={busy || absent !== undefined} aria-describedby={absent === undefined ? undefined : id} onClick={run}>
        {children}
      </Button>
      {absent !== undefined && (
        <span id={id} className="text-xs text-ink-faint">
          {absent}
        </span>
      )}
    </div>
  );
};
