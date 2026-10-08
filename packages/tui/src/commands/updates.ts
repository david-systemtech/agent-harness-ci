import {
  bundledClaudeCodeWords,
  clientOfferWords,
  clientUpdateWords,
  drainAndUpdateDescription,
  drainAndUpdateQuestion,
  drainableUpdate,
  environmentVersionWords,
  offersClientVersion,
  outcomeWords,
  pendingUpdateWords,
  updateEnvironment,
  updatesUnreadWords,
  type CachedAnswer,
  type EnvironmentView,
  type Runtime,
  type WaitingUpdate,
} from "@agent-harness/client-runtime";
import type { UpdateWhen } from "@agent-harness/contracts";
import { messageOf, nameOf } from "../view.js";

/**
 * An environment's update on its card in `/environment` (launcher-update
 * spec, "Settings, methods, notices and flags"; ADR 0025; #827), as the
 * window's update controls and newer client's offer say and do it, in the
 * client runtime's words (`updates/words.ts`): the version it runs, its
 * pending update with what it waits on and the Claude Code it bundles, from
 * `updates.status` as the request cache holds it (read again on each update
 * notice); Update now, Set up's `updateEnvironment`; while busy work holds
 * the pending update, Drain and update now (#878), the same sent `now`
 * once the confirm line's question is answered yes; and the offer of this
 * client's version to an environment that runs an older one, by the
 * window's rule (`offersClientVersion`), sent by the connection registry's
 * `update-environment` action. The channel, auto-update and a pin stay the
 * generic editor's (`/settings environments.machines`). The terminal UI
 * carries no server of its own, so the window's giving way to the server
 * the desktop carries never arises here.
 */

/** A line the card draws over its actions: `quiet` dim, `warn` in the warning colour. */
export interface UpdateLine {
  readonly text: string;
  readonly tone?: "quiet" | "warn";
}

/**
 * What the card says of the environment's update; the version of this
 * client it offers (null for none); and the pending update Drain and update
 * now drains, while busy work holds it (`drainableUpdate`, #878; else null).
 */
export interface UpdateCard {
  readonly lines: readonly UpdateLine[];
  readonly offered: string | null;
  readonly drainable: WaitingUpdate | null;
}

/**
 * The card's update for `view`, from `status` (`updates.status`, else the
 * descriptor's version until it is read) and this client's version
 * `client`, on this client's calendar as it is `now`.
 */
export const updateCard = (view: EnvironmentView, status: CachedAnswer<"updates.status"> | undefined, client: string, now: Date): UpdateCard => {
  const name = nameOf(view);
  const result = status?.result ?? null;
  const version = result?.version ?? view.version;
  const pending = result === null ? null : pendingUpdateWords(result.pending, name, now);
  const offered = version !== null && offersClientVersion(client, version, result?.pending ?? null);
  const error = view.phase === "ready" ? (status?.error ?? null) : null;
  const lines: UpdateLine[] = [];
  if (version !== null) lines.push({ text: environmentVersionWords(version) });
  if (error !== null) lines.push({ text: updatesUnreadWords(error.message), tone: "warn" });
  if (pending !== null) lines.push({ text: pending });
  if (result !== null) lines.push({ text: bundledClaudeCodeWords(result.bundledClaudeCodeVersion), tone: "quiet" });
  if (offered) lines.push({ text: clientOfferWords(client, name, version) });
  return { lines, offered: offered ? client : null, drainable: result === null ? null : drainableUpdate(result.pending) };
};

/** "Not updated: <the capability's line>" while the connection cannot send `updates.apply` (no `admin`, not ready); undefined when it can. */
export const updateRefusal = (runtime: Runtime, view: EnvironmentView): string | undefined => {
  const capability = runtime.capability(view.environmentId, "updates.apply");
  return capability.status === "absent" ? `Not updated: ${capability.message}` : undefined;
};

/**
 * Update now: `updates.apply` when idle, a direct `admin` command; with
 * `now`, Drain and update now's (#878), which drains at once. Answers the
 * line to show, or why it was not taken.
 */
export const updateNow = async (runtime: Runtime, view: EnvironmentView, commandId: string, when: UpdateWhen = "idle"): Promise<string> =>
  outcomeWords(await updateEnvironment(runtime, view.environmentId, nameOf(view), commandId, when));

/**
 * What Drain and update now asks on the confirm line before it drains
 * `view` for the update `drainable` (#878), in the runtime's words, as the
 * window's dialog says them: the question, then what the drain does, its
 * cap cutting running runs.
 */
export const drainAndUpdateQuestionLine = (view: EnvironmentView, drainable: WaitingUpdate): string => {
  const name = nameOf(view);
  return `${drainAndUpdateQuestion(name, drainable.toVersion)} ${drainAndUpdateDescription(name, drainable.toVersion)} y/n`;
};

/**
 * The offer taken: this client's version asked of the environment, over its
 * socket when it is ready and the connection holds `admin`, or over the
 * update route when it is blocked on an older protocol and can update
 * itself (`update-environment`), which the wire refuses. Answers the line
 * to show; the capability's line, sending nothing, when neither holds.
 */
export const updateToClient = async (runtime: Runtime, view: EnvironmentView): Promise<string> => {
  const name = nameOf(view);
  if (view.action !== "update-environment") {
    const refusal = updateRefusal(runtime, view);
    if (refusal !== undefined) return refusal;
  }
  try {
    return clientUpdateWords(await runtime.connections.updateEnvironment(view.environmentId), name);
  } catch (error) {
    return `Not updated: ${messageOf(error)}`;
  }
};
