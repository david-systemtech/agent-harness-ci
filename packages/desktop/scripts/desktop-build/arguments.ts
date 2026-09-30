import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DesktopBuildOptions } from "./build.js";

/** How the desktop build is run, for its usage line. */
export const DESKTOP_BUILD_USAGE =
  "usage: pnpm --filter @agent-harness/desktop build-desktop --platform <darwin-arm64|win32-x64|linux-x64> --tag v<version> --server <the platform's server artefact> --out <folder>";

/** Arguments the build cannot take: the message says which. */
export class ArgumentsError extends Error {
  override readonly name = "ArgumentsError";
}

/**
 * The build's options from its command line `args`, a relative `--server` or
 * `--out` read from `cwd` (where pnpm was run, which pnpm passes a script as
 * `INIT_CWD`). An option missing, unknown or malformed is an `ArgumentsError`.
 */
export const desktopBuildOptionsOf = (args: readonly string[], cwd: string): DesktopBuildOptions => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { platform: { type: "string" }, tag: { type: "string" }, server: { type: "string" }, out: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ArgumentsError(error instanceof Error ? error.message : String(error));
  }
  const { platform, tag, server, out } = values;
  if (platform === undefined || tag === undefined || server === undefined || out === undefined) {
    throw new ArgumentsError(
      "--platform, --tag, --server and --out are each needed: the platform, the release's tag, its server artefact for that platform, and the folder the desktop is written to.",
    );
  }
  return { platform, tag, server: resolve(cwd, server), out: resolve(cwd, out) };
};
