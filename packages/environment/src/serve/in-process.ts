import type { WireError } from "@agent-harness/contracts";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodContext, PrepareContext, Undo } from "./methods.js";

/**
 * A command carried out in process by another service as a step of its own
 * (#371: Move swaps an item through its owner's command, as
 * `forge.accounts.update`), run as dispatch runs a prepared command
 * (`wire/dispatch.ts`) for the client session that asked for the step: its
 * prepare first, outside any transaction, then the handler it answers
 * inside the command's transaction, keyed by that client session and a
 * command id of its own, so its receipt and events name them; what the prepare
 * made is removed, newest first, unless the command is accepted. What the
 * prepare or the handler throws is thrown, after the removals.
 */

/** The handler a prepare answers, closed over its params: it answers inside the command's transaction. */
export type InProcessHandler<Result> = (context: CommandContext) => CommandAnswer<Result>;

/** How a command carried out in process went: its result, or its rejection. */
export type InProcessAnswer<Result> = { readonly outcome: "accepted"; readonly result: Result } | { readonly outcome: "rejected"; readonly error: WireError };

export const runInProcess = async <Result>(
  log: Pick<EventLog, "command">,
  key: { readonly caller: MethodContext; readonly commandId: string },
  prepare: (context: PrepareContext) => InProcessHandler<Result> | Promise<InProcessHandler<Result>>,
): Promise<InProcessAnswer<Result>> => {
  const { caller, commandId } = key;
  const actor = formatActor({ kind: "client_session", id: caller.clientSession.id });
  const undos: Undo[] = [];
  const undoAll = async (): Promise<void> => {
    for (const undo of [...undos].reverse()) {
      try {
        await undo();
      } catch (thrown) {
        console.error("Removing what an in-process command's prepare made failed:", thrown);
      }
    }
  };
  try {
    const handler = await prepare({ ...caller, onUndo: (undo) => void undos.push(undo) });
    const run = log.command({ actor, commandId }, (tx) => {
      const answer = handler({ ...caller, commandId, actor, tx });
      return answer.rejected === undefined ? answer : { aggregate: answer.aggregate, rejected: { code: answer.rejected.code, message: answer.rejected.message ?? `The command was rejected: ${answer.rejected.code}.`, data: answer.rejected.data ?? {} } };
    });
    if (run.replayed) throw new Error(`The in-process command ${commandId} was answered from a receipt: each is given a command id of its own.`);
    if (run.receipt.status === "accepted") return { outcome: "accepted", result: run.result as Result };
    await undoAll();
    return { outcome: "rejected", error: { ...run.receipt.error } };
  } catch (thrown) {
    await undoAll();
    throw thrown;
  }
};
