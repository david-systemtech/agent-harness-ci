import { useId, type ReactNode } from "react";
import type { MethodName } from "@agent-harness/contracts";
import { Plus, Pencil, Trash2, RefreshCw, ArrowUp, ArrowDown, Pin, Eye, RotateCcw, Check } from "lucide-react";
import { Button, Tooltip } from "../ui/index.js";
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
  const Icon = method.endsWith("create") || method.endsWith("add") ? Plus
    : method.endsWith("remove") || method.endsWith("dismissSuggestion") ? Trash2
    : method.endsWith("pull") || method.endsWith("readiness") ? RefreshCw
    : method.endsWith("restoreSuggestion") ? RotateCcw
    : method.endsWith("diff") || method.endsWith("probe") ? Eye
    : method.endsWith("setFollow") ? Pin
    : method.endsWith("move") ? (children === "Move up" ? ArrowUp : ArrowDown)
    : method.endsWith("edit") ? Pencil : Check;
  return (
    <div className="flex w-fit flex-col gap-1">
      <Tooltip content={children} keys="Enter / Space"><Button size="sm" variant="outline" disabled={busy || absent !== undefined} aria-describedby={absent === undefined ? undefined : id} onClick={run}>
        <Icon aria-hidden="true" />{children}
      </Button></Tooltip>
      {absent !== undefined && (
        <span id={id} className="text-xs text-ink-faint">
          {absent}
        </span>
      )}
    </div>
  );
};
