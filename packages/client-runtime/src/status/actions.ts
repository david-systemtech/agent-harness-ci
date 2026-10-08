import { BYPASS_SENTENCE, type AccountRecord, type CommandMethodName, type CommandReceipt, type ContainmentLevel, type Mode, type ResultOf } from "@agent-harness/contracts";
import type { RequestAnswer } from "../requests.js";
import type { RefusedAnswer } from "../words/refusal.js";
import type { Runtime } from "../runtime.js";

/**
 * What the status line's pickers do, as both renderers do it and say it
 * (docs/specs/tui.md, "Status, usage, pickers"; docs/specs/gui.md, "A session
 * pane"; #147, moved here by #402): the session's mode and containment set,
 * the hand-off onto another account, and an `admin` command as a direct
 * request. Each answers the one line a renderer says, so both say the same.
 */

/** What an `admin` command did: its result (none from a retry answered by its stored receipt) and whether it changed anything, or the one line saying why not and the refusal it says (`plainRefusal` words it plainly). */
export type AdminOutcome<N extends CommandMethodName> =
  | { readonly ok: true; readonly result: ResultOf<N> | undefined; readonly changed: boolean }
  | { readonly ok: false; readonly line: string; readonly refusal: RefusedAnswer };

/** An `admin` command sent as a direct request (`requests.call`, never the outbox): its refusal or rejected receipt is one line. */
export const adminCall = async <N extends CommandMethodName>(call: () => Promise<RequestAnswer<N>>): Promise<AdminOutcome<N>> => {
  const answer = await call();
  if (!answer.ok) return { ok: false, line: answer.error.message, refusal: answer.error };
  const { receipt, result } = answer.result as { readonly receipt: CommandReceipt; readonly result?: ResultOf<N> };
  if (receipt.status === "rejected") return { ok: false, line: receipt.error.message, refusal: receipt.error };
  return { ok: true, result, changed: receipt.changed };
};

/** What setting a session's mode said: the line, the mode the session got when the environment said it, and whether the line is transient. */
export interface ModeSet {
  readonly ok: boolean;
  readonly line: string;
  readonly mode?: Mode;
  /**
   * Whether the line is a transient notice, said once as the mode changes: the
   * session got the mode asked for, and the mode control shows it from then on
   * (#1823). A clamp or a refusal is not: it stands as the pane's line, since
   * the control does not say why the session has less than was asked.
   */
  readonly transient: boolean;
}

/**
 * Sets the session's mode (`permissions.mode.set`, through the outbox). A
 * mode above the ceiling is sent all the same, so the environment's clamp
 * answers it, lowered and never refused: the line names the mode asked for,
 * the one got and why (the ceiling, or a mode the account cannot use), and
 * bypassPermissions carries the permissions spec's sentence. A mode got as
 * asked is said as a transient notice.
 */
export const setSessionMode = async (runtime: Runtime, environmentId: string, sessionId: string, mode: Mode, sessionName: string): Promise<ModeSet> => {
  const answer = await runtime.commands.dispatch(environmentId, "permissions.mode.set", { sessionId, mode });
  if (!answer.ok) return { ok: false, line: `The mode was not set: ${answer.error.message}`, transient: false };
  const resolved = answer.result?.mode;
  if (!resolved) return { ok: true, line: `Mode: ${mode}.`, transient: true };
  const live = answer.result?.live ? " The running turn has it too." : "";
  if (!resolved.clamped) {
    return { ok: true, mode: resolved.effective, line: `Mode: ${resolved.effective}.${resolved.effective === "bypassPermissions" ? ` ${BYPASS_SENTENCE}` : ""}${live}`, transient: true };
  }
  const why = resolved.clampReason === "unavailable" ? `its account cannot use ${resolved.requested}` : `clamped to this connection's ceiling (${resolved.ceiling})`;
  return { ok: true, mode: resolved.effective, line: `Asked for ${resolved.requested}; ${sessionName} has ${resolved.effective}: ${why}.${live}`, transient: false };
};

/** What setting a session's containment said: the level the session got, or the refusal, in one line. */
export type ContainmentSet = { readonly ok: true; readonly level: ContainmentLevel; readonly line: string } | { readonly ok: false; readonly line: string };

/**
 * Sets the session's containment level (`permissions.containment.set`,
 * through the outbox), from its next run. A level the environment cannot
 * enforce is sent all the same and refused (`containment_unavailable`),
 * said in one line with the probe's reason.
 */
export const setSessionContainment = async (
  runtime: Runtime,
  environmentId: string,
  sessionId: string,
  level: ContainmentLevel,
  names: { readonly session: string; readonly environment: string },
): Promise<ContainmentSet> => {
  const answer = await runtime.commands.dispatch(environmentId, "permissions.containment.set", { sessionId, level });
  if (!answer.ok) {
    const { code, data, message } = answer.error;
    const reason = code === "containment_unavailable" && typeof data?.["reason"] === "string" ? data["reason"] : message;
    return { ok: false, line: code === "containment_unavailable" ? `${level} cannot be enforced on ${names.environment}: ${reason}` : `Containment was not set: ${reason}` };
  }
  const effective = answer.result?.containment.effective ?? level;
  return { ok: true, level: effective, line: `Containment: ${effective}, from the next run of ${names.session}.` };
};

/** What a hand-off did: the fork's id and the line saying so, or the refusal. */
export type HandOff = { readonly ok: true; readonly sessionId: string; readonly line: string } | { readonly ok: false; readonly line: string };

/** The line while a hand-off is on its way. */
export const handingOffWords = (from: string, account: Pick<AccountRecord, "label">): string => `Handing ${from} off to ${account.label}…`;

/** The line for a hand-off onto the account the session already runs on, which forks nothing. */
export const handedOffAlreadyWords = (from: string, account: Pick<AccountRecord, "label">): string => `${from} runs on ${account.label} already.`;

/**
 * Hands the session off onto another account on its environment (ADR 0015:
 * the hand-off on one environment). A session cannot change its account
 * (`runs.start` takes none), so the hand-off is a fork of the whole session
 * onto the account (`commands.fork` with `account`), which carries the
 * source's draft onto it once the fork is accepted; the source stays as it
 * is. With `anchor`, a user message of the session, the fork is taken
 * before it instead, the message its draft (the window's Fork onto another
 * account, #403).
 */
export const handOff = async (
  runtime: Runtime,
  environmentId: string,
  sessionId: string,
  account: Pick<AccountRecord, "id" | "label">,
  from: string,
  anchor?: string,
): Promise<HandOff> => {
  const { sessionId: forked, answer } = await runtime.commands.fork(environmentId, sessionId, { account: account.id, ...(anchor !== undefined && { anchor }) });
  if (!answer.ok) return { ok: false, line: `Not handed off: ${answer.error.message}` };
  return { ok: true, sessionId: forked, line: `Handed off to ${account.label}: a new session forked from ${from} runs on it; ${from} stays as it is.` };
};
