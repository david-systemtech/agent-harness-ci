#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { PRODUCT_NAME } from "@agent-harness/contracts";

// `../package.json` is the CLI's manifest from `src/` and from `dist/` alike.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${PRODUCT_NAME} ${version}\n`);
} else {
  process.stderr.write(`usage: ${PRODUCT_NAME} --version\n`);
  process.exitCode = 2;
}
