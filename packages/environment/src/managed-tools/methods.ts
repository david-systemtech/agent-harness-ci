import type { MethodHandlers } from "../serve/methods.js";
import type { ManagedTools } from "./registry.js";

/**
 * The Managed tools methods on the method table (key-managers spec, "Wire
 * methods"): `tools.list` at `read`, answering the registry's rows, probed
 * first on a `refresh` at most every fifteen minutes.
 */
export const managedToolsMethods = (tools: ManagedTools): MethodHandlers => ({
  "tools.list": (params) => tools.list(params),
});
