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

/** What the preset detector reads. */
export interface ContainerProbe {
  exists(path: string): boolean;
  /** The file's text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
}

/** Files only a container runtime writes: Docker's, and Podman's. */
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"] as const;
/** PID 1's cgroup path under a container runtime: a fallback where no marker file is written (cgroup v1, and v2 under Kubernetes). */
const CONTAINER_CGROUP = /docker|containerd|kubepods|libpod|lxc/;

const fileProbe: ContainerProbe = {
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
 * The preset detector: a container is one whose runtime left its marker
 * file, or else whose PID 1 sits in a container runtime's cgroup. A
 * heuristic: it reports only who manages updates, and lifts no refusal.
 */
export const processContainerDetector = (probe: ContainerProbe = fileProbe): ContainerDetector => ({
  inContainer: () => CONTAINER_MARKERS.some((path) => probe.exists(path)) || CONTAINER_CGROUP.test(probe.read("/proc/1/cgroup") ?? ""),
});
