import {
  ContractError,
  invalidParams,
  type IssueInput,
  type JsonObject,
  type Method,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { AnyHandler } from "../serve/methods.js";
import type { Opening, StreamSource } from "./subscriptions.js";

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

const isStreamSource = (value: unknown): value is StreamSource => {
  if (typeof value !== "object" || value === null) return false;
  const { stream, snapshot } = value as { stream?: { kind?: unknown; id?: unknown }; snapshot?: unknown };
  return typeof stream?.kind === "string" && typeof stream.id === "string" && typeof snapshot === "function";
};

/**
 * Answers requests from an authenticated socket against `registry`, with
 * `methods`. The scope check is here, once, before the params are read or a
 * handler is looked up, for queries, commands and streams alike; then the
 * params are parsed, the handler runs, and what it returns or throws becomes
 * the one answer. A stream's handler names a source, which `open` subscribes
 * to instead of an answer.
 */
export const createDispatch =
  (methods: Readonly<Record<string, unknown>>, registry: Readonly<Record<string, Method>>) =>
  async (request: RequestFrame, clientSession: VerifiedClientSession, respond: Respond, open: Open): Promise<void> => {
    const { method, params } = request;
    if (!Object.hasOwn(registry, method)) return respond({ error: error("not_found", `No method is named ${method}.`) });
    const entry = registry[method] as Method;

    if (!clientSession.scopes.includes(entry.scope)) {
      return respond({
        error: error("forbidden", `${method} needs the ${entry.scope} scope, which this client session does not hold.`, {
          scope: entry.scope,
        }),
      });
    }
    const parsed = (entry.params as Parser).safeParse(params);
    if (!parsed.success) return respond({ error: invalidParams(parsed.error.issues, `The params do not match ${method}'s schema.`) });

    // Command receipts (#111) wrap the handlers of command methods, keyed by the client session and commandId.
    const handler = methods[entry.name] as AnyHandler | undefined;
    if (!handler) return respond({ error: error("not_found", `${method} is not served by this environment yet.`) });
    let result: unknown;
    try {
      result = await handler(parsed.data, { clientSession });
      if (entry.kind === "stream") {
        if (!isStreamSource(result)) throw new Error(`The handler for the stream ${method} named no stream source.`);
        const { afterSequence } = parsed.data as { afterSequence: number };
        return await open({ requestId: request.id, source: result, afterSequence, payloadSchema: entry.result });
      }
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
