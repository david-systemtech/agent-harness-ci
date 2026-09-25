import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ContainmentContainer, ContainmentMechanism } from "@agent-harness/contracts";
import { processContainerDetector } from "../serve/container.js";

/**
 * The containment prober (permissions spec, "Mechanisms and the probe";
 * ADR 0006): what this environment can enforce, found once at startup. On
 * macOS, Seatbelt: `sandbox-exec` runs a trivial command under a profile
 * that denies the network. On Linux and WSL2, bubblewrap: `bwrap` on the
 * PATH runs a trivial command in an unshared user namespace with a read-only
 * root, and again with the network unshared, and `socat` is on the PATH,
 * which Claude's sandbox needs beside it on Linux for its network proxy.
 * Native Windows, and any other platform, has none.
 *
 * When bubblewrap cannot work, the probe says why, for people and as a
 * cause: the binary missing, user namespaces blocked by the kernel,
 * AppArmor's restriction (Ubuntu 24.04), a seccomp profile (Docker's default
 * one), `socat` missing, or bwrap's own message. A container is reported as
 * the operator's outer boundary and enforces no level: inside one the
 * workspace levels need bubblewrap to work there, like anywhere else.
 *
 * The machine is a seam (`ProbeSystem`), so every outcome is a scripted
 * test and the real machine is probed only by the running environment.
 */

/** The variable the install's compose sets to declare the environment runs in a container. */
export const CONTAINER_MARKER_VARIABLE = "AGENT_HARNESS_CONTAINER";

/** Why a workspace level cannot be enforced. */
export type ProbeCause = "platform" | "binary_missing" | "userns_blocked" | "apparmor" | "seccomp" | "socat_missing" | "failed";

/** One workspace level as the probe found it. */
export type LevelProbe =
  | { readonly available: true; readonly reason: null; readonly cause: null }
  | { readonly available: false; readonly reason: string; readonly cause: ProbeCause };

/** What the probe found: each workspace level, the mechanism that enforces them (null when neither can be), the container. */
export interface ContainmentProbe {
  readonly mechanism: ContainmentMechanism | null;
  readonly levels: { readonly workspace: LevelProbe; readonly "workspace-no-network": LevelProbe };
  readonly container: ContainmentContainer;
}

/** What a command answered: its exit code (null when it could not be started, or was killed) and what it printed. */
export interface CommandAnswer {
  readonly code: number | null;
  readonly output: string;
}

/** The machine as the probe reads it. */
export interface ProbeSystem {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The command's path on the PATH; null when it is not there. */
  which(command: string): string | null;
  /** Runs `file` with `args`; never rejects: a command that cannot start answers a null code and the error. */
  run(file: string, args: readonly string[]): Promise<CommandAnswer>;
  exists(path: string): boolean;
  /** The file's text; undefined when it cannot be read. */
  read(path: string): string | undefined;
}

/** How long one probe command may take before it counts as failed. */
export const PROBE_COMMAND_TIMEOUT_MS = 5_000;

const AVAILABLE: LevelProbe = { available: true, reason: null, cause: null };

const unavailable = (cause: ProbeCause, reason: string): LevelProbe => ({ available: false, reason, cause });

/** A problem the probe found, with its cause. */
interface Problem {
  readonly cause: ProbeCause;
  readonly reason: string;
}

/** The first line a command printed, for a reason. */
const said = (answer: CommandAnswer): string => {
  const line = answer.output.split("\n").find((text) => text.trim() !== "")?.trim();
  return line === undefined ? `it exited with ${answer.code === null ? "no code" : `code ${answer.code}`}` : `it said: ${line}`;
};

/** The preset: the running process's machine. */
export const processProbeSystem = (): ProbeSystem => ({
  platform: process.platform,
  env: process.env,
  which: (command) => {
    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
      if (directory === "" || !isAbsolute(directory)) continue;
      const candidate = join(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; the next directory.
      }
    }
    return null;
  },
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, [...args], { timeout: PROBE_COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        const output = `${stderr}${stdout}`;
        if (error === null) return resolve({ code: 0, output });
        const code = typeof error.code === "number" ? error.code : null;
        resolve({ code, output: output.trim() === "" ? error.message : output });
      });
    }),
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
});

const containerOf = (system: ProbeSystem): ContainmentContainer => ({
  declared: (system.env[CONTAINER_MARKER_VARIABLE] ?? "").trim() !== "",
  detected: processContainerDetector({ exists: (path) => system.exists(path), read: (path) => system.read(path) }).inContainer(),
});

const inContainer = (container: ContainmentContainer): boolean => container.declared || container.detected;

/**
 * Why a user namespace could not be made here, read from the kernel's
 * files: the kernel's own switches first, then AppArmor's restriction, then
 * a seccomp filter on this process, else what the command said.
 */
