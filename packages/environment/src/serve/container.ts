import { existsSync, readFileSync } from "node:fs";

/**
 * Whether the environment runs in a container. In a container with no
 * launcher (the launcher channel says whether one is present) its updates are
 * managed outside: it never updates itself, and a host-side updater
 * recreates it (ADR 0007).
 */
export interface ContainerDetector {
  inContainer(): boolean;
}

/** Files only a container runtime writes: Docker's, and Podman's. */
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"] as const;
/** PID 1's cgroup path under a container runtime: a fallback where no marker file is written (cgroup v1, and v2 under Kubernetes). */
const CONTAINER_CGROUP = /docker|containerd|kubepods|libpod|lxc/;

/** What the preset detector reads. */
export interface ContainerProbe {
  exists(path: string): boolean;
  /** The file's text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
  /** The process's variables, for the declared marker; preset: none. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The variable the install's compose sets, non-empty, to declare the environment runs in a container (#133). */
export const CONTAINER_MARKER_VARIABLE = "AGENT_HARNESS_CONTAINER";

/** Whether the install declared a container: the marker variable set to anything but blank. */
export const isDeclaredContainer = (env: Readonly<Record<string, string | undefined>>): boolean => (env[CONTAINER_MARKER_VARIABLE] ?? "").trim() !== "";

/** Whether a container runtime left its trace: its marker file, else PID 1 in its cgroup. */
export const isDetectedContainer = (probe: Pick<ContainerProbe, "exists" | "read">): boolean =>
  CONTAINER_MARKERS.some((path) => probe.exists(path)) || CONTAINER_CGROUP.test(probe.read("/proc/1/cgroup") ?? "");

const fileProbe: ContainerProbe = {
  env: process.env,
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * The preset detector: a container is one the install declared
 * (`AGENT_HARNESS_CONTAINER`), or whose runtime left its marker file, or
 * else whose PID 1 sits in a container runtime's cgroup; the containment
 * probe reads the same rule and reports the two apart. A heuristic: it
 * reports only who manages updates and what the outer boundary is, and
 * lifts no refusal.
 */
export const processContainerDetector = (probe: ContainerProbe = fileProbe): ContainerDetector => ({
  inContainer: () => isDeclaredContainer(probe.env ?? {}) || isDetectedContainer(probe),
});
