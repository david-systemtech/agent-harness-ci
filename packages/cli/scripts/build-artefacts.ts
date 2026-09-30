/**
 * Builds a release's server artefacts, their sidecars and `release.json`
 * (launcher-update spec, "The release"; #356): `scripts/release/build.ts`,
 * run from the command line. The release workflow runs it on a linux-x64
 * runner, the one platform whose artefact needs its own runner (node-pty
 * compiles there); it builds the macOS and Windows artefacts there too.
 *
 *   pnpm --filter agent-harness build-artefacts --tag v0.5.0 --out release \
 *     --image-reference git.systemtech.dev:5526/david/agent-harness:0.5.0 --image-digest sha256:<hex>
 */
import { ArgumentsError, BUILD_USAGE, buildOptionsOf } from "./release/arguments.js";
import { buildRelease } from "./release/build.js";
import { BuildError } from "./release/targets.js";

try {
  await buildRelease(buildOptionsOf(process.argv.slice(2), process.env["INIT_CWD"] ?? process.cwd()));
} catch (error) {
  if (error instanceof ArgumentsError) {
    console.error(`${error.message}\n${BUILD_USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof BuildError) {
    console.error(`The release build failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
