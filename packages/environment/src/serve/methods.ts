import type { MethodName, ParamsOf, ResultOf } from "@agent-harness/contracts";
import type { VerifiedSession } from "../auth/client-sessions.js";

/** Who is calling: the client session the connection authenticated as. */
export interface MethodContext {
  readonly clientSession: VerifiedSession;
}

/**
 * How the environment answers one method, after the wire has checked the
 * caller's scope and the params against the registry's schema. A thrown
 * `ContractError` is the answer's error; anything else thrown is `internal`.
 */
export type MethodHandler<N extends MethodName> = (
  params: ParamsOf<N>,
  context: MethodContext,
) => ResultOf<N> | Promise<ResultOf<N>>;

/**
 * The environment's handlers by contracts method name: the table the wire
 * dispatches into after its scope check. A method with no entry is not
 * served yet, and is answered `not_found`.
 */
export type MethodHandlers = { readonly [N in MethodName]?: MethodHandler<N> };
