import type { Method, MethodName, ParamsOf, Registry, ResultOf } from "@agent-harness/contracts";
import type { z } from "zod";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { StreamSource } from "../wire/subscriptions.js";

/** Who is calling: the client session the connection authenticated as. */
export interface MethodContext {
  readonly clientSession: VerifiedClientSession;
}

/** What a method's handler answers: a query's or command's result, or for a stream the source its subscription reads. */
type Answered<N extends MethodName> = Registry[N]["kind"] extends "stream" ? StreamSource<ResultOf<N>> : ResultOf<N>;

/**
 * How the environment answers one method, after the wire has checked the
 * caller's scope and the params against the registry's schema. A thrown
 * `ContractError` is the answer's error; anything else thrown is `internal`.
 * A stream's handler names the `StreamSource` to subscribe to, whose
 * snapshot is the method's result; the subscription is the wire's.
 */
export type MethodHandler<N extends MethodName> = (
  params: ParamsOf<N>,
  context: MethodContext,
) => Answered<N> | Promise<Answered<N>>;

/**
 * The environment's handlers by contracts method name: the table the wire
 * dispatches into after its scope check. A method with no entry is not
 * served yet, and is answered `not_found`.
 */
export type MethodHandlers = { readonly [N in MethodName]?: MethodHandler<N> };

/** A handler as dispatch calls it, whatever its method. */
export type AnyHandler = (params: unknown, context: MethodContext) => unknown;

/**
 * A method served beside the contracts registry's, with its handler: a test
 * suite's synthetic stream, which the registry and its JSON Schema export
 * never hold. Made with `extraMethod`; never passed outside tests.
 */
export interface ExtraMethod {
  readonly method: Method;
  readonly handler: AnyHandler;
}

type Answer<M extends Method> = M["kind"] extends "stream" ? StreamSource<z.infer<M["result"]>> : z.infer<M["result"]>;

/** An extra method, its handler typed from the method's own schemas. */
export const extraMethod = <M extends Method>(
  method: M,
  handler: (params: z.infer<M["params"]>, context: MethodContext) => Answer<M> | Promise<Answer<M>>,
): ExtraMethod => ({ method, handler: handler as AnyHandler });

/**
 * The registry's methods and their handlers, with any extra methods beside
 * them: what dispatch reads. An extra method may not take a registered name.
 */
export const servedMethods = (
  registry: Registry,
  handlers: MethodHandlers,
  extra: readonly ExtraMethod[] = [],
): { readonly entries: Readonly<Record<string, Method>>; readonly handlers: Readonly<Record<string, unknown>> } => {
  const entries: Record<string, Method> = Object.assign(Object.create(null) as object, registry);
  const served: Record<string, unknown> = Object.assign(Object.create(null) as object, handlers);
  for (const { method, handler } of extra) {
    if (Object.hasOwn(entries, method.name)) throw new Error(`The extra method ${method.name} takes a registered name.`);
    entries[method.name] = method;
    served[method.name] = handler;
  }
  return { entries, handlers: served };
};
