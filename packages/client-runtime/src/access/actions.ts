import type { Ceiling, Scope, EventEnvelope } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";
import type { ClientSessionSummary } from "./words.js";

/**
 * What the Access row sends, as any renderer sends it and says it (env
 * spec, "Pairing and access"; permissions spec, "Ceilings"; #417): a client
 * session's ceiling changed and a client session revoked, each an `admin`
 * command sent as a direct request (`adminCall`), never the outbox's, so one
 * made while the environment cannot be reached fails at once; and the whole
 * access log read, page after page. Each command answers what it did, or
 * why not, in one line.
 */

/** What a command did, in one line. */
export interface AccessOutcome {
  readonly ok: boolean;
  readonly line: string;
}

/**
 * Changes another client session's ceiling (`access.sessions.setCeiling`),
 * which its next run takes: "Changed laptop's ceiling from acceptEdits to
 * plan: its next run takes it.", "laptop's ceiling is plan already.", or
 * "Not changed: <why>" (this client's own is the environment's to refuse).
 */
export const setSessionCeiling = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  session: Pick<ClientSessionSummary, "id" | "label">,
  ceiling: Ceiling,
  commandId: string,
): Promise<AccessOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "access.sessions.setCeiling", { commandId, clientSessionId: session.id, ceiling }));
  if (!answer.ok) return { ok: false, line: `Not changed: ${answer.line}` };
  const changed = answer.result;
  if (changed === undefined || changed.from === changed.to) return { ok: true, line: `${session.label}'s ceiling is ${ceiling} already.` };
  return { ok: true, line: `Changed ${session.label}'s ceiling from ${changed.from} to ${changed.to}: its next run takes it.` };
};

/** Replace another client's grant immediately, without minting a new pairing code. */
export const setSessionAccess = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  session: Pick<ClientSessionSummary, "id" | "label">,
  grant: { readonly scopes: readonly Scope[]; readonly ceiling: Ceiling },
  commandId: string,
): Promise<AccessOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "access.sessions.setAccess", { commandId, clientSessionId: session.id, scopes: [...grant.scopes], ceiling: grant.ceiling }));
  return answer.ok ? { ok: true, line: `Changed ${session.label}'s access: its connections reconnect with the new grant, without pairing again.` } : { ok: false, line: `Not changed: ${answer.line}` };
};

/** Revokes a client session (`access.sessions.revoke`): its sockets close and its token is refused from then on. */
export const revokeSession = async (runtime: Pick<Runtime, "requests">, environmentId: string, session: Pick<ClientSessionSummary, "id" | "label">, commandId: string): Promise<AccessOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "access.sessions.revoke", { commandId, clientSessionId: session.id }));
  return answer.ok ? { ok: true, line: `Revoked ${session.label}: its token is refused from now on.` } : { ok: false, line: `Not revoked: ${answer.line}` };
};

/** How many events one `access.log.list` asks for: the most it answers. */
const ACCESS_LOG_READ = 1000;

/** The access log read whole, newest first, or why it could not be. */
export type AccessLogRead = { readonly ok: true; readonly events: readonly EventEnvelope[] } | { readonly ok: false; readonly line: string };

/**
 * Reads the whole access log (`access.log.list`, which answers oldest first
 * after a cursor), a page at a time until a page comes back short, and
 * answers it newest first, since the method reads only forward.
 */
export const readAccessLog = async (runtime: Pick<Runtime, "requests">, environmentId: string): Promise<AccessLogRead> => {
  const events: EventEnvelope[] = [];
  for (;;) {
    const after = events.at(-1)?.sequence;
    const answer = await runtime.requests.call(environmentId, "access.log.list", { limit: ACCESS_LOG_READ, ...(after !== undefined && { afterSequence: after }) });
    if (!answer.ok) return { ok: false, line: `The access log could not be read: ${answer.error.message}` };
    events.push(...answer.result.events);
    if (answer.result.events.length < ACCESS_LOG_READ) return { ok: true, events: events.reverse() };
  }
};
