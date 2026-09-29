import type { ContainmentLevel } from "@agent-harness/contracts";
import type { OrientationSection } from "./orientation.js";

/**
 * The orientation block's first section, this environment (key-managers
 * spec, "The orientation block"; ADR 0011; #380): its name, its operating
 * system and architecture, the OS user it runs as, and the run's
 * containment level with one line on what it means (permissions spec,
 * "Containment"). Each is state: the name as it is now, the machine's facts
 * read once at start, and the level the run's policy resolved.
 */

export interface EnvironmentSectionOptions {
  /** The environment's name as it is now: a rename shows in the next run's text. */
  readonly name: () => string;
  /** The operating system, as Node names it: `linux`, `darwin`, `win32`. */
  readonly platform: NodeJS.Platform;
  /** The architecture, as Node names it: `x64`, `arm64`. */
  readonly arch: string;
  /** The OS user the environment runs as; undefined for a uid with no name (a container's arbitrary user). */
  readonly user: string | undefined;
}

/** The operating systems whose names people write otherwise than Node does. */
const SYSTEM_NAMES: Partial<Readonly<Record<NodeJS.Platform, string>>> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** What each containment level means for a run's commands and tools (permissions spec, "Containment"). */
const CONTAINMENT_MEANS: Readonly<Record<ContainmentLevel, string>> = {
  off: "nothing but the denylist limits what its commands and tools read, write or reach",
  workspace:
    "it reads anywhere but the denylisted paths, writes only in its workspace, its session's scratch directory and its temporary directory, and reaches the network",
  "workspace-no-network":
    "it reads anywhere but the denylisted paths, writes only in its workspace, its session's scratch directory and its temporary directory, and its commands, fetches and searches reach no host",
};

export const environmentSection = (options: EnvironmentSectionOptions): OrientationSection => {
  const system = SYSTEM_NAMES[options.platform] ?? options.platform;
  const user = options.user === undefined ? "as an OS user with no name here" : `as the OS user ${options.user}`;
  return {
    name: "environment",
    title: "This environment",
    render: ({ containment }) => [
      `This environment is ${options.name()}, on ${system} (${options.arch}), ${user}.`,
      `This run's containment is ${containment}: ${CONTAINMENT_MEANS[containment]}.`,
    ],
  };
};
