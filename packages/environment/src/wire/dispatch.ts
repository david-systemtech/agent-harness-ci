import {
  ContractError,
  invalidParams,
  type IssueInput,
  type JsonObject,
  type Registry,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { MethodContext, MethodHandlers } from "../serve/methods.js";

/** A request's answer: its result, or its error. */
export type Answer = { readonly result: JsonObject } | { readonly error: WireError };

/** How dispatch hands back the one answer each request gets. */
export type Respond = (answer: Answer) => void;

/** What `safeParse` gives back, as far as dispatch needs it. */
interface Parser {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: readonly IssueInput[] } };
}

const error = (code: string, message: string, data: Record<string, unknown> = {}): WireError => ({ code, message, data });

/**
 * Answers requests from an authenticated socket against `registry`, with
 * `methods`. The scope check is here, once, before the params are read or a
 * handler is looked up, for queries, commands and streams alike; then the
 * params are parsed, the handler runs, and what it returns or throws becomes
 * the one answer.
 */
export const createDispatch =
  (methods: MethodHandlers, registry: Registry) =>
  async (request: RequestFrame, clientSession: VerifiedClientSession, respond: Respond): Promise<void> => {
    const { method, params } = request;
    if (!Object.hasOwn(registry, method)) return respond({ error: error("not_found", `No method is named ${method}.`) });
    const entry = registry[method as keyof Registry];

    if (!clientSession.scopes.includes(entry.scope)) {
      return respond({
        error: error("forbidden", `${method} needs the ${entry.scope} scope, which this client session does not hold.`, {
          scope: entry.scope,
        }),
      });
    }
    // Subscriptions are #110: a stream passes the scope check above, then is not served yet.
    if (entry.kind === "stream") {
      return respond({ error: error("not_found", `${method} is a stream, and this environment serves no subscriptions yet.`) });
    }
    const parsed = (entry.params as Parser).safeParse(params);
    if (!parsed.success) return respond({ error: invalidParams(parsed.error.issues, `The params do not match ${method}'s schema.`) });

    // Command receipts (#111) wrap the handlers of command methods, keyed by the client session and commandId.
    const handler = methods[entry.name] as ((params: unknown, context: MethodContext) => unknown) | undefined;
    if (!handler) return respond({ error: error("not_found", `${method} is not served by this environment yet.`) });
    let result: unknown;
    try {
      result = await handler(parsed.data, { clientSession });
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
