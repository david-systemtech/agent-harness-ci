import { z } from "zod";
import { Mode } from "./permissions-modes.js";
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
 * use: one of the four modes (`permissions-modes.ts`), set at pairing and
 * changed only by another admin session (permissions spec, "Ceilings").
 */
export const Ceiling = Mode.meta({
  description: "The highest mode a client session, and anything created through it, may use: plan, acceptEdits, auto or bypassPermissions.",
});
export type Ceiling = z.infer<typeof Ceiling>;
