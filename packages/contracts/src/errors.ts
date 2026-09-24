import { z } from "zod";
import { JsonObject } from "./primitives.js";
import { Scope } from "./scopes.js";

/** A stable, machine-readable error code in snake case: `not_found`, `ceiling_exceeded`. */
export const ErrorCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .meta({ description: "A stable error code in snake case." });
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * One schema issue, as zod reports it: a code, the path to the offending
 * value and a message, plus whatever fields that code carries.
 */
export const SchemaIssue = z
  .looseObject({
    code: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .meta({ description: "One schema issue: a code, the path to the offending value and a message." });
export type SchemaIssue = z.infer<typeof SchemaIssue>;

/**
 * Any error as the `response` frame carries it: a stable `code`, a message
 * for people and structured `data` for programs. What a given method may
 * return is narrower: the shared union plus that method's own members.
 */
export const WireError = z
  .object({ code: ErrorCode, message: z.string(), data: JsonObject })
  .meta({ description: "An error as a response carries it: a stable code, a message and structured data." });
export type WireError = z.infer<typeof WireError>;

/** The schema of one error member: its literal `code`, a message and its own `data`. */
export const errorSchema = <const Code extends string, Data extends z.ZodObject>(code: Code, data: Data) =>
  z.object({ code: z.literal(code), message: z.string(), data });

/** The token is missing, invalid, foreign or expired. */
export const UnauthorizedError = errorSchema("unauthorized", z.object({})).meta({
  description: "The client session's token is missing, invalid, foreign or expired.",
});
/** The client session lacks the scope the method requires, named in `data`. */
export const ForbiddenError = errorSchema("forbidden", z.object({ scope: Scope })).meta({
  description: "The client session lacks the scope the method requires, named in data.scope.",
});
/** The environment is not ready yet, or is draining. */
export const UnavailableError = errorSchema(
  "unavailable",
  z.object({
    readiness: z.enum(["starting", "draining"]).meta({
      description: "Why the environment cannot answer: it is not ready yet, or it is draining.",
    }),
  }),
).meta({ description: "The environment is starting or draining; data.readiness says which." });
/** The params, or a frame, did not match the schema; `data.issues` says where. */
export const InvalidParamsError = errorSchema("invalid_params", z.object({ issues: z.array(SchemaIssue) })).meta({
  description: "The params or the frame did not match the schema; data.issues lists the schema's issues.",
});
/** The method's target does not exist. */
export const NotFoundError = errorSchema("not_found", z.object({})).meta({
  description: "The method's target does not exist.",
});
/** The target's state does not allow the method now. */
export const ConflictError = errorSchema("conflict", z.object({})).meta({
  description: "The target's state does not allow the method now.",
});
/** The environment failed; nothing the client sent is at fault. */
export const InternalError = errorSchema("internal", z.object({})).meta({
  description: "The environment failed; nothing the client sent is at fault.",
});

/**
 * An unauthenticated exchange (`/api/bootstrap` or `/api/pair`) came too
 * often from one address; `data.retryAfterMs` says when the next is
 * taken. Not a method error: methods sit behind a client session.
 */
export const RateLimitedError = errorSchema(
  "rate_limited",
  z.object({
    retryAfterMs: z.int().nonnegative().meta({ description: "Milliseconds until the next exchange is taken." }),
  }),
).meta({ description: "Too many exchanges from this address; data.retryAfterMs says when to try again." });
export type RateLimitedError = z.infer<typeof RateLimitedError>;

/** The errors every method may return, whatever its own members. */
export const SHARED_ERRORS = [
  UnauthorizedError,
  ForbiddenError,
  UnavailableError,
  InvalidParamsError,
  NotFoundError,
  ConflictError,
  InternalError,
] as const;

export const SharedError = z
  .discriminatedUnion("code", SHARED_ERRORS)
  .meta({ description: "The errors every method may return." });
export type SharedError = z.infer<typeof SharedError>;
export type SharedErrorCode = SharedError["code"];

/** The shared errors' codes, in the union's order. */
export const SHARED_ERROR_CODES: readonly SharedErrorCode[] = SHARED_ERRORS.map((member) => member.shape.code.value);

export type UnauthorizedError = z.infer<typeof UnauthorizedError>;
export type ForbiddenError = z.infer<typeof ForbiddenError>;
export type UnavailableError = z.infer<typeof UnavailableError>;
export type InvalidParamsError = z.infer<typeof InvalidParamsError>;
export type NotFoundError = z.infer<typeof NotFoundError>;
export type ConflictError = z.infer<typeof ConflictError>;
export type InternalError = z.infer<typeof InternalError>;

/** An issue as `invalidParams` takes it: one of zod's, or one built by hand in the same shape. */
export type IssueInput = z.core.$ZodIssue | z.input<typeof SchemaIssue>;

/** JSON for `value`, with the path segments and numbers JSON cannot carry turned into strings. */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "symbol" || typeof v === "bigint" ? String(v) : v)));

const SchemaIssues = z.array(SchemaIssue);

/**
 * The `invalid_params` error for a schema's `issues`. They go through JSON and
 * then the `SchemaIssue` schema, so `data` is plain data a frame can carry,
 * whatever zod put in them.
 */
export const invalidParams = (
  issues: readonly IssueInput[],
  message = "The input does not match the schema.",
): InvalidParamsError => ({
  code: "invalid_params",
  message,
  data: { issues: SchemaIssues.parse(plain(issues)) },
});

/**
 * A wire error, thrown. The codec throws one for a malformed frame; a handler
 * may throw one for the environment to answer with.
 */
export class ContractError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(error: WireError) {
    super(error.message);
    this.name = "ContractError";
    this.code = error.code;
    this.data = error.data;
  }

  /** The error as a `response` frame carries it. */
  toWire(): WireError {
    return { code: this.code, message: this.message, data: this.data };
  }
}
