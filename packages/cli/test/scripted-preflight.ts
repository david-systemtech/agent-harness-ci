/**
 * The scripted preflight: a small Node program standing in for a version's
 * `preflight` verb, for the launcher's tests. A version laid out with the
 * scripted child runs it for `preflight` (`layOutVersion`); it reads what to
 * do from the preflight script in its version's folder (`ScriptedPreflight`,
 * `pass` with none) and appends each run to the runs file the script names.
 * Its version and launcher protocol are its CLI package's, as a build's are.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PreflightReport } from "@agent-harness/contracts/launcher";
import { PREFLIGHT_SCRIPT_FILE, type ScriptedPreflight } from "./launcher-fixtures.js";

const main = process.argv[1] ?? ".";
// The CLI's entry is packages/cli/dist/main.js in its version's folder.
const root = resolve(main, "..", "..", "..", "..");
const { version, launcherProtocol } = JSON.parse(readFileSync(join(dirname(main), "..", "package.json"), "utf8")) as { version: string; launcherProtocol: number };
const scriptPath = join(root, PREFLIGHT_SCRIPT_FILE);
const { behaviour = "pass", reports, runs }: ScriptedPreflight = existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptedPreflight) : {};

if (runs !== undefined) appendFileSync(runs, `${JSON.stringify({ version, args: process.argv.slice(2), pid: process.pid })}\n`);

if (behaviour === "fail") {
  process.stdout.write("loading SQLite, node-pty and the bundled Claude binary\n");
  process.stderr.write("agent-harness preflight failed: node-pty: node-pty did not load (invalid ELF header).\n");
  process.exitCode = 1;
} else if (behaviour === "hang") {
  process.stdout.write("loading SQLite\n");
  setInterval(() => undefined, 60_000);
} else {
  const report: PreflightReport = { version, protocolVersion: 1, launcherProtocol, databaseSchemaVersion: 6, bundledClaudeCodeVersion: "2.1.283", ...reports };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
