import { z } from "zod";
import { setOf } from "./primitives.js";

/**
 * What a client session may do. Every method requires exactly one; the
 * environment checks it in one place, before the handler, for requests and
 * streams alike.
 *
 * - `read`: list and subscribe.
 * - `sessions:write`: organisation commands.
 * - `runs:drive`: start, send, interrupt, answer prompts.
 * - `terminal`: terminals, files and diffs.
 * - `admin`: pairings, client sessions, drain, rebuild, settings.
 */
export const SCOPES = ["read", "sessions:write", "runs:drive", "terminal", "admin"] as const;
export const Scope = z.enum(SCOPES).meta({
  description:
    "One of the five scopes a method may require: read (list and subscribe), sessions:write (organisation commands), runs:drive (start, send, interrupt, answer prompts), terminal (terminals, files and diffs), admin (pairings, client sessions, drain, rebuild, settings).",
});
export type Scope = z.infer<typeof Scope>;

/** The scopes a client session holds: chosen at pairing, never empty. */
export const ScopeSet = setOf(Scope)
  .min(1)
  .meta({ description: "The scopes a client session holds, as a non-empty set." });
export type ScopeSet = z.infer<typeof ScopeSet>;

/**
 * The highest mode a client session, and anything created through it, may
 * use; set at pairing. Its values belong to the permissions workstream, so
 * until they are fixed it is any non-empty name, branded so that a plain
 * string is not mistaken for one.
 */
export const Ceiling = z
  .string()
  .min(1)
  .brand<"Ceiling">()
  .meta({ description: "The highest mode a client session may use; its values are the permissions workstream's." });
export type Ceiling = z.infer<typeof Ceiling>;
