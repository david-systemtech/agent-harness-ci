import { z } from "zod";
import { ForgeTokenKind } from "./forge-accounts.js";
import { GhLogin } from "./forge.js";

/**
 * The environment's own `gh` (forge spec, "Credentials"; ADR 0026, ADR
 * 0032): a Managed tools row whose token a forge account's `gh` credential
 * source reads per operation, and what `forge.gh.probe` answers of it.
 */

/**
 * The oldest `gh` a `gh` credential source runs: 2.40.0, the first whose
 * `gh auth token` takes `--user`, so the token read is the recorded login's
 * rather than whichever account is active on the host.
 */
export const GH_MINIMUM_VERSION = "2.40.0";

/** One account `gh auth status` reports signed in, with a token it could use. */
export const GhSignedInAccount = z
  .object({
    host: z.string().min(1).meta({ description: "The host gh is signed in to, as gh names it: github.com, or an Enterprise host." }),
    login: GhLogin,
    active: z.boolean().meta({ description: "Whether it is the host's active account, the one gh uses when no account is named." }),
    tokenKind: ForgeTokenKind.meta({ description: "The token's kind by its prefix: classic (ghp_), fine-grained (github_pat_), oauth (gho_, what gh auth login mints) or unknown." }),
    scopes: z
      .array(z.string().min(1))
      .nullable()
      .meta({
        description:
          "The scopes gh reports for the token, a hint only: empty when gh's token scopes line says none (a classic or OAuth token granted no scope); null when gh prints no token scopes line at all, as for a fine-grained token, whose permissions are not scopes.",
      }),
  })
  .meta({ description: "An account gh is signed in as on a host: its login, whether it is active, and its token's kind and scopes. Never the token." });
export type GhSignedInAccount = z.infer<typeof GhSignedInAccount>;

/** What `forge.gh.probe` answers: whether `gh` is here, its version against the minimum, and who it is signed in as. */
export const GhProbe = z
  .object({
    installed: z.boolean().meta({ description: "Whether gh is on the environment's PATH and runs." }),
    version: z.string().min(1).nullable().meta({ description: "The version gh reports, as 2.63.2; null when it is not installed or its version could not be read." }),
    minimum: z.string().min(1).meta({ description: `The oldest gh a gh credential source runs: ${GH_MINIMUM_VERSION}.` }),
    meetsMinimum: z.boolean().meta({ description: "Whether the version is the minimum or later; false when gh is not installed or its version could not be read." }),
    accounts: z.array(GhSignedInAccount).meta({ description: "Every account gh auth status reports signed in with a token it could use, host by host, in gh's order; empty when gh is not installed." }),
  })
  .meta({ description: "The environment's gh: whether it is installed, its version against the minimum, and per signed-in host the login, whether it is active, and its token's kind and scopes." });
export type GhProbe = z.infer<typeof GhProbe>;
