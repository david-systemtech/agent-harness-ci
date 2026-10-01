import { oneLine, uuidv7 } from "@agent-harness/client-runtime";
import type { CommandReceipt, MethodName } from "@agent-harness/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** Admin verbs are direct requests, with fresh command ids and their refusal shown on one line. */
export const useSkillVerb = (say: (line: string) => void) => {
  const clock = useClock();
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);
  const send = async (
    request: () => Promise<
      { readonly ok: true; readonly result: { readonly receipt: CommandReceipt } } | { readonly ok: false; readonly error: { readonly message: string } }
    >,
    done: string,
  ): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSending(true);
    setRefusal(undefined);
    try {
      const answer = await request();
      if (!answer.ok) {
        const line = oneLine(answer.error.message);
        setRefusal(line);
        say(line);
        return false;
      }
      if (answer.result.receipt.status === "rejected") {
        const line = oneLine(answer.result.receipt.error.message);
        setRefusal(line);
        say(line);
        return false;
      }
      say(done);
      return true;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return { sending, send, refusal, clearRefusal: () => setRefusal(undefined), commandId: () => uuidv7(clock.now()) };
};

/** Every absent verb stays visible with the runtime's reason. */
export const SkillButton = ({
  environmentId,
  method,
  reason,
  busy,
  onClick,
  children,
}: {
  readonly environmentId: string;
  readonly method: MethodName;
  readonly reason?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) => {
  const capability = useRuntime().capability(environmentId, method);
  const why = capability.status === "absent" ? capability.message : reason;
  return (
    <span className="flex flex-col gap-1">
      <Button disabled={busy || why !== undefined} onClick={onClick}>
        {children}
      </Button>
      {why !== undefined && <span className="text-xs text-ink-faint">{why}</span>}
    </span>
  );
};
