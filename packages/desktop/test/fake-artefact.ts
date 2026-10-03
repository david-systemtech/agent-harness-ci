import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingUpdate } from "@agent-harness/contracts";
import type { ShellPlatform } from "@agent-harness/client-runtime";
import { ARTEFACT_CLI_ENTRY, artefactNode } from "@agent-harness/contracts/launcher";
import { scratch } from "./harness.js";

/**
 * A server artefact, unpacked, as the desktop carries one, whose CLI is a
 * fake: its `node` is this test's own Node, linked where the artefact for
 * `os` keeps its runtime, and its CLI's entry script answers the `service`
 * verbs from a service manager kept in a file, recording each run. No real
 * launchd, systemd or Task Scheduler is touched; the desktop spawns real
 * processes, so the command line it builds is proved.
 */

export interface FakeServiceState {
  readonly pendingUpdate?: PendingUpdate;
  readonly installed: boolean;
  readonly running: boolean;
  /** What discovery answers now: null while nothing answers. */
  readonly readiness: "starting" | "ready" | null;
  /** What discovery answers once the service is started: preset `starting`; null for a service that never answers. */
  readonly startsAs: "starting" | "ready" | null;
  /** How many `service status` runs after a start pass before it answers: preset none. */
  readonly answersAfter: number;
  /** A verb that fails, with the one sentence the CLI prints for it. */
  readonly fails?: { readonly verb: string; readonly message: string; readonly stream?: "stderr" | "stdout" };
}

export interface FakeArtefact {
  readonly root: string;
  /** The arguments of every run of its CLI, oldest first. */
  runs(): string[][];
  state(): FakeServiceState;
  set(state: Partial<FakeServiceState>): void;
}

const CLI = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const file = join(root, "service-manager.json");
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(root, "runs.jsonl"), JSON.stringify(args) + "\\n");
const save = () => writeFileSync(file, JSON.stringify(state));
const verb = args[0] === "service" ? args[1] : undefined;
if (state.fails && state.fails.verb === verb) {
  process[state.fails.stream ?? "stderr"].write(state.fails.message + "\\n");
  process.exit(1);
}
if (args[0] === "update") {
  if (args[1] === "status") process.stdout.write(JSON.stringify({ pending: state.pendingUpdate ?? { state: "current" } }));
  else if (args[1] === "apply" && args.includes("--now")) process.stdout.write("Updating now.\\n");
  else process.exit(2);
  process.exit(0);
}
switch (verb) {
  case "install":
    state.installed = true;
    save();
    process.stdout.write("Installed the launcher.\\n");
    break;
  case "start":
    if (!state.installed) {
      process.stderr.write("No service is installed. \`agent-harness service install\` installs it.\\n");
      process.exit(1);
    }
    state.running = true;
    state.pending = state.answersAfter;
    save();
    process.stdout.write("Started.\\n");
    break;
  case "status": {
    if (state.running && state.readiness === null && state.startsAs !== null) {
      if (state.pending > 0) state.pending -= 1;
      else state.readiness = state.startsAs;
      save();
    }
    const ready = state.installed && state.running && state.readiness === "ready";
    process.stdout.write(JSON.stringify({ installed: state.installed, running: state.running, readiness: state.readiness, ready, address: "http://127.0.0.1:7433" }, null, 2) + "\\n");
    process.exit(ready ? 0 : 3);
  }
  default:
    process.stderr.write("Unknown verb.\\n");
    process.exit(2);
}
`;

export const fakeArtefact = (os: ShellPlatform = "linux", state: Partial<FakeServiceState> = {}): FakeArtefact => {
  const root = join(scratch(), "server");
  const node = join(root, ...artefactNode(os));
  mkdirSync(dirname(node), { recursive: true });
  symlinkSync(process.execPath, node);
  const cli = join(root, ...ARTEFACT_CLI_ENTRY);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, CLI);
  writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({ name: "@agent-harness/cli", version: "0.5.0", type: "module" }));
  writeFileSync(join(root, "runs.jsonl"), "");
  const file = join(root, "service-manager.json");
  const read = (): FakeServiceState => JSON.parse(readFileSync(file, "utf8")) as FakeServiceState;
  writeFileSync(file, JSON.stringify({ installed: false, running: false, readiness: null, startsAs: "starting", answersAfter: 0, ...state }));
  return {
    root,
    runs: () =>
      readFileSync(join(root, "runs.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
    state: read,
    set: (next) => writeFileSync(file, JSON.stringify({ ...read(), ...next })),
  };
};
