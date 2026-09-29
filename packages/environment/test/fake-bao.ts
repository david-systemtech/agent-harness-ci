import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `bao` on a PATH the test sets (key-managers spec, "Testing
 * Decisions"; #368): `bao version` prints a version; any other command
 * prints, as one line of JSON, every `BAO_` and `VAULT_` variable it was
 * run with, by name and the SHA-256 of its value (never the value), and
 * exits 0. A shell script running a CommonJS script under this test's own
 * Node, so it runs from any directory with any PATH.
 */

/** The version `bao version` prints. */
export const FAKE_BAO_VERSION = "OpenBao v2.6.3 (fake for tests)";

/** Puts a fake `bao` in `directory`, and answers its path. */
export const installFakeBao = (directory: string): string => {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "bao.cjs");
  writeFileSync(
    script,
    `const { createHash } = require("node:crypto");
if (process.argv[2] === "version" || process.argv[2] === "--version") {
  console.log(${JSON.stringify(FAKE_BAO_VERSION)});
  process.exit(0);
}
const seen = {};
for (const [name, value] of Object.entries(process.env)) if (/^(BAO|VAULT)_/.test(name)) seen[name] = createHash("sha256").update(value ?? "").digest("hex");
console.log(JSON.stringify(seen));
`,
  );
  const bao = join(directory, "bao");
  writeFileSync(bao, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(bao, 0o755);
  return bao;
};

/** The hash the fake `bao` reports a value by. */
export const baoHash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** What the fake `bao` printed: each variable it saw by name, with its value's hash. */
export const baoSaw = (stdout: string): Record<string, string> => JSON.parse(stdout.trim()) as Record<string, string>;
