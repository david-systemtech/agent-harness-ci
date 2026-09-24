import type { EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import type { ResultOf } from "@agent-harness/contracts";
import { messageOf, nameOf } from "../view.js";

/**
 * `/environment` (docs/specs/tui.md, "First launch"): the saved
 * connections with phase, version and "unreachable since", and per
 * connection enable or disable, remove, set primary, and its client
 * sessions (`access.sessions.list`, `access.sessions.revoke`). Every action
 * is a runtime call or an `access.*` request; nothing is kept here.
 */

export type EnvironmentAction = "enable" | "disable" | "remove" | "primary" | "sessions";

/** The actions a connection offers, in the menu's order. */
export const actionsFor = (view: EnvironmentView): readonly EnvironmentAction[] => [
  view.enabled ? "disable" : "enable",
  "remove",
  ...(view.primary ? [] : (["primary"] as const)),
  "sessions",
];

export const actionWords: Readonly<Record<EnvironmentAction, string>> = {
  enable: "Enable",
  disable: "Disable",
  remove: "Remove",
  primary: "Set primary",
  sessions: "Client sessions",
};

/** Enables, disables or makes a connection the primary one; answers the line to show. */
export const applyAction = async (
  runtime: Runtime,
  view: EnvironmentView,
  action: "enable" | "disable" | "primary",
): Promise<string> => {
  try {
    if (action === "primary") {
      // Every saved connection, disabled ones included, as the runtime lists them now: `setOrder` takes the whole sequence.
      const others = runtime.projections.environments.read().filter((v) => v.environmentId !== view.environmentId);
      await runtime.connections.setOrder([view.environmentId, ...others.map((v) => v.environmentId)]);
      return `${nameOf(view)} is the primary environment.`;
    }
    await runtime.connections.setEnabled(view.environmentId, action === "enable");
    return action === "enable" ? `${nameOf(view)} is enabled.` : `${nameOf(view)} is disabled: its cache and saved connection stay.`;
  } catch (error) {
    return messageOf(error);
  }
};

/** Removes a connection: its client session there revoked when it can be, then forgotten here. */
export const removeEnvironment = async (runtime: Runtime, view: EnvironmentView): Promise<string> => {
  try {
    const result = await runtime.connections.remove(view.environmentId);
    return result.revoked ? `Removed ${nameOf(view)}; its client session there is revoked.` : `Removed ${nameOf(view)}. ${result.message}`;
  } catch (error) {
    return messageOf(error);
  }
};

export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

export type ClientSessionsOutcome = { readonly ok: true; readonly rows: readonly ClientSessionRow[] } | { readonly ok: false; readonly line: string };

/** The environment's live client sessions, or why they cannot be listed (`requests.call` answers absent with the reason without `admin`). */
export const listClientSessions = async (runtime: Runtime, view: EnvironmentView): Promise<ClientSessionsOutcome> => {
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.list", { live: true });
  if (!answer.ok) return { ok: false, line: `Cannot list the client sessions on ${nameOf(view)}: ${answer.error.message}` };
  return { ok: true, rows: answer.result.sessions };
};

/** Revokes one client session; answers the line to show. */
export const revokeClientSession = async (runtime: Runtime, view: EnvironmentView, row: ClientSessionRow, commandId: string): Promise<string> => {
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.revoke", { commandId, clientSessionId: row.id });
  if (!answer.ok) return `Cannot revoke ${row.label} on ${nameOf(view)}: ${answer.error.message}`;
  const { receipt } = answer.result;
  return receipt.status === "accepted" ? `Revoked ${row.label} on ${nameOf(view)}.` : `Revoking ${row.label} on ${nameOf(view)} was rejected: ${receipt.error.message}`;
};
