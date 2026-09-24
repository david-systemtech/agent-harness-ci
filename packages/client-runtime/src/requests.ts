import { isCommand, registry, type MethodName, type ParamsOf, type ResponseOf, type Scope } from "@agent-harness/contracts";
import type { AbsentReason, CapabilityAnswer } from "./capabilities.js";
import type { ResponseFrame } from "@agent-harness/contracts";
import type { Clock } from "./platform.js";

/**
 * `requests.call` (docs/specs/client-runtime.md, "The offline outbox,
 * receipts and optimistic application"): a direct request to one
 * environment, for the non-mutating methods and for the `admin` calls
 * (`access.*`), which are never queued. A `sessions:write` or `runs:drive`
 * command is refused (`outbox`): every one goes through the outbox's
 * `commands.dispatch`, so none can skip its command-id and receipt rules
 * by being sent here. It asks `capability` first and
 * answers absent-with-reason at once when the connection cannot take it,
 * so nothing is ever held for later (a connection not yet `ready` is
 * `unreachable`, the specification's word, whatever phase it is in); it
 * checks the params and the answer against the method's schemas; and it
 * gives up after `REQUEST_TIMEOUT_MS`.
 *
 * Added by the terminal UI (#143) for `/pair create` and `/environment`'s
 * client sessions, ahead of the outbox ticket (#128), which owns the request
 * cache and `commands.dispatch` beside it.
 */

/** How long a request waits for its answer. A chosen default (the specification's 30 seconds). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The scopes whose commands only the outbox sends (docs/specs/client-runtime.md: every `sessions:write` and `runs:drive` call). */
const OUTBOX_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["sessions:write", "runs:drive"]);

/**
 * Why a request has no result: a capability's absent reason (nothing was
 * sent), `outbox` (a command only the outbox sends; nothing was sent),
 * `invalid_params` (the params are not the method's; nothing was sent),
 * `timeout`, `malformed` (the answer is not the method's), or the
 * environment's own error code, passed on as it is.
 */
export type RequestFailureCode = AbsentReason | "outbox" | "invalid_params" | "timeout" | "malformed" | (string & {});

export interface RequestFailure {
  readonly code: RequestFailureCode;
  /** One line for people. */
  readonly message: string;
  /** The environment's structured `data`, when the failure is its error. */
  readonly data?: Record<string, unknown>;
}

/** A query's result as it is; a command's receipt beside its result (`ResponseOf`). */
export type RequestAnswer<N extends MethodName> =
  | { readonly ok: true; readonly result: ResponseOf<N> }
  | { readonly ok: false; readonly error: RequestFailure };

export interface Requests {
  /**
   * Sends `method` with `params` on the environment's ready socket and
   * answers its response. A stream is refused (`unsupported`): the
   * runtime's subscriptions are its own. A command's params carry the
   * caller's `commandId`.
   */
  call<N extends MethodName>(environmentId: string, method: N, params: ParamsOf<N>): Promise<RequestAnswer<N>>;
}

export interface RequestsHost {
  readonly clock: Clock;
  capability(environmentId: string, method: MethodName): CapabilityAnswer;
  /** A request on the environment's ready socket; rejects when there is none, or when it closes first. */
  request(environmentId: string, method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
}

const failed = (code: RequestFailureCode, message: string, data?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(data && { data }) } }) as const;

export const createRequests = (host: RequestsHost): Requests => ({
  async call<N extends MethodName>(environmentId: string, method: N, params: ParamsOf<N>): Promise<RequestAnswer<N>> {
    const entry = registry[method];
    if (entry.kind === "stream") return failed("unsupported", `${method} is a subscription; the runtime subscribes to it itself.`);
    if (OUTBOX_SCOPES.has(entry.scope)) return failed("outbox", `${method} is a ${entry.scope} command; it is sent through the outbox, never as a direct request.`);
    const capability = host.capability(environmentId, method);
    // A connection on its way to `ready` (connecting, starting, updating) holds nothing for later: it is unreachable now.
    if (capability.status === "absent") return failed(capability.reason === "not-ready" ? "unreachable" : capability.reason, capability.message);
    const checked = entry.params.safeParse(params);
    if (!checked.success) return failed("invalid_params", `The params are not ${method}'s: ${checked.error.issues.map((i) => i.message).join("; ")}`);

    let timer: { cancel(): void } | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = host.clock.setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS)));
    let response: ResponseFrame | "timeout";
    try {
      response = await Promise.race([host.request(environmentId, method, checked.data as Record<string, unknown>), timeout]);
    } catch (error) {
      return failed("unreachable", error instanceof Error ? error.message : String(error));
    } finally {
      timer?.cancel();
    }
    if (response === "timeout") return failed("timeout", `The environment did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    if (response.error) return failed(response.error.code, response.error.message, response.error.data);
    const schema = isCommand(entry) ? entry.response : entry.result;
    const result = schema.safeParse(response.result);
    if (!result.success) return failed("malformed", `The environment's answer to ${method} is not the method's.`);
    return { ok: true, result: result.data as ResponseOf<N> };
  },
});
