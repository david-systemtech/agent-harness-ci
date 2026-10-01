import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildExtension, EXTENSION_DIST } from "./build.js";

/**
 * `pnpm --filter @agent-harness/extension build`, which the workspace build
 * runs: the extension into the package's `dist`, its version name the
 * package's version, the harness version. `--out` and `--version` build it
 * elsewhere and of another version.
 */

const { values } = parseArgs({ options: { out: { type: "string" }, version: { type: "string" } } });
const { version: packageVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { readonly version: string };
const outDir = resolve(values.out ?? EXTENSION_DIST);
const version = values.version ?? packageVersion;

await buildExtension({ outDir, version });
process.stdout.write(`Built the extension ${version} in ${outDir}.\n`);