const namespaceProblem = (system: ProbeSystem, container: ContainmentContainer, answer: CommandAnswer, what: string): Problem => {
  const setting = (path: string): string | undefined => system.read(path)?.trim();
  const detail = ` (${said(answer)})`;
  if (setting("/proc/sys/kernel/unprivileged_userns_clone") === "0" || setting("/proc/sys/user/max_user_namespaces") === "0") {
    return {
      cause: "userns_blocked",
      reason: `${what}: the kernel does not allow unprivileged user namespaces (kernel.unprivileged_userns_clone or user.max_user_namespaces is 0)${detail}.`,
    };
  }
  if (setting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
    return {
      cause: "apparmor",
      reason: `${what}: AppArmor restricts unprivileged user namespaces here (kernel.apparmor_restrict_unprivileged_userns is 1, as on Ubuntu 24.04), so bwrap needs an AppArmor profile that allows them${detail}.`,
    };
  }
  if (/^Seccomp:\s*2\s*$/m.test(system.read("/proc/self/status") ?? "")) {
    const whose = inContainer(container) ? "the container's seccomp profile (Docker's default one does)" : "a seccomp filter on this process";
    return { cause: "seccomp", reason: `${what}: ${whose} refuses to create user namespaces${detail}.` };
  }
  return { cause: "failed", reason: `${what}: ${said(answer)}.` };
};

const BWRAP_TRIVIAL = ["--unshare-user", "--ro-bind", "/", "/", "--", "true"] as const;
const BWRAP_NO_NETWORK = ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--", "true"] as const;

const SOCAT_MISSING: Problem = {
  cause: "socat_missing",
  reason: "socat is not installed: Claude's sandbox needs it beside bubblewrap on Linux for its network proxy, at either workspace level. Install the socat package.",
};

const probeLinux = async (system: ProbeSystem, container: ContainmentContainer): Promise<Omit<ContainmentProbe, "container">> => {
  const problems: Problem[] = [];
  const bwrap = system.which("bwrap");
  if (bwrap === null) {
    let reason = "bubblewrap is not installed: bwrap is not on the PATH. Install the bubblewrap package.";
    // Whether installing it would be enough: `unshare` makes the same user namespace bwrap would.
    const unshare = system.which("unshare");
    if (unshare !== null) {
      const answer = await system.run(unshare, ["--user", "--map-root-user", "true"]);
      if (answer.code !== 0) reason += ` Installing it would not be enough here: ${namespaceProblem(system, container, answer, "user namespaces are refused").reason}`;
    }
    problems.push({ cause: "binary_missing", reason });
  } else {
    const answer = await system.run(bwrap, BWRAP_TRIVIAL);
    if (answer.code !== 0) problems.push(namespaceProblem(system, container, answer, "bubblewrap could not run a command in an unshared user namespace with a read-only root"));
  }
  if (system.which("socat") === null) problems.push(SOCAT_MISSING);
  const [first] = problems;
  if (bwrap === null || first !== undefined) {
    const outer = inContainer(container)
      ? " This environment runs in a container, the operator's outer boundary, which enforces no containment level by itself: the workspace levels need bubblewrap to work inside it."
      : "";
    const level = unavailable(first?.cause ?? "binary_missing", `${problems.map((problem) => problem.reason).join(" ")}${outer}`);
    return { mechanism: null, levels: { workspace: level, "workspace-no-network": level } };
  }
  const network = await system.run(bwrap, BWRAP_NO_NETWORK);
  const noNetwork =
    network.code === 0
      ? AVAILABLE
      : unavailable(
          "failed",
          `bubblewrap cannot give a run a network namespace of its own here, so no network cannot be enforced: ${said(network)}.`,
        );
  return { mechanism: "bubblewrap", levels: { workspace: AVAILABLE, "workspace-no-network": noNetwork } };
};

const SEATBELT_PROFILE = "(version 1)(allow default)(deny network*)";

const probeMac = async (system: ProbeSystem): Promise<Omit<ContainmentProbe, "container">> => {
  const executable = system.which("sandbox-exec") ?? (system.exists("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (executable === null) {
    const level = unavailable("binary_missing", "Seatbelt's sandbox-exec is not on this Mac, so no workspace level can be enforced.");
    return { mechanism: null, levels: { workspace: level, "workspace-no-network": level } };
  }
  const answer = await system.run(executable, ["-p", SEATBELT_PROFILE, "/usr/bin/true"]);
  if (answer.code !== 0) {
    const level = unavailable("failed", `Seatbelt could not run a command under a profile that denies the network: ${said(answer)}.`);
    return { mechanism: null, levels: { workspace: level, "workspace-no-network": level } };
  }
  return { mechanism: "seatbelt", levels: { workspace: AVAILABLE, "workspace-no-network": AVAILABLE } };
};

const noMechanism = (reason: string): Omit<ContainmentProbe, "container"> => {
  const level = unavailable("platform", reason);
  return { mechanism: null, levels: { workspace: level, "workspace-no-network": level } };
};

/** Probes the machine for what it can enforce. Never rejects: whatever fails is a reason. */
export const probeContainment = async (system: ProbeSystem = processProbeSystem()): Promise<ContainmentProbe> => {
  const container = containerOf(system);
  switch (system.platform) {
    case "linux":
      return { ...(await probeLinux(system, container)), container };
    case "darwin":
      return { ...(await probeMac(system)), container };
    case "win32":
      return {
        ...noMechanism("Native Windows has no containment mechanism the harness can use: run the environment in WSL2, where bubblewrap enforces the workspace levels."),
        container,
      };
    default:
      return {
        ...noMechanism(`${system.platform} has no containment mechanism the harness supports (Seatbelt on macOS, bubblewrap on Linux and WSL2).`),
        container,
      };
  }
};
