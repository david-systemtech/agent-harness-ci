import { z } from "zod";
import { EnvironmentColour } from "./environment-colours.js";
import { normaliseTrimmedName, trimmedNamePattern } from "./primitives.js";

/**
 * An environment's name, icon and colour (workspace-picker spec, "Name,
 * icon and colour"; ADR 0005, ADR 0025): stored on the environment, so
 * every client draws the same badge for it, and set by one `admin` command
 * per field. The colour is `EnvironmentColour`, a name and never a literal.
 */

/** The most characters, counted as code points, a name set by `environment.rename` holds once trimmed. */
export const ENVIRONMENT_NAME_MAX = 40;

/**
 * A name `environment.rename` takes: 1 to 40 characters once trimmed, with
 * no control or format character but white space (a group's name's rule),
 * kept trimmed with its white space collapsed.
 */
export const EnvironmentName = z
  .string()
  .regex(trimmedNamePattern(ENVIRONMENT_NAME_MAX))
  .meta({
    description: `An environment's name as environment.rename takes it: 1 to ${ENVIRONMENT_NAME_MAX} characters once trimmed, counted as code points, no control or format (zero-width) characters other than white space; kept trimmed with white space collapsed.`,
  });
export type EnvironmentName = z.infer<typeof EnvironmentName>;

/** A name as the environment keeps it: trimmed, every run of white space one space. */
export const normaliseEnvironmentName = normaliseTrimmedName;

/** The icons an environment may take (ADR 0025's fixed set): a client draws each its own way, and the terminal UI draws none. */
export const ENVIRONMENT_ICONS = ["laptop", "desktop", "server", "nas", "cloud", "container", "board", "home", "office", "lab"] as const;
export const EnvironmentIcon = z.enum(ENVIRONMENT_ICONS).meta({
  description:
    "An environment's icon, by name, one of the ten the enum lists (ADR 0025's fixed set): each client draws the name its own way, and the terminal UI draws none.",
});
export type EnvironmentIcon = z.infer<typeof EnvironmentIcon>;

/**
 * What every client draws an environment's badge from, as the environment
 * holds it now: the three commands' values over the record's name and the
 * defaults. The name is any the record holds, which a name the environment
 * was created with (a hostname's label, a `--name`) may make longer than a
 * rename takes.
 */
export const EnvironmentLook = z
  .object({
    name: z.string().min(1).meta({ description: "The environment's name." }),
    icon: EnvironmentIcon,
    colour: EnvironmentColour,
  })
  .meta({ description: "An environment's name, icon and colour, as it holds them now: what every client draws its badge from." });
export type EnvironmentLook = z.infer<typeof EnvironmentLook>;

/** What `environment.renamed` records: the name as kept, trimmed and collapsed. */
export const EnvironmentRenamedPayload = z
  .object({ name: EnvironmentName })
  .meta({ description: "The environment's new name, trimmed with its white space collapsed." });
export type EnvironmentRenamedPayload = z.infer<typeof EnvironmentRenamedPayload>;

/** What `environment.icon-set` records. */
export const EnvironmentIconSetPayload = z.object({ icon: EnvironmentIcon }).meta({ description: "The environment's new icon." });
export type EnvironmentIconSetPayload = z.infer<typeof EnvironmentIconSetPayload>;

/** What `environment.colour-set` records. */
export const EnvironmentColourSetPayload = z.object({ colour: EnvironmentColour }).meta({ description: "The environment's new colour." });
export type EnvironmentColourSetPayload = z.infer<typeof EnvironmentColourSetPayload>;
