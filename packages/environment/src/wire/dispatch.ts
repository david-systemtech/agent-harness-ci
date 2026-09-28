import {
  ContractError,
  invalidParams,
  isCommand,
  type CommandReceipt,
  type IssueInput,
  type JsonObject,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import { formatActor, type CommandOutcome, type CommandRun, type EventLog, type StoredError, type StoredReceipt } from "../event-log/event-log.js";
import type { CommandAnswer, CommandHandler, CommandRejection, MethodTable, Undo } from "../serve/methods.js";
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

/**
 * The one conversion from the log's stored receipt to the contracts'
 * `CommandReceipt`, what a command's response carries and the client's
 * outbox retires the command on: a rejection's reason is its error's code.
 */
export const toWireReceipt = (receipt: StoredReceipt): CommandReceipt =>
  receipt.status === "accepted"
    ? { status: "accepted", sequence: receipt.sequence, changed: receipt.changed }
    : { status: "rejected", sequence: receipt.sequence, changed: false, reason: receipt.error.code, error: { ...receipt.error } };

/** The error a rejection is stored and answered with: its code, its message or a plain one, its data or none. */
const rejectionError = ({ code, message, data }: CommandRejection): StoredError => ({
  code,
  message: message ?? `The command was rejected: ${code}.`,
  data: data ?? {},
});

/**
 * What the log runs for a handler's answer: its result checked against the
 * method's schema (a throw, so nothing commits), or its rejection as the error it stores.
 */
const toOutcome = (method: string, result: Parser, answer: CommandAnswer<unknown>): CommandOutcome<unknown> => {
  if (answer.rejected !== undefined) return { aggregate: answer.aggregate, rejected: rejectionError(answer.rejected) };
  const checked = result.safeParse(answer.result);
  if (!checked.success) throw new Error(`${method} answered outside its result schema: ${JSON.stringify(checked.error.issues)}`);
  return { ...answer, result: checked.data };
};

/**
 * Removes what a prepared command's `prepare` made, newest first. A removal
 * that fails is logged and the rest still run: the command's answer stands
 * whatever is left behind (the startup sweep's to find).
 */
const undoAll = async (method: string, undos: readonly Undo[]): Promise<void> => {
  for (const undo of [...undos].reverse()) {
    try {
      await undo();
    } catch (thrown) {
      console.error(`Removing what ${method}'s prepare made failed:`, thrown);
    }
  }
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
 * by the client session, as the actor, and the params' `commandId` in
 * lowercase, so a UUID in either case is one key, a repeat is answered from
 * the stored receipt and its handler never runs;
 * otherwise the handler runs inside the command's transaction and the
 * receipt is written with its events. A prepared command (#228) runs its
 * `prepare` first, outside the transaction and only when no receipt is
 * stored, and then the handler it answers; what `prepare` made is removed
 * when the command is not accepted (#321). The answer is `{receipt, result}`, the
 * result only when this request applied the command; a rejection is a
 * receipt too, not an error, since the receipt is what the client's outbox
 * retires a command on.
 */
export const createDispatch =
  (methods: MethodTable, log: Pick<EventLog, "command" | "receipt">) =>
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
      if (isCommand(served)) {
        // A command's params hold its id, a UUID: the registry refuses a command without one.
        const commandId = (parsed.data as { commandId: string }).commandId.toLowerCase();
        const commandParams = { ...(parsed.data as object), commandId };
        const actor = formatActor({ kind: "client_session", id: clientSession.id });
        // A prepared command hears from outside the log first, unless its receipt answers it (#228); what it made is
        // removed unless the command is accepted (#321).
        const registered = served.handler;
        const undos: Undo[] = [];
        let run: CommandRun<unknown>;
        try {
          let handler: CommandHandler;
          if (typeof registered === "function") handler = registered;
          else if (log.receipt(actor, commandId) !== null) {
            handler = () => {
              throw new Error(`${method} was answered from its receipt; its handler does not run.`);
            };
          } else {
            const prepared = registered.prepare(commandParams, { ...context, onUndo: (undo) => void undos.push(undo) });
            // Waited for only when it must be, so a prepare that answers at once keeps the command's place on its socket.
            handler = prepared instanceof Promise ? await prepared : prepared;
          }
          run = log.command({ actor, commandId }, (tx) => {
            const answer: unknown = handler(commandParams, { ...context, commandId, actor, tx });
            if (answer instanceof Promise) {
              answer.catch(() => undefined);
              throw new Error(`The handler for ${method} answered later; a command's handler answers inside its transaction.`);
            }
            return toOutcome(method, entry.result as Parser, answer as CommandAnswer<unknown>);
          });
        } catch (thrown) {
          await undoAll(method, undos);
          throw thrown;
        }
        if (run.receipt.status !== "accepted") await undoAll(method, undos);
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
