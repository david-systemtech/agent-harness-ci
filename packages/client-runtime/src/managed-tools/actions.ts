import { ToolNotRunnableError, type CommandReceipt, type ManagedToolName, type ResultOf, type RunnableToolAction, type VerifiableToolName } from "@agent-harness/contracts";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Runtime } from "../runtime.js";
import type { ActionOutcome } from "../setup/actions.js";
import type { RefusedAnswer } from "../words/refusal.js";
import { verificationWords } from "./words.js";

/**
 * What About's Managed tools send and what each answers, in one line
 * (key-managers spec, "Managed tools"; ADR 0026; #426): `tools.run`, which
 * opens a tool terminal for the window to draw, and `tools.verify`. Both
 * are `admin`, sent at once and never parked (`requests.call`): a run is
 * watched as it happens, and a verification read at once.
 */

/**
 * What a run asked for came to: the tool terminal it opened and the command
 * it runs, or why it did not, with the refusal itself for a surface that
 * words it plainly (`plainRefusal`) and the vendor's command when the
 * refusal answered one.
 */
export type ToolRunOutcome =
  | { readonly ok: true; readonly run: ResultOf<"tools.run"> }
  | { readonly ok: false; readonly line: string; readonly refusal: RefusedAnswer; readonly command: string | null };

/**
 * Installs or updates `tool` (`tools.run`): a tool terminal under an id
 * minted here, so the window can draw it as soon as the answer comes, at
 * the environment's size until the window sizes it. A refusal is one line,
 * "Not run: ...": another run under way (`tool_run_in_progress`), or a tool
 * the harness does not install or update here (`tool_not_runnable`), whose
 * vendor command is answered to copy.
 */
export const runTool = async (runtime: Runtime, environmentId: string, tool: ManagedToolName, action: RunnableToolAction, now: Date): Promise<ToolRunOutcome> => {
  const answer = await runtime.requests.call(environmentId, "tools.run", { commandId: uuidv7(now), tool, action, id: uuidv4() });
  if (!answer.ok) return { ok: false, line: `Not run: ${answer.error.message}`, refusal: answer.error, command: null };
  const { receipt, result } = answer.result as { readonly receipt: CommandReceipt; readonly result?: ResultOf<"tools.run"> };
  if (receipt.status === "rejected") {
    const refused = ToolNotRunnableError.safeParse(receipt.error);
    return { ok: false, line: `Not run: ${receipt.error.message}`, refusal: receipt.error, command: refused.success ? refused.data.data.command : null };
  }
  if (result === undefined) return { ok: false, line: "Not run: the environment answered no terminal.", refusal: { code: "internal", message: "The environment answered no terminal." }, command: null };
  return { ok: true, run: result };
};

/** Runs the tool's verify command on the environment (`tools.verify`): passed or failed with its one-line reason, or why it could not be asked. */
export const verifyTool = async (runtime: Runtime, environmentId: string, tool: VerifiableToolName): Promise<ActionOutcome> => {
  const answer = await runtime.requests.call(environmentId, "tools.verify", { tool });
  if (!answer.ok) return { ok: false, line: `Not verified: ${answer.error.message}` };
  return { ok: answer.result.outcome === "passed", line: verificationWords(answer.result) };
};
