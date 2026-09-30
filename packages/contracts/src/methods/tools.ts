import { z } from "zod";
import { ManagedToolRow, ManagedToolVerification, VerifiableToolName } from "../managed-tools.js";
import { defineMethod } from "../method.js";
import { Timestamp } from "../primitives.js";

/**
 * The Managed tools methods (key-managers spec, "Wire methods"; ADR 0026).
 * `tools.list` reads the registry's rows, which the environment probes: at
 * its start, and on a `refresh` (Set up or About opening) at most every
 * fifteen minutes. A client never probes a tool itself. `tools.verify`
 * runs a tool's verify command on the environment (#375).
 */

/**
 * The managed tools' rows, one per tool in the table's order, as the last
 * probe found them. With `refresh`, a probe runs first unless one began in
 * the last fifteen minutes; either way the answer waits for a probe under
 * way.
 */
export const toolsList = defineMethod({
  name: "tools.list",
  scope: "read",
  kind: "query",
  params: z.object({
    refresh: z.boolean().optional().meta({ description: "Probe first, unless a probe began in the last fifteen minutes: sent when Set up or About opens." }),
  }),
  result: z.object({
    tools: z.array(ManagedToolRow).meta({ description: "One row per managed tool, in the table's order." }),
    probedAt: Timestamp.meta({ description: "When the probe the rows come from began." }),
  }),
  errors: [],
});

/**
 * Runs the tool's verify command on the environment (#375), where its row
 * found it, as a holder like any other: with every service's variables, the
 * key managers' block among them, and a run token minted for it and revoked
 * when it exits; the injection setting, which decides what runs are given,
 * never denies it. `bao` and `vault` run `token lookup` against the
 * injecting OpenBao connection, and on a failure `status`, whose exit 2 is
 * sealed and 1 unreachable; `gh` runs `gh auth status`; the Doppler,
 * 1Password and Bitwarden commands run the same way. A tool its row finds
 * not installed answers `not-installed` and nothing runs; a key-manager CLI
 * with no connection of its provider injecting answers `failed` and nothing
 * runs. Only the fields wanted are read from what the command printed, and
 * its output is never kept.
 */
export const toolsVerify = defineMethod({
  name: "tools.verify",
  scope: "admin",
  kind: "query",
  params: z.object({ tool: VerifiableToolName }),
  result: ManagedToolVerification,
  errors: [],
});
