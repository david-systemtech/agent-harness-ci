/**
 * The scripted child: a small Node program standing in for `serve` under the
 * launcher, for the launcher's tests. The launcher runs it as a version's
 * CLI (`installVersion`) with `serve --data-dir <dir>`; it reads what to do at
 * this start from the child script in that directory (`ChildStart`, one entry
 * per start in order, `serve` past the last), and appends what happens to the
 * child report there, one JSON line each. Its version is its package's, as
 * `serve` reports its own.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLauncherMessage, type EnvironmentMessage } from "@agent-harness/contracts/launcher";
import { CHILD_REPORT_FILE, CHILD_SCRIPT_FILE, type ChildEvent, type ChildStart } from "./launcher-fixtures.js";

const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? ".";
const entry = process.argv[1] ?? ".";
const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
const reportPath = join(dataDir, CHILD_REPORT_FILE);
const readLines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : []);
const start = readLines(reportPath).filter((line) => (JSON.parse(line) as ChildEvent).event === "started").length;
const scriptPath = join(dataDir, CHILD_SCRIPT_FILE);
const script = existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as ChildStart[]) : [];
const behaviour: ChildStart = script[start] ?? "serve";

const report = (event: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(reportPath, `${JSON.stringify({ start, pid: process.pid, version, event, ...detail })}\n`);

/** Sends `message` to the launcher, then calls `after`. */
const send = (message: EnvironmentMessage, after: () => void = () => undefined) => process.send?.(message, undefined, {}, () => after());

/** Leaves as `serve` does after a drain: the channel closes last, and the process ends with `code` once nothing is left. */
const leave = (code: number) => {
  process.exitCode = code;
  if (process.connected) process.disconnect();
};

report("started", { args, behaviour });

if (behaviour === "crash") process.exit(1);
if (behaviour === "exit-0") process.exit(0);

let committed = false;
let drainsPassedOver = 0;
process.on("message", (raw) => {
  const message = parseLauncherMessage(raw);
  report("heard", { message: message ?? raw });
  if (message === undefined || behaviour === "silent") return;
  switch (message.type) {
    case "committed":
      if (committed) return;
      committed = true;
      process.on("SIGTERM", () => {
        report("drained", { trigger: "signal" });
        leave(0);
      });
      report("committed");
      if (behaviour === "drain") {
        report("drained", { trigger: "command" });
        return leave(0);
      }
      if (behaviour === "crash-after-commit") process.exit(3);
      // Something the launcher does not know goes first: it must pass it over and still answer.
      process.send?.({ type: "no-such-message" });
      return send({ type: "versions?", id: 1 });
    case "idle?":
      return send({ type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false });
    case "drain?":
      if (behaviour === "deaf-once" && drainsPassedOver++ === 0) return;
      report("drained", { trigger: "launcher" });
      return send({ type: "draining", drainingSince: new Date().toISOString(), trigger: "launcher" }, () => leave(0));
    default:
      return;
  }
});

if (behaviour !== "silent") send({ type: "prepared", version });
