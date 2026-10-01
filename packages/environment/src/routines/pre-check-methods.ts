import type { MethodHandlers } from "../serve/methods.js";
import type { ScriptsDirectory } from "./scripts-directory.js";

/**
 * The pre-checks' methods (routines spec, "Methods on the wire"; #526):
 * `routines.scripts.list` at `read`, the scripts directory's regular files.
 */

export interface PreCheckMethodsOptions {
  readonly scripts: ScriptsDirectory;
}

type PreCheckMethodName = "routines.scripts.list";

export const preCheckMethods = (options: PreCheckMethodsOptions): Required<Pick<MethodHandlers, PreCheckMethodName>> => ({
  "routines.scripts.list": async () => ({ directory: options.scripts.path, scripts: await options.scripts.list() }),
});
