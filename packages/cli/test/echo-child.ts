/**
 * A version's CLI that only says how it was run: one JSON line on standard
 * output with its version (its package's, as `serve` reports its own) and its
 * arguments, then an exit with the code `ECHO_EXIT` names (preset 0). The
 * launcher entry and the shim tests run it as the version they start.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const entry = process.argv[1] ?? ".";
const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
process.stdout.write(`${JSON.stringify({ version, args: process.argv.slice(2) })}\n`);
process.exitCode = Number(process.env["ECHO_EXIT"] ?? 0);
