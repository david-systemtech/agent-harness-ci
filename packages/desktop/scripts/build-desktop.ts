/**
 * Builds one platform's desktop (#423): `scripts/desktop-build/build.ts`, run
 * from the command line on the platform it builds for, with that platform's
 * server artefact of the same version (the release build's, #356). The
 * `desktop` workflow runs it on the runners that have the platform's OS; the
 * Windows setup is built by hand (docs/agents/desktop-checklist.md).
 *
 *   pnpm --filter @agent-harness/desktop build-desktop --platform linux-x64 --tag v0.5.0 \
 *     --server release-assets/agent-harness-linux-x64.tar.gz --out desktop-assets
 */
import { ArgumentsError, DESKTOP_BUILD_USAGE, desktopBuildOptionsOf } from "./desktop-build/arguments.js";
import { buildDesktop } from "./desktop-build/build.js";
import { DesktopBuildError } from "./desktop-build/targets.js";

try {
  await buildDesktop(desktopBuildOptionsOf(process.argv.slice(2), process.env["INIT_CWD"] ?? process.cwd()));
} catch (error) {
  if (error instanceof ArgumentsError) {
    console.error(`${error.message}\n${DESKTOP_BUILD_USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof DesktopBuildError) {
    console.error(`The desktop build failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
