import type { MethodName, ParamsOf, ResultOf } from "@agent-harness/contracts";

/** How the environment answers one method, its params already checked against the registry's schema. */
export type MethodHandler<N extends MethodName> = (params: ParamsOf<N>) => ResultOf<N> | Promise<ResultOf<N>>;

/**
 * The environment's handlers by contracts method name: the table the wire
 * (#108) dispatches into after its scope check. A method with no entry is
 * not served yet.
 */
export type MethodHandlers = { readonly [N in MethodName]?: MethodHandler<N> };
