import { probeContainment, type CommandAnswer, type ContainmentProbe, type ProbeSystem } from "../src/permissions/containment-probe.js";

/**
 * Scripted containment probes for the environment's tests: each is what the
 * real probe (`containment-probe.ts`) finds on a scripted machine, so a test
 * starts an environment on a probe result the probe itself can produce, and
 * the real machine is never probed.
 */

interface Machine {
  readonly platform?: NodeJS.Platform;
  readonly path: readonly string[];
  readonly answer?: (file: string, args: readonly string[]) => CommandAnswer;
  readonly files?: Record<string, string>;
}

const scripted = (machine: Machine): ProbeSystem => ({
  platform: machine.platform ?? "linux",
  env: {},
  which: (name) => (machine.path.includes(name) ? `/usr/bin/${name}` : null),
  run: async (file, args) => machine.answer?.(file, args) ?? { code: 0, output: "" },
  exists: (path) => machine.files?.[path] !== undefined,
  read: (path) => machine.files?.[path],
});

const probe = (machine: Machine): Promise<ContainmentProbe> => probeContainment(scripted(machine));

/** bubblewrap and socat present and working: both workspace levels. */
export const bubblewrapProbe = (): Promise<ContainmentProbe> => probe({ path: ["bwrap", "socat"] });

/** bubblewrap works but cannot unshare the network: `workspace` only. */
export const workspaceOnlyProbe = (): Promise<ContainmentProbe> =>
  probe({
    path: ["bwrap", "socat"],
    answer: (_file, args) => (args.includes("--unshare-net") ? { code: 1, output: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" } : { code: 0, output: "" }),
  });

/** bubblewrap missing: nothing above `off`. */
export const absentProbe = (): Promise<ContainmentProbe> => probe({ path: ["socat"] });

/** bubblewrap present but refused a user namespace by a container's seccomp profile: nothing above `off`. */
export const brokenProbe = (): Promise<ContainmentProbe> =>
  probe({
    path: ["bwrap", "socat"],
    answer: () => ({ code: 1, output: "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces." }),
    files: { "/.dockerenv": "", "/proc/self/status": "Seccomp:\t2\n" },
  });
