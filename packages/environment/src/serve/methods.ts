import {
  methods as registered,
  type ErrorOf,
  type Method,
  type MethodKind,
  type MethodName,
  type ParamsOf,
  type Registry,
  type ResultOf,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventInput, JsonObject, StreamRef, Tx } from "../event-log/event-log.js";
import type { StreamSource } from "../wire/subscriptions.js";

/** Who is calling: the client session the connection authenticated as. */
export interface MethodContext {
  readonly clientSession: VerifiedClientSession;
}

/**
 * What a command's handler is given beyond the caller: the command's id, the
 * caller as the log names an actor (`client_session:<id>`), and the
 * transaction the command runs in, which every append and auth-table write
 * of the handler takes, so they commit with the receipt or not at all.
 */
export interface CommandContext extends MethodContext {
  readonly commandId: string;
  readonly actor: string;
  readonly tx: Tx;
}

/**
 * A command's rejection as its handler gives it: one of the method's error
 * codes, which becomes the receipt's reason, and a message and data when it
 * has more to say. Dispatch fills in a plain message and no data.
 */
export interface CommandRejection<Code extends string = string> {
  readonly code: Code;
  readonly message?: string;
  readonly data?: JsonObject;
}

/**
 * What a command's handler answers: the aggregate it was aimed at, then its
 * result with the events to append for it (it may also append through the
 * context's `tx`), or its rejection, which appends nothing.
 */
export type CommandAnswer<Result, Code extends string = string> =
  | {
      readonly aggregate: StreamRef;
      readonly result: Result;
      readonly events?: readonly EventInput[];
      readonly rejected?: undefined;
    }
  | { readonly aggregate: StreamRef; readonly rejected: CommandRejection<Code> };

/** The context a handler of a method of `Kind` is given. */
export type ContextOf<Kind extends MethodKind> = Kind extends "command" ? CommandContext : MethodContext;

/**
 * What the handler of a method of `Kind` returns: its `Result`; for a
 * command, the answer that names its aggregate and carries its `Result` and
 * events, or its rejection with one of the method's error `Code`s; for a
 * stream, the source its subscription reads, whose snapshot is the `Result`.
 */
export type HandlerResult<Kind extends MethodKind, Result, Code extends string = string> = Kind extends "stream"
  ? StreamSource<Result>
  : Kind extends "command"
    ? CommandAnswer<Result, Code>
    : Result;

/**
 * What a handler of a method of `Kind` gives back. A command's handler runs
 * inside the command's transaction, so it answers at once; a query's and a
 * stream's may answer later.
 */
export type HandlerReturn<Kind extends MethodKind, Result, Code extends string = string> = Kind extends "command"
  ? HandlerResult<Kind, Result, Code>
  : HandlerResult<Kind, Result, Code> | Promise<HandlerResult<Kind, Result, Code>>;

/**
 * How the environment answers one method, after the wire has checked the
 * caller's scope and the params against the registry's schema. A thrown
 * `ContractError` is the answer's error; anything else thrown is `internal`.
 * A command's handler runs once per client session and command id, and is
 * answered with its receipt (`wire/dispatch.ts`); a rejection it returns is
 * stored in the receipt, while a throw stores nothing. A stream's handler
 * names the `StreamSource` to subscribe to; the subscription is the wire's.
 */
export type MethodHandler<N extends MethodName> = (
  params: ParamsOf<N>,
  context: ContextOf<Registry[N]["kind"]>,
) => HandlerReturn<Registry[N]["kind"], ResultOf<N>, ErrorOf<N>["code"]>;

/**
 * A command that must hear from outside the log before it can decide (#228:
 * whether a provider still held the queued message it was asked to take
 * back). Its `prepare` runs first, outside any transaction, and answers the
 * handler the command then runs inside its transaction, answering at once
 * like any command's. A command id with a stored receipt is answered from
 * the receipt and `prepare` is not run; what `prepare` throws is answered as
 * a handler's throw is, storing no receipt.
 */
export interface PreparedCommand<N extends MethodName> {
  readonly prepare: (params: ParamsOf<N>, context: MethodContext) => Promise<MethodHandler<N>>;
}

/** Handlers by contracts method name, as the environment starts with them; a command's may be prepared first. */
export type MethodHandlers = {
  readonly [N in MethodName]?: MethodHandler<N> | (Registry[N]["kind"] extends "command" ? PreparedCommand<N> : never);
};

/** A stream's handler as dispatch calls it: its params were checked against its method's schema just before. */
type StreamHandler = (params: unknown, context: MethodContext) => StreamSource | Promise<StreamSource>;
/** A query's handler as dispatch calls it. */
type QueryHandler = (params: unknown, context: MethodContext) => unknown;
/** A command's handler as dispatch calls it, inside the command's transaction. */
type CommandHandler = (params: unknown, context: CommandContext) => CommandAnswer<unknown>;
/** A prepared command as dispatch calls it: `prepare`, then the handler it answers, inside the command's transaction. */
export interface PreparedCommandHandler {
  readonly prepare: (params: unknown, context: MethodContext) => Promise<CommandHandler>;
}

/**
 * One method as dispatch serves it: its registry entry and its handler, if
 * one is registered. The kind says which handlers name a stream source and
 * which run as commands.
 */
export type ServedMethod =
  | { readonly kind: "stream"; readonly method: Method; readonly handler: StreamHandler | undefined }
  | { readonly kind: "command"; readonly method: Method; readonly handler: CommandHandler | PreparedCommandHandler | undefined }
  | { readonly kind: "query"; readonly method: Method; readonly handler: QueryHandler | undefined };

/**
 * The methods the wire dispatches into after its scope check: every method of
 * the contracts registry, each with the handler registered for it so far. A
 * method with none is not served yet, and is answered `not_found`.
 */
export interface MethodTable {
  /** The method named `name`; undefined when no method has that name. */
  get(name: string): ServedMethod | undefined;
  /** Serves the registry entry `method` with `handler`, replacing any handler it had. */
  register<N extends MethodName>(method: Registry[N], handler: MethodHandler<N>): void;
}

/** A table of every registered method, served by `handlers`. */
export const createMethodTable = (handlers: MethodHandlers): MethodTable => {
  const served = new Map<string, ServedMethod>();
  // The one place a handler's params are widened: dispatch parses them with the same method's schema first.
  const serve = (method: Method, handler: unknown): void => void served.set(method.name, { kind: method.kind, method, handler } as ServedMethod);
  for (const method of registered) serve(method, handlers[method.name]);
  return {
    get: (name) => served.get(name),
    register: (method, handler) => serve(method, handler),
  };
};
