import type { z } from "zod";
import {
  accessLogList,
  accessPairingsCreate,
  accessSessionsList,
  accessSessionsRefresh,
  accessSessionsRevoke,
} from "./methods/access.js";
import {
  environmentDrain,
  environmentRebuildProjections,
  environmentStatus,
  environmentSubscribe,
} from "./methods/environment.js";

/**
 * Every method the environment answers, in one typed table: the environment's
 * dispatch, its scope check and the typed client are all read from it.
 */
export const methods = [
  environmentStatus,
  environmentSubscribe,
  environmentDrain,
  environmentRebuildProjections,
  accessPairingsCreate,
  accessSessionsList,
  accessSessionsRevoke,
  accessSessionsRefresh,
  accessLogList,
] as const;

type Registered = (typeof methods)[number];
export type MethodName = Registered["name"];
export type Registry = { readonly [M in Registered as M["name"]]: M };

/** The methods by name. It has no prototype, so `toString` or `__proto__` is never a method. */
export const registry: Registry = Object.freeze(
  Object.assign(Object.create(null) as object, Object.fromEntries(methods.map((m) => [m.name, m]))),
) as Registry;

/** Whether `name` is a registered method. */
export const isMethodName = (name: string): name is MethodName => Object.hasOwn(registry, name);

/** The registered commands: the methods whose response carries a receipt. */
export type CommandName = Extract<Registered, { readonly kind: "command" }>["name"];

export type ParamsOf<N extends MethodName> = z.infer<Registry[N]["params"]>;
/** The method's own result: what a query answers, what a command answers beside its receipt, a stream's snapshot. */
export type ResultOf<N extends MethodName> = z.infer<Registry[N]["result"]>;
export type ErrorOf<N extends MethodName> = z.infer<Registry[N]["error"]>;
/**
 * What a `response` to the method carries as its `result`: a query's result
 * as it is; for a command, its receipt and, when this request applied it, its result.
 */
export type ResponseOf<N extends MethodName> = Registry[N] extends { readonly response: infer S extends z.ZodType }
  ? z.infer<S>
  : ResultOf<N>;
