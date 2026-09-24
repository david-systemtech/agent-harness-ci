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

export type ParamsOf<N extends MethodName> = z.infer<Registry[N]["params"]>;
export type ResultOf<N extends MethodName> = z.infer<Registry[N]["result"]>;
export type ErrorOf<N extends MethodName> = z.infer<Registry[N]["error"]>;
