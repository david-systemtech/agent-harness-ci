import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fake bws on PATH: records the process block, never contacts a server. */
export const installFakeBws = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const calls = join(directory, "calls.jsonl");
  const script = join(directory, "bws.cjs");
  writeFileSync(script, `const { appendFileSync, readFileSync, statSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("bws 0.3.0"); process.exit(0); }
const saw = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BWS_")));
const config = process.env.BWS_CONFIG_FILE;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, saw, config: readFileSync(config, "utf8"), mode: statSync(config).mode & 0o777 }) + "\\n");
console.log(JSON.stringify([{ id: "fake-project-for-tests", name: "harness" }]));
`);
  const path = join(directory, "bws");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return { directory, calls: (): { argv: string[]; saw: Record<string, string>; config: string; mode: number }[] => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
};
