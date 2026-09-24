import {
  methods as registered,
  type Method,
  type MethodKind,
  type MethodName,
  type ParamsOf,
  type Registry,
  type ResultOf,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { StreamSource } from "../wire/subscriptions.js";

/** Who is calling: the client session the connection authenticated as. */
export interface MethodContext {
  readonly clientSession: VerifiedClientSession;
}

/**
 * What the handler of a method of `Kind` returns: its `Result`, or for a
 * stream the source its subscription reads, whose snapshot is the `Result`.
 */
export type HandlerResult<Kind extends MethodKind, Result> = Kind extends "stream" ? StreamSource<Result> : Result;

/**
 * How the environment answers one method, after the wire has checked the
 * caller's scope and the params against the registry's schema. A thrown
 * `ContractError` is the answer's error; anything else thrown is `internal`.
 * A stream's handler names the `StreamSource` to subscribe to; the
 * subscription is the wire's.
 */
export type MethodHandler<N extends MethodName> = (
  params: ParamsOf<N>,
  context: MethodContext,
) => HandlerResult<Registry[N]["kind"], ResultOf<N>> | Promise<HandlerResult<Registry[N]["kind"], ResultOf<N>>>;

/** Handlers by contracts method name, as the environment starts with them. */
export type MethodHandlers = { readonly [N in MethodName]?: MethodHandler<N> };

/** A stream's handler as dispatch calls it: its params were checked against its method's schema just before. */
type StreamHandler = (params: unknown, context: MethodContext) => StreamSource | Promise<StreamSource>;
/** A query's or command's handler as dispatch calls it. */
type ResultHandler = (params: unknown, context: MethodContext) => unknown;

/**
 * One method as dispatch serves it: its registry entry and its handler, if
 * one is registered. The kind says which handlers name a stream source.
 */
export type ServedMethod =
  | { readonly kind: "stream"; readonly method: Method; readonly handler: StreamHandler | undefined }
  | { readonly kind: "query" | "command"; readonly method: Method; readonly handler: ResultHandler | undefined };

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
