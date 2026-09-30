/**
 * Publishes a tag's release from the folder the release build wrote, or
 * checks that it is not yet published (launcher-update spec, "The release";
 * #358): `scripts/release/publish.ts`, run from the command line. The release
 * workflow runs `--check` before anything is built or pushed, and `--from`
 * as its last step, on the job's forge and repository with the job's token.
 *
 *   RELEASE_TOKEN=<token> pnpm --filter agent-harness publish-release --tag v0.5.0 --from release-assets
 */
import { ArgumentsError, PUBLISH_USAGE, publishOptionsOf } from "./release/arguments.js";
import { checkUnpublished, PublishError, publishRelease } from "./release/publish.js";

try {
  const { tag, folder, forge } = publishOptionsOf(process.argv.slice(2), process.env, process.env["INIT_CWD"] ?? process.cwd());
  if (folder === null) await checkUnpublished(tag, forge);
  else await publishRelease({ tag, folder }, forge);
} catch (error) {
  if (error instanceof ArgumentsError) {
    console.error(`${error.message}\n${PUBLISH_USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof PublishError) {
    console.error(`The release step failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
