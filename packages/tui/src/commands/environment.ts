import type { EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import type { ResultOf } from "@agent-harness/contracts";

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
  views: readonly EnvironmentView[],
): Promise<string> => {
  try {
    if (action === "primary") {
      await runtime.connections.setOrder([view.environmentId, ...views.filter((v) => v.environmentId !== view.environmentId).map((v) => v.environmentId)]);
      return `${view.name} is the primary environment.`;
    }
    await runtime.connections.setEnabled(view.environmentId, action === "enable");
    return action === "enable" ? `${view.name} is enabled.` : `${view.name} is disabled: its cache and saved connection stay.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Removes a connection: its client session there revoked when it can be, then forgotten here. */
export const removeEnvironment = async (runtime: Runtime, view: EnvironmentView): Promise<string> => {
  try {
    const result = await runtime.connections.remove(view.environmentId);
    return result.revoked ? `Removed ${view.name}; its client session there is revoked.` : `Removed ${view.name}. ${result.message}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

export type ClientSessionsOutcome = { readonly ok: true; readonly rows: readonly ClientSessionRow[] } | { readonly ok: false; readonly line: string };

/** The environment's live client sessions, or why they cannot be listed (absent with the capability's reason without `admin`). */
export const listClientSessions = async (runtime: Runtime, view: EnvironmentView): Promise<ClientSessionsOutcome> => {
  const capability = runtime.capability(view.environmentId, "access.sessions.list");
  if (capability.status === "absent") return { ok: false, line: `Cannot list the client sessions on ${view.name}: ${capability.message}` };
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.list", { live: true });
  if (!answer.ok) return { ok: false, line: `Listing the client sessions on ${view.name} failed: ${answer.error.message}` };
  return { ok: true, rows: answer.result.sessions };
};

/** Revokes one client session; answers the line to show. */
export const revokeClientSession = async (runtime: Runtime, view: EnvironmentView, row: ClientSessionRow, commandId: string): Promise<string> => {
  const capability = runtime.capability(view.environmentId, "access.sessions.revoke");
  if (capability.status === "absent") return `Cannot revoke ${row.label} on ${view.name}: ${capability.message}`;
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.revoke", { commandId, clientSessionId: row.id });
  if (!answer.ok) return `Revoking ${row.label} on ${view.name} failed: ${answer.error.message}`;
  const { receipt } = answer.result;
  return receipt.status === "accepted" ? `Revoked ${row.label} on ${view.name}.` : `Revoking ${row.label} on ${view.name} was rejected: ${receipt.error.message}`;
};
