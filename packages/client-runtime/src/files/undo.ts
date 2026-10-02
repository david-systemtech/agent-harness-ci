import type { FileUndoOutcome } from "@agent-harness/contracts";
import { uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { RequestFailure } from "../requests.js";
import type { Runtime } from "../runtime.js";

/** The completion line shared by every Client, without file contents. */
export const fileUndoWords = (result: FileUndoOutcome): string => `File undo: ${result.action} ${result.path}.`;

export type FileUndoResult =
  | { readonly ok: true; readonly result: FileUndoOutcome | undefined; readonly line: string }
  | { readonly ok: false; readonly error: RequestFailure; readonly line: string };

const refused = (error: RequestFailure): FileUndoResult => ({ ok: false, error, line: `Cannot undo file change: ${error.message}` });

/** Restores one file through the Environment, immediately or not at all; conversation rewind is separate. */
export const undoFile = async (runtime: Runtime, clock: Clock, environmentId: string, sessionId: string): Promise<FileUndoResult> => {
  const answer = await runtime.requests.call(environmentId, "files.undo", { commandId: uuidv7(clock.now()), sessionId });
  if (!answer.ok) return refused(answer.error);
  if (answer.result.receipt.status === "rejected") return refused(answer.result.receipt.error);
  runtime.requests.refresh(environmentId, "diffs.session", { sessionId });
  runtime.requests.refresh(environmentId, "diffs.workingTree", { sessionId });
  const result = answer.result.result;
  return { ok: true, result, line: result ? fileUndoWords(result) : "File undo completed." };
};
