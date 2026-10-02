import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A fake CLI that records hashes of its block and uses its isolated fallback directory. */
export const installFakeDopplerCli = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const calls = join(directory, "calls.jsonl");
  const script = join(directory, "doppler.cjs");
  writeFileSync(script, `const { appendFileSync, writeFileSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("v3.76.0"); process.exit(0); }
const saw = {};
for (const [name, value] of Object.entries(process.env)) if (/^(DOPPLER|ENCLAVE)_/.test(name)) saw[name] = createHash("sha256").update(value).digest("hex");
const directory = process.env.DOPPLER_CONFIG_DIR;
writeFileSync(join(directory, "fallback.json"), "fake-fallback-for-tests");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, saw, directory, mode: statSync(directory).mode & 0o777 }) + "\\n");
console.log(JSON.stringify(["FORGE_HOME_TOKEN"]));
`);
  const path = join(directory, "doppler");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return { path, calls: (): { argv: string[]; saw: Record<string, string>; directory: string; mode: number }[] => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
};
