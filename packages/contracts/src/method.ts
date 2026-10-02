import { z } from "zod";
import { SHARED_ERRORS, SHARED_ERROR_CODES } from "./errors.js";
import { CommandId, Sequence } from "./primitives.js";
import { commandResponse, type CommandResponseSchema } from "./receipt.js";
import { SCOPES, type Scope } from "./scopes.js";

/** One error member a method adds to the shared union, made with `errorSchema`. */
export type ErrorMember = z.ZodObject<{ code: z.ZodLiteral<string>; message: z.ZodString; data: z.ZodObject }>;

/**
 * What a method is: a query reads and answers once; a command changes
 * something and takes a client-generated `commandId`, so a retry applies
 * once, and is answered with its receipt beside its result; a stream is a
 * subscription, answered by `subscribed`, then a snapshot or a replay from
 * its `afterSequence` cursor, then live events.
 */
export const METHOD_KINDS = ["query", "command", "stream"] as const;
export type MethodKind = (typeof METHOD_KINDS)[number];

interface MethodSpecBase {
  /** `area.verb`: `environment.status`, `access.pairings.create`. */
  readonly name: `${string}.${string}`;
  /** The one scope a client session needs to call the method or open the stream. */
  readonly scope: Scope;
  /**
   * What a call returns; for a stream, the payload of its `snapshot`. The
   * stream's events are `EventEnvelope`s.
   */
  readonly result: z.ZodObject | z.ZodUnion<readonly [z.ZodObject, ...z.ZodObject[]]>;
  /** The method's own errors, beyond the shared union every method may return. */
  readonly errors: readonly ErrorMember[];
}

interface QuerySpec extends MethodSpecBase {
  readonly kind: "query";
  readonly params: z.ZodObject | z.ZodUnion<readonly [z.ZodObject, ...z.ZodObject[]]>;
}

interface CommandSpec extends MethodSpecBase {
  readonly result: z.ZodObject;
  readonly kind: "command";
  readonly params: z.ZodObject<{ commandId: typeof CommandId }>;
}

interface StreamSpec extends MethodSpecBase {
  readonly result: z.ZodObject;
  readonly kind: "stream";
  readonly params: z.ZodObject<{ afterSequence: typeof Sequence }>;
}

/**
 * A registry entry as written: name, scope, kind, params, result and own
 * errors, every one required. `scope` is a single `Scope`, so a method with
 * none, or with a list, does not compile; a command's params must hold a
 * `commandId` and a stream's an `afterSequence`.
 */
export type MethodSpec = QuerySpec | CommandSpec | StreamSpec;

/** The error union a method may return: the shared members, then its own. */
export type MethodErrorUnion<M extends MethodSpec> = z.ZodDiscriminatedUnion<
  [...typeof SHARED_ERRORS, ...M["errors"]],
  "code"
>;

/**
 * What a command's entry adds: the schema of its `response`'s result, the
 * receipt beside the method's own result (`commandResponse`).
 */
export type CommandResponsePart<M extends MethodSpec> = M extends { readonly kind: "command" }
  ? { readonly response: CommandResponseSchema<M["result"]> }
  : unknown;

/**
 * A registry entry: its spec plus the error union built from it, and for a
 * command the schema its response carries. A query's response carries its
 * `result` as it is; a stream is answered `subscribed`.
 */
export type Method<M extends MethodSpec = MethodSpec> = M & { readonly error: MethodErrorUnion<M> } & CommandResponsePart<M>;

/** A command among `T`: the members of a union whose kind is `command`, or `T` known to be one. */
type CommandOf<T> = [Extract<T, { readonly kind: "command" }>] extends [never]
  ? T & { readonly kind: "command" }
  : Extract<T, { readonly kind: "command" }>;

/**
 * Whether `entry` (a spec, a registry entry, or anything carrying a method's
 * kind) is a command: its params hold a `commandId` and its response carries
 * a receipt. The one test of it, for the registry, the export, dispatch and clients.
 */
export const isCommand = <T extends { readonly kind: MethodKind }>(entry: T): entry is CommandOf<T> => entry.kind === "command";

const METHOD_NAME = /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/;

/**
 * A registry entry. The type requires exactly one scope, a `commandId` in a
 * command's params and a cursor in a stream's; the checks here refuse the
 * same mistakes from a caller the compiler cannot see, and an own error that
 * would shadow a shared one.
 */
export const defineMethod = <const M extends MethodSpec>(spec: M): Method<M> => {
  const { name, scope, kind } = spec as { name: unknown; scope: unknown; kind: unknown };
  if (typeof name !== "string" || !METHOD_NAME.test(name)) {
    throw new Error(`A method's name is area.verb; got ${JSON.stringify(name)}.`);
  }
  if (typeof scope !== "string" || !(SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`Method ${name} needs exactly one scope of ${SCOPES.join(", ")}; got ${JSON.stringify(scope)}.`);
  }
  if (typeof kind !== "string" || !(METHOD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Method ${name} needs a kind of ${METHOD_KINDS.join(", ")}; got ${JSON.stringify(kind)}.`);
  }
  if (isCommand(spec) && !("commandId" in spec.params.shape)) throw new Error(`Command ${name} takes a commandId in its params.`);
  if (spec.kind === "stream" && !("afterSequence" in spec.params.shape)) throw new Error(`Stream ${name} takes an afterSequence cursor.`);
  const shared = new Set<string>(SHARED_ERROR_CODES);
  const own = new Set<string>();
  for (const member of spec.errors) {
    const code = member.shape.code.value;
    if (shared.has(code)) throw new Error(`Method ${name} redefines the shared error ${code}.`);
    if (own.has(code)) throw new Error(`Method ${name} defines the error ${code} twice.`);
    own.add(code);
  }
  const error = z.discriminatedUnion("code", [...SHARED_ERRORS, ...spec.errors]);
  const response = isCommand(spec) ? { response: commandResponse(spec.result) } : {};
  return Object.freeze({ ...spec, error, ...response }) as unknown as Method<M>;
};

/** A command's params: `shape` plus the `commandId` every command takes. */
export const commandParams = <const S extends z.core.$ZodLooseShape>(shape: S) =>
  z.object({ commandId: CommandId, ...shape });

/** A stream's params: `shape` plus the `afterSequence` cursor replay starts after (0 for everything). */
export const subscriptionParams = <const S extends z.core.$ZodLooseShape>(shape: S) =>
  z.object({ afterSequence: Sequence, ...shape });
