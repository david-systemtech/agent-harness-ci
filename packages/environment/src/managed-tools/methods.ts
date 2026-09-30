import type { MethodHandlers } from "../serve/methods.js";
import type { ManagedTools } from "./registry.js";
import type { ToolVerifier } from "./verify.js";

/**
 * The Managed tools methods on the method table (key-managers spec, "Wire
 * methods"): `tools.list` at `read`, answering the registry's rows, probed
 * first on a `refresh` at most every fifteen minutes; `tools.verify`, an
 * `admin` query running a tool's verify command (#375).
 */
export const managedToolsMethods = (tools: ManagedTools, verifier: ToolVerifier): MethodHandlers => ({
  "tools.list": (params) => tools.list(params),
  "tools.verify": ({ tool }) => verifier.verify(tool),
});
