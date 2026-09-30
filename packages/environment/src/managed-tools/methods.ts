import type { MethodHandlers } from "../serve/methods.js";
import type { ToolDoctor } from "./doctor.js";
import type { ManagedTools } from "./registry.js";
import type { ToolRunner } from "./runner.js";
import type { ToolVerifier } from "./verify.js";

/**
 * The Managed tools methods on the method table (key-managers spec, "Wire
 * methods"): `tools.list` at `read`, answering the registry's rows, probed
 * first on a `refresh` at most every fifteen minutes, with the latest
 * versions due fetched behind the answer (#374); `tools.detail`, a `read`
 * query running a tool's `doctor` (#374); `tools.verify`, an `admin` query
 * running a tool's verify command (#375); `tools.run`, an `admin` command
 * installing or updating a tool in a tool terminal (#376).
 */
export const managedToolsMethods = (tools: ManagedTools, doctor: ToolDoctor, verifier: ToolVerifier, runner: ToolRunner): MethodHandlers => ({
  "tools.list": (params) => tools.list(params),
  "tools.detail": ({ tool }) => doctor.detail(tool),
  "tools.verify": ({ tool }) => verifier.verify(tool),
  "tools.run": runner.run,
});
