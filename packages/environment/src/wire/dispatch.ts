import {
  ContractError,
  ErrorCode,
  WireError as WireErrorSchema,
  invalidParams,
  type CommandReceipt as WireReceipt,
  type IssueInput,
  type JsonObject,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import { formatActor, type CommandOutcome, type CommandReceipt, type EventLog } from "../event-log/event-log.js";
import type { MethodTable } from "../serve/methods.js";
import type { Opening } from "./subscriptions.js";

/** A request's answer: its result, or its error. */
export type Answer = { readonly result: JsonObject } | { readonly error: WireError };

/** How dispatch hands back the one answer each request gets. */
export type Respond = (answer: Answer) => void;

/**
 * How dispatch hands a stream request over, once its scope, params and
 * handler have passed: the subscription answers it with `subscribed`. What it
 * throws, before `subscribed`, is answered as a handler's throw is.
 */
export type Open = (opening: Opening) => void | Promise<void>;

/** What `safeParse` gives back, as far as dispatch needs it. */
interface Parser {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: readonly IssueInput[] } };
}

const error = (code: string, message: string, data: Record<string, unknown> = {}): WireError => ({ code, message, data });

/** A receipt as a command's response carries it: what the client's outbox retires the command on. */
export const toWireReceipt = (receipt: CommandReceipt): WireReceipt =>
  receipt.status === "accepted"
    ? { status: "accepted", sequence: receipt.sequence, changed: receipt.changed }
    : { status: "rejected", sequence: receipt.sequence, changed: false, reason: receipt.reason, error: receipt.error };

/** Throws unless `outcome` can go on the wire: its result in the method's schema, its rejection a snake-case reason and a wire error. */
const checkOutcome = (method: string, result: Parser, outcome: CommandOutcome<unknown>): CommandOutcome<unknown> => {
  if (outcome.rejected !== undefined) {
    const { reason, error: rejection } = outcome.rejected;
    if (!ErrorCode.safeParse(reason).success || (rejection !== undefined && !WireErrorSchema.safeParse(rejection).success)) {
      throw new Error(`${method} rejected with a reason or error the wire cannot carry: ${JSON.stringify(outcome.rejected)}`);
    }
    return outcome;
  }
  const checked = result.safeParse(outcome.result);
  if (!checked.success) throw new Error(`${method} answered outside its result schema: ${JSON.stringify(checked.error.issues)}`);
  return { ...outcome, result: checked.data };
};

/**
 * Answers requests from an authenticated socket with the methods of
 * `methods`. The scope check is here, once, before the params are read or a
 * handler is looked up, for queries, commands and streams alike; then the
 * params are parsed, the handler runs, and what it returns or throws becomes
 * the one answer. A stream's handler names a source, which `open` subscribes
 * to instead of an answer.
 *
 * A command runs through the log's `command` (env spec, "Commands"): keyed
 * by the client session, as the actor, and the params' `commandId`, a
 * repeat is answered from the stored receipt and its handler never runs;
 * otherwise the handler runs inside the command's transaction and the
 * receipt is written with its events. The answer is `{receipt, result}`, the
 * result only when this request applied the command; a rejection is a
 * receipt too, not an error, since the receipt is what the client's outbox
 * retires a command on.
 */
export const createDispatch =
  (methods: MethodTable, log: Pick<EventLog, "command">) =>
  async (request: RequestFrame, clientSession: VerifiedClientSession, respond: Respond, open: Open): Promise<void> => {
    const { method, params } = request;
    const served = methods.get(method);
    if (!served) return respond({ error: error("not_found", `No method is named ${method}.`) });
    const entry = served.method;

    if (!clientSession.scopes.includes(entry.scope)) {
      return respond({
        error: error("forbidden", `${method} needs the ${entry.scope} scope, which this client session does not hold.`, {
          scope: entry.scope,
        }),
      });
    }
    const parsed = (entry.params as Parser).safeParse(params);
    if (!parsed.success) return respond({ error: invalidParams(parsed.error.issues, `The params do not match ${method}'s schema.`) });

    if (!served.handler) return respond({ error: error("not_found", `${method} is not served by this environment yet.`) });
    const context = { clientSession };
    let result: unknown;
    try {
      if (served.kind === "stream") {
        const source = await served.handler(parsed.data, context);
        // A stream's params hold its cursor: the registry refuses a stream without one.
        const { afterSequence } = parsed.data as { afterSequence: number };
        return await open({ requestId: request.id, source, afterSequence, payloadSchema: entry.result });
      }
      if (served.kind === "command") {
        const handler = served.handler;
        // A command's params hold its id: the registry refuses a command without one.
        const { commandId } = parsed.data as { commandId: string };
        const actor = formatActor({ kind: "client_session", id: clientSession.id });
        const run = log.command({ actor, commandId }, (tx) => {
          const outcome: unknown = handler(parsed.data, { ...context, commandId, actor, tx });
          if (outcome instanceof Promise) {
            outcome.catch(() => undefined);
            throw new Error(`The handler for ${method} answered later; a command's handler answers inside its transaction.`);
          }
          return checkOutcome(method, entry.result as Parser, outcome as CommandOutcome<unknown>);
        });
        const receipt = toWireReceipt(run.receipt);
        return respond({ result: run.replayed || run.result === undefined ? { receipt } : { receipt, result: run.result } });
      }
      result = await served.handler(parsed.data, context);
    } catch (thrown) {
      if (thrown instanceof ContractError) return respond({ error: thrown.toWire() });
      console.error(`The handler for ${method} failed:`, thrown);
      return respond({ error: error("internal", "The environment failed.") });
    }
    const checked = (entry.result as Parser).safeParse(result);
    if (!checked.success) {
      console.error(`The handler for ${method} answered outside its result schema:`, checked.error.issues);
      return respond({ error: error("internal", "The environment failed.") });
    }
    respond({ result: checked.data as JsonObject });
  };
