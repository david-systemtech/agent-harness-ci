/**
 * The scripted child: a small Node program standing in for `serve` under the
 * launcher, for the launcher's tests. The launcher runs it as a version's
 * CLI (`installVersion`) with `serve --data-dir <dir>`; it reads what to do at
 * this start from the child script in that directory (`ChildStart`, one entry
 * per start in order, `serve` past the last), and appends what happens to the
 * child report there, one JSON line each. Its version is its package's, as
 * `serve` reports its own.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLauncherMessage, type EnvironmentMessage } from "@agent-harness/contracts/launcher";
import { SERVICE_STATE_FILE } from "../src/launch/state.js";
import { VERSION_SENTINEL, versionDirectory } from "../src/launch/versions.js";
import { CHILD_REPORT_FILE, CHILD_SCRIPT_FILE, CREDENTIAL_ANSWER_FILE, writeDatabase, type ChildEvent, type ChildStart, type ScriptedStart } from "./launcher-fixtures.js";

const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? ".";
const entry = process.argv[1] ?? ".";
const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
const reportPath = join(dataDir, CHILD_REPORT_FILE);
const readLines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : []);
const start = readLines(reportPath).filter((line) => (JSON.parse(line) as ChildEvent).event === "started").length;
const scriptPath = join(dataDir, CHILD_SCRIPT_FILE);
const script = existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as ChildStart[]) : [];
const scripted = script[start] ?? "serve";
const { behaviour = "serve", writes, preparedAs, spoilsState, switchTo, install, busyFor = 0, says, credential }: ScriptedStart =
  typeof scripted === "string" ? { behaviour: scripted } : scripted;

const report = (event: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(reportPath, `${JSON.stringify({ start, pid: process.pid, version, event, ...detail })}\n`);

/** The service state as it is on disk now. */
const serviceState = (): Record<string, unknown> => JSON.parse(readFileSync(join(dataDir, SERVICE_STATE_FILE), "utf8")) as Record<string, unknown>;

/** Sends `message` to the launcher, then calls `after`. */
const send = (message: EnvironmentMessage, after: () => void = () => undefined) => process.send?.(message, undefined, {}, () => after());

/** Leaves as `serve` does after a drain: the channel closes last, and the process ends with `code` once nothing is left. */
const leave = (code: number) => {
  process.exitCode = code;
  if (process.connected) process.disconnect();
};

if (writes !== undefined) writeDatabase(dataDir, writes, "open");
report("started", { args, behaviour, dataFiles: readdirSync(dataDir).sort(), serviceLogVariable: process.env["AGENT_HARNESS_SERVICE_LOG"] ?? null,
  unloggedExitVariable: process.env["AGENT_HARNESS_UNLOGGED_EXIT"] ?? null,
});
if (says !== undefined) {
  process.stdout.write(`${says} on standard output\n`);
  process.stderr.write(`${says} on standard error\n`);
}

if (behaviour === "crash") process.exit(1);
if (behaviour === "exit-0") process.exit(0);

/** The id of the `switch?` it asks. */
const SWITCH_ID = 2;
/** The id of the `install?` it asks. */
const INSTALL_ID = 3;
let committed = false;
let drainsPassedOver = 0;
let idleAsked = 0;
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
      report("committed", { state: serviceState() });
      if (behaviour === "drain") {
        report("drained", { trigger: "command" });
        return leave(0);
      }
      if (behaviour === "crash-after-commit") process.exit(3);
      // Something the launcher does not know goes first: it must pass it over and still answer.
      process.send?.({ type: "no-such-message" });
      if (install !== undefined) return send({ type: "install?", id: INSTALL_ID, ...install });
      if (switchTo !== undefined) return send({ type: "switch?", id: SWITCH_ID, updateId: switchTo.updateId, version: switchTo.version });
      return send({ type: "versions?", id: 1 });
    case "installed":
    case "refused":
    case "switching":
      if (install !== undefined && message.id === INSTALL_ID) {
        report("install-answered", {
          answer: message,
          complete: existsSync(join(versionDirectory(dataDir, install.version), VERSION_SENTINEL)),
          staged: existsSync(install.staged),
        });
        if (message.type === "installed" && switchTo !== undefined) return send({ type: "switch?", id: SWITCH_ID, updateId: switchTo.updateId, version: switchTo.version });
        return;
      }
      if (message.type === "installed" || message.id !== SWITCH_ID) return;
      if (message.type === "switching") report("switching", { pendingUpdate: serviceState()["pendingUpdate"] });
      if (message.type === "switching" && switchTo?.lingers) return;
      return leave(0);
    case "idle?":
      return send({
        type: "idle",
        readiness: "ready",
        activity: idleAsked++ < busyFor ? { state: "busy", reason: "run-running" } : { state: "idle" },
        updatesManagedOutside: false,
      });
    case "drain?":
      if (behaviour === "deaf-once" && drainsPassedOver++ === 0) return;
      report("drained", { trigger: "launcher" });
      return send({ type: "draining", drainingSince: new Date().toISOString(), trigger: "launcher" }, () => leave(0));
    default:
      return;
  }
});

if (spoilsState) {
  rmSync(join(dataDir, SERVICE_STATE_FILE));
  mkdirSync(join(dataDir, SERVICE_STATE_FILE, "in-the-way"), { recursive: true });
}
const prepare = () => send({ type: "prepared", version: preparedAs ?? version });
if (credential !== undefined) {
  send({ type: "credential-access", state: "waiting" }, () => report("credential-waiting"));
  // The person's answer to the OS's prompt: the test writes it when it has seen the deadline pause.
  const answered = setInterval(() => {
    if (!existsSync(join(dataDir, CREDENTIAL_ANSWER_FILE))) return;
    clearInterval(answered);
    send({ type: "credential-access", state: credential }, () => (credential === "answered" ? prepare() : process.exit(1)));
  }, 20);
} else if (behaviour !== "silent") prepare();
