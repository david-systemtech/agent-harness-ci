import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BuildOptions } from "./build.js";

/** How the release build is run, for its usage line. */
export const BUILD_USAGE =
  "usage: pnpm --filter agent-harness build-artefacts --tag v<version> --out <folder> --image-reference <reference> --image-digest sha256:<hex> [--platform <os>-<arch>]...";

/** Arguments the build cannot take: the message says which. */
export class ArgumentsError extends Error {
  override readonly name = "ArgumentsError";
}

/**
 * The build's options from its command line `args`, a relative `--out` read
 * from `cwd` (where pnpm was run, which pnpm passes a script as `INIT_CWD`).
 * An option missing or unknown is an `ArgumentsError`.
 */
export const buildOptionsOf = (args: readonly string[], cwd: string): BuildOptions => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        tag: { type: "string" },
        out: { type: "string" },
        "image-reference": { type: "string" },
        "image-digest": { type: "string" },
        platform: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ArgumentsError(error instanceof Error ? error.message : String(error));
  }
  const { tag, out, "image-reference": reference, "image-digest": digest, platform } = values;
  if (tag === undefined || out === undefined) throw new ArgumentsError("--tag and --out are needed: the release's tag, and the folder its assets are written to.");
  if (reference === undefined || digest === undefined) throw new ArgumentsError("--image-reference and --image-digest are needed: the release manifest names the release's image.");
  return { tag, out: resolve(cwd, out), image: { reference, digest }, ...(platform !== undefined && { platforms: platform }) };
};
