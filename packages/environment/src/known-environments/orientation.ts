import type { ListedEnvironment } from "@agent-harness/contracts";
import type { OrientationSection } from "../instructions/orientation.js";

/**
 * The orientation block's last section, other environments (key-managers
 * spec, "The orientation block"; ADR 0011; #382): the union of what the
 * client sessions report of their other connections, each environment by
 * its name and the address a client uses for it, so a run can say where
 * else work can run. It renders from the union alone, which is sorted, so it
 * reads the same whichever client reported last; with nothing reported it is
 * left out.
 */

export interface OtherEnvironmentsSectionOptions {
  /** The known environments' union as it is now (`KnownEnvironments.union`). */
  readonly union: () => readonly ListedEnvironment[];
}

/** The list's heading: what the lines are and what they are for. */
const HEADING = "Other environments the user's clients connect to, where work can run too, each with the address a client uses to reach it:";

export const otherEnvironmentsSection = (options: OtherEnvironmentsSectionOptions): OrientationSection => ({
  name: "other-environments",
  title: "Other environments",
  render: () => [{ heading: HEADING, items: options.union().map(({ name, address }) => `${name} at ${address}.`) }],
});
