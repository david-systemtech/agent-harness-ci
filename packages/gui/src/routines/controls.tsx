import type { MethodName } from "@agent-harness/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Button, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/** A command's receipt or refusal, with a synchronous guard against repeat gestures. */
export const useRoutineCommand = () => {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string>();
  const flight = useRef(false);
  const send = async (request: () => Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>, done?: () => void) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setLine(undefined);
    try {
      const answer = await request();
      if (answer.ok) done?.();
      else setLine(answer.error?.message ?? "The command was refused.");
    } finally { flight.current = false; setBusy(false); }
  };
  return { busy, line, send };
};

/** Visible, named verbs with the runtime's capability explanation. */
export const RoutineAction = ({ label, icon, environmentId, method, disabled = false, onClick, danger = false }: {
  readonly label: string; readonly icon: ReactNode; readonly environmentId?: string; readonly method?: MethodName;
  readonly disabled?: boolean; readonly onClick: () => void; readonly danger?: boolean;
}) => {
  const runtime = useRuntime();
  const capability = environmentId !== undefined && method !== undefined ? runtime.capability(environmentId, method) : undefined;
  const reason = capability?.status === "absent" ? capability.message : undefined;
  return <Tooltip content={[label, reason].filter(Boolean).join(" · ")} keys="Enter / Space"><span className="inline-flex" tabIndex={reason === undefined ? undefined : 0}>
    <Button size="sm" variant={danger ? "destructive" : "outline"} disabled={disabled || reason !== undefined} onClick={onClick}>{icon}{label}</Button>
  </span></Tooltip>;
};
