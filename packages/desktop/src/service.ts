import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { ServiceFailureError, type ServiceFailureKind, type ShellPlatform, type ShellService } from "@agent-harness/client-runtime";
import { PRODUCT_NAME, PendingUpdate } from "@agent-harness/contracts";
import { ARTEFACT_CLI_ENTRY, artefactNode, RELEASE_VERSION_PATTERN } from "@agent-harness/contracts/launcher";
import { oneAtATime } from "./commands.js";

/**
 * The shell's `service` (docs/specs/gui.md, "The desktop shell"): this
 * machine's environment's service, through the `service` verbs of the
 * server artefact the desktop carries, run with the artefact's own Node
 * (launcher-update spec, "Versions and the launcher"). `service install` run
 * from the artefact copies it into the environment's versions directory
 * before it writes the service's definition, so the service never runs from
 * inside the app's bundle or install directory.
 *
 * `start` installs the service when none is installed, starts it when it is
 * not running, and settles once the environment answers discovery (starting
 * or ready), so the runtime's reconnect after it finds the environment
 * there. The verbs run one at a time: a start asked while another runs waits
 * for it, and finds the service running. Each failure is a
 * `ServiceFailureError`, its kind beside the text (setup-copy.md §4.1).
 */

/** How often `start` asks whether the environment answers, and for how long. */
export interface ServiceWait {
  readonly everyMs: number;
  readonly forMs: number;
}

/** A second between looks, and a minute in all, as the terminal UI waits (chosen defaults). */
export const SERVICE_WAIT: ServiceWait = { everyMs: 1000, forMs: 60_000 };

export interface ServiceParts {
  readonly os: ShellPlatform;
  readonly environmentDir: string;
  /** The unpacked server artefact; absent where the desktop carries none. */
  readonly server: string | undefined;
  readonly wait?: ServiceWait;
}

/** What `service status --json` prints, the parts the desktop reads. */
interface StatusReport {
  readonly installed: boolean;
  readonly running: boolean;
  /** What discovery answered on the service's port; null when nothing answered. */
  readonly readiness: string | null;
  readonly ready: boolean;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const isStatusReport = (value: unknown): value is StatusReport => {
  const report = value as Partial<StatusReport> | null;
  return (
    typeof report === "object" &&
    report !== null &&
    typeof report.installed === "boolean" &&
    typeof report.running === "boolean" &&
    typeof report.ready === "boolean" &&
    (report.readiness === null || typeof report.readiness === "string")
  );
};

/** Node prints a source excerpt before its error and a runtime version after the stack. */
const firstErrorLine = (text: string): string | undefined => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.find((line) => /^\w*Error(?: \[[^\]]+\])?:/.test(line)) ?? lines[0];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const bundledService = ({ os, server, environmentDir, wait = SERVICE_WAIT }: ServiceParts): ShellService => {
  const run = (args: readonly string[]): Promise<Ran> =>
    new Promise((resolve, reject) => {
      if (server === undefined) {
        reject(new ServiceFailureError("no-artefact", `This desktop carries no server artefact, so it cannot install or start the environment on this machine: \`${PRODUCT_NAME} service start\` does.`));
        return;
      }
      const node = join(server, ...artefactNode(os));
      execFile(node, [join(server, ...ARTEFACT_CLI_ENTRY), "service", ...args], { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(new ServiceFailureError("unrunnable", `The server artefact this desktop carries could not be run (${node}): ${error.message}`));
      });
    });

  /** Runs a verb that answers nothing, rejecting as `kind` with the CLI's own sentence, after `what`, when it fails. */
  const verb = async (args: readonly string[], kind: ServiceFailureKind, what: string): Promise<void> => {
    const ran = await run(args);
    if (ran.code !== 0) throw new ServiceFailureError(kind, `${what}${firstErrorLine(ran.stderr) ?? firstErrorLine(ran.stdout) ?? `\`service ${args.join(" ")}\` exited with ${ran.code}.`}`);
  };

  const status = async (): Promise<StatusReport> => {
    const ran = await run(["status", "--json"]);
    let report: unknown;
    try {
      report = JSON.parse(ran.stdout);
    } catch {
      report = undefined;
    }
    if (!isStatusReport(report)) throw new ServiceFailureError("status", `Could not read the service's status: ${firstErrorLine(ran.stderr) ?? `\`service status\` exited with ${ran.code}.`}`);
    return report;
  };

  const install = () => verb(["install"], "install", "Could not install the environment on this machine: ");

  const start = async (): Promise<void> => {
    const before = await status();
    if (!before.installed) await install();
    if (!before.running) await verb(["start"], "start", before.installed ? "Could not start the environment on this machine: " : "Installed, but starting it failed: ");
    if (before.readiness !== null) return;
    const since = Date.now();
    while ((await status()).readiness === null) {
      if (Date.now() - since >= wait.forMs) {
        throw new ServiceFailureError("no-answer", `The environment on this machine did not answer after it was started: \`${PRODUCT_NAME} service status\` says why.`);
      }
      await sleep(wait.everyMs);
    }
  };

  /** One verb at a time, each after the one before has settled either way. */
  const inTurn = oneAtATime();

  // The installed CLI speaks the running environment's protocol, even
  // when the desktop's bundled CLI is newer. Resolve it afresh on each call.
  const runInstalled = async (args: readonly string[]): Promise<string> => {
    const state = JSON.parse(await readFile(join(environmentDir, "service-state.json"), "utf8")) as { activeVersion?: unknown };
    const version = state.activeVersion;
    if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) throw new Error("The service state names no active version.");
    const root = join(environmentDir, "versions", version);
    await access(join(root, ".complete"));
    return new Promise((resolve, reject) => {
      execFile(join(root, ...artefactNode(os)), [join(root, ...ARTEFACT_CLI_ENTRY), "update", ...args, "--data-dir", environmentDir],
        { windowsHide: true, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
          if (error === null) resolve(stdout);
          else reject(new Error(`Could not update the local environment: ${firstErrorLine(stderr) ?? firstErrorLine(stdout) ?? error.message}`));
        });
    });
  };

  return {
    pendingUpdate: () => inTurn(async () => {
      const report = JSON.parse(await runInstalled(["status", "--json"])) as { pending?: unknown };
      return PendingUpdate.parse(report.pending);
    }),
    applyUpdateNow: () => inTurn(async () => { await runInstalled(["apply", "--now"]); }),
    install: () => inTurn(install),
    start: () => inTurn(start),
    status: () => inTurn(async () => {
      const { installed, running, ready } = await status();
      return { installed, running, ready };
    }),
  };
};
