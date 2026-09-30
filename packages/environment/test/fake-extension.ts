import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fake extension (browser spec, "Testing Decisions"; #547): the built
 * extension a test environment carries, and a WebSocket client that finds
 * its environment as the real extension does, through the port file in the
 * unpacked folder.
 */

/** The built extension a test environment carries unless told otherwise: a manifest and a worker. */
export const TEST_EXTENSION = fileURLToPath(new URL("./fixtures/extension", import.meta.url));

/** The version name in `TEST_EXTENSION`'s manifest. */
export const TEST_EXTENSION_VERSION = "1.0.0-test";

/** The listener's ports in a test environment unless told otherwise: any free one, never 47615. */
export const TEST_EXTENSION_PORTS = { preferred: 0, last: 0 } as const;

/**
 * Writes a built extension of `version` into `dir`, as another harness
 * version would carry one: its manifest, naming the version, and `files`
 * (paths in the folder to their text). Answers `dir`.
 */
export const writeExtensionBuild = (dir: string, version: string, files: Readonly<Record<string, string>> = {}): string => {
  mkdirSync(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: "agent-harness", version: "1.0.0", version_name: version };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
