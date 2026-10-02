import { z } from "zod";
import { EnvironmentId, trimmedNamePattern } from "./primitives.js";

/**
 * The known environments (key-managers spec, "The orientation block"; ADR
 * 0011; #382): what client sessions report of their other connections
 * through `environment.knownEnvironments.report` (a desktop's and a terminal
 * UI's runtime do; a program is refused), whose union, never this
 * environment, the orientation block's other environments section lists by
 * name and by the address the client uses, so a run can say where else work
 * can run. No environment connects to another: this is what the clients
 * know, not a peer list.
 */

/** The most characters, counted as code points, a known environment's name holds once trimmed. */
export const KNOWN_ENVIRONMENT_NAME_MAX = 200;

/** The most environments one report holds. */
export const KNOWN_ENVIRONMENTS_MAX = 100;

/**
 * An http or https origin, as a connection keeps its address: no white space,
 * path, query, fragment or credentials, no backslash (a URL parser reads it as
 * a path separator) and no control or format (zero-width, bidi) character.
 */
const ORIGIN = /^https?:\/\/[^\s/\\?#@\p{Cc}\p{Cf}]+$/u;

/** A known environment's name: one line once white space is collapsed, no control or format character. */
const KnownEnvironmentName = z
  .string()
  .regex(trimmedNamePattern(KNOWN_ENVIRONMENT_NAME_MAX))
  .meta({
    description: `An environment's name as the client has it: 1 to ${KNOWN_ENVIRONMENT_NAME_MAX} characters once trimmed, counted as code points, no control or format (zero-width) characters other than white space; kept trimmed with white space collapsed.`,
  });

/** The address a client uses for an environment. */
const KnownEnvironmentAddress = z
  .string()
  .max(300)
  .regex(ORIGIN)
  .meta({ description: "The address the client uses for the environment, as its connection keeps it: an http or https origin, http://host:port." });

/** One of a client's other connections, as it reports it. */
export const KnownEnvironment = z
  .object({
    id: EnvironmentId.meta({ description: "The environment's id, from its hello: an environment leaves itself out of the union by it." }),
    name: KnownEnvironmentName,
    address: KnownEnvironmentAddress,
  })
  .meta({ description: "One of the client's other connections: the environment's id, its name as the client has it, and the address the client uses." });
export type KnownEnvironment = z.infer<typeof KnownEnvironment>;

/** One environment of the union, as the orientation block lists it: its name and the address a client uses. */
export const ListedEnvironment = z
  .object({ name: KnownEnvironmentName, address: KnownEnvironmentAddress })
  .meta({ description: "An environment of the union: its name and the address a client uses for it." });
export type ListedEnvironment = z.infer<typeof ListedEnvironment>;

/** What `environment.known-environments-updated` carries: the union as it now is. */
export const KnownEnvironmentsUpdatedPayload = z
  .object({
    environments: z.array(ListedEnvironment).meta({
      description:
        "The union of what the live client sessions report, this environment left out, each name and address once, sorted by name, then address: what the orientation block's other environments section lists.",
    }),
  })
  .meta({ description: "The known environments' union changed: the union as it now is." });
export type KnownEnvironmentsUpdatedPayload = z.infer<typeof KnownEnvironmentsUpdatedPayload>;
