import { z } from "zod";

/**
 * Forge origins, slugs and variable names (forge spec, "The forge account
 * record"; ADR 0012, ADR 0020): the kind, the origin rules, the remote
 * normaliser and the matching rule, the slug and variable derivations, the
 * git username, the API base and the pull-request URL parsers, all pure, so
 * a client in another language derives exactly the names the environment
 * does. The ForgeService, its record and its methods build on them.
 */

/**
 * The forge kinds. `gitlab` is reserved for milestone 2 (ADR 0033): nothing
 * produces it in milestone 1, but a record may carry it later without a new
 * schema.
 */
export const FORGE_KINDS = ["github", "forgejo", "gitea", "gitlab"] as const;
export const ForgeKind = z.enum(FORGE_KINDS).meta({
  description:
    "The kind of forge a forge account is on: github (github.com or an Enterprise origin), forgejo or gitea; gitlab is reserved for milestone 2 and produced by nothing before it.",
});
export type ForgeKind = z.infer<typeof ForgeKind>;
