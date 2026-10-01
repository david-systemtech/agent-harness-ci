import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `op` on a PATH the test sets (key-managers spec, "Testing
 * Decisions"; #378): `op --version` prints a version; any other command
 * prints, as one line of JSON, every `OP_` variable it was run with, by name
 * and the SHA-256 of its value (never the value), records the same with its
 * arguments, and exits 0. A shell script running a CommonJS script under
 * this test's own Node, so it runs from any directory with any PATH.
 */

/** The version `op --version` prints: past 2.18.0, the first with service accounts. */
export const FAKE_OP_VERSION = "2.30.3";

/** What the fake `op` saw on one call: its arguments, and each `OP_` variable by name with its value's hash. */
export interface FakeOpCall {
  readonly argv: readonly string[];
  readonly saw: Readonly<Record<string, string>>;
}

export interface FakeOp {
  /** The executable, on the PATH the test gives. */
  readonly path: string;
  /** Every call but `--version` so far, in order. */
  calls(): FakeOpCall[];
}

/** Puts a fake `op` in `directory`. */
export const installFakeOp = (directory: string): FakeOp => {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "op.cjs");
  const calls = join(directory, "op-calls.jsonl");
  writeFileSync(
    script,
    `const { createHash } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log(${JSON.stringify(FAKE_OP_VERSION)});
  process.exit(0);
}
const saw = {};
for (const [name, value] of Object.entries(process.env)) if (/^OP_/.test(name)) saw[name] = createHash("sha256").update(value ?? "").digest("hex");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, saw }) + "\\n");
console.log(JSON.stringify(saw));
`,
  );
  const op = join(directory, "op");
  writeFileSync(op, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(op, 0o755);
  return {
    path: op,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as FakeOpCall)
        : [],
  };
};

/** The hash the fake `op` reports a value by. */
export const opHash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Variables as the fake `op` reports them: each by name, with its value's hash. */
export const opHashed = (variables: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, opHash(value)]));
