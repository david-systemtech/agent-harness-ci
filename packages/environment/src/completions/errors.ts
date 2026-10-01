import type { ServerResponse } from "node:http";
import { ContractError, type CompletionsErrorBody, type CompletionsRunEnd } from "@agent-harness/contracts";
import { sendJson } from "../serve/http.js";

/**
 * The completions surface's refusals (claude-adapter spec, "The completions
 * surface"): OpenAI's error body, `{error: {message, type, code, param}}`,
 * with the harness's reason as the code and OpenAI's error family as the
 * type, chosen by the status.
 */

/** OpenAI's error family for a status. */
const typeOf = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 409:
      return "conflict_error";
    default:
      return status >= 500 && status !== 501 ? "server_error" : "invalid_request_error";
  }
};

/** What a turn that got as far as a session carries beside its error. */
export interface RefusalContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly ended?: CompletionsRunEnd;
  /** The turn's message, still waiting in the session's queue for a run to read it (#1045). */
  readonly waiting?: string;
}

/** A refusal the surface answers with: its status, the harness's reason, a sentence, and the field at fault when there is one. */
export class CompletionsRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly param: string | null;
  readonly context: RefusalContext | undefined;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, options: { param?: string | null; context?: RefusalContext; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = "CompletionsRefusal";
    this.status = status;
    this.code = code;
    this.param = options.param ?? null;
    this.context = options.context;
    this.headers = options.headers ?? {};
  }

  /** The body OpenAI's clients read. */
  body(): CompletionsErrorBody {
    const context = this.context;
    return {
      error: { message: this.message, type: typeOf(this.status), code: this.code, param: this.param },
      ...(context !== undefined && Object.keys(context).length > 0 && { "agent-harness": { ...context } }),
    };
  }
}

/** A path as a request names a field: `agent-harness.permissionMode`, `messages`. */
export const paramOf = (path: readonly PropertyKey[]): string | null => (path.length === 0 ? null : path.map(String).join("."));

/**
 * The refusal a `ContractError` the environment threw becomes: the wire's
 * codes mapped to statuses, the reason of a conflict as the code, the first
 * issue's path as the param of an `invalid_params`.
 */
export const fromContractError = (error: ContractError, context?: RefusalContext): CompletionsRefusal => {
  const options = context === undefined ? {} : { context };
  const reason = typeof error.data["reason"] === "string" ? error.data["reason"] : undefined;
  switch (error.code) {
    case "invalid_params": {
      const issues = error.data["issues"];
      const first = Array.isArray(issues) ? (issues[0] as { path?: unknown } | undefined) : undefined;
      const param = Array.isArray(first?.path) ? paramOf(first.path as PropertyKey[]) : null;
      return new CompletionsRefusal(400, reason === "unsupported" ? "unsupported" : "invalid_params", error.message, { ...options, param });
    }
    case "not_found": {
      const kind = typeof error.data["kind"] === "string" ? error.data["kind"] : "resource";
      return new CompletionsRefusal(404, `${kind}_not_found`, error.message, options);
    }
    case "conflict":
      return new CompletionsRefusal(409, reason ?? "conflict", error.message, options);
    case "unavailable":
      return new CompletionsRefusal(503, "unavailable", error.message, options);
    case "unauthorized":
      return new CompletionsRefusal(401, "unauthorized", error.message, options);
    case "forbidden":
      return new CompletionsRefusal(403, "forbidden", error.message, options);
    default:
      return new CompletionsRefusal(500, error.code === "internal" ? "internal" : error.code, error.message, options);
  }
};

/** Any throw as a refusal: a refusal as it is, a `ContractError` mapped, anything else logged and `internal`. */
export const asRefusal = (thrown: unknown, context?: RefusalContext): CompletionsRefusal => {
  if (thrown instanceof CompletionsRefusal) return thrown;
  if (thrown instanceof ContractError) return fromContractError(thrown, context);
  console.error("The completions surface failed:", thrown);
  return new CompletionsRefusal(500, "internal", "The environment failed.", context === undefined ? {} : { context });
};

/** Answers a refusal, unless something has been sent already, when the connection is cut. */
export const sendRefusal = (response: ServerResponse, refusal: CompletionsRefusal): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, refusal.status, refusal.body(), { "cache-control": "no-store", ...refusal.headers });
};
