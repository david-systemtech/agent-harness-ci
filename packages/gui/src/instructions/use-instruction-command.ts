import { adminCall, uuidv7 } from "@agent-harness/client-runtime";
import type { ParamsOf } from "@agent-harness/contracts";
import { useState } from "react";
import { useClock, useRuntime } from "../window-context.js";

type InstructionCommand =
  | "instructions.create"
  | "instructions.edit"
  | "instructions.setScope"
  | "instructions.setEnabled"
  | "instructions.move"
  | "instructions.remove"
  | "instructions.resolveVersion"
  | "instructions.dismissSuggestion"
  | "instructions.restoreSuggestion";

/** Admin writes are direct; state is read again from the runtime on instructions.updated. */
export const useInstructionCommand = (environmentId: string) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [line, say] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const send = async <N extends InstructionCommand>(method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<boolean> => {
    say(undefined);
    setSending(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, method, { ...params, commandId: uuidv7(clock.now()) } as ParamsOf<N>));
      if (!answer.ok) {
        say(`Not saved: ${answer.line}`);
        return false;
      }
      return true;
    } finally {
      setSending(false);
    }
  };
  return { send, sending, line };
};
