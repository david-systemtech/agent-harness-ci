import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { StateImportDetection, StateImportReport } from "../state-import.js";

/**
 * The state import's methods (setup spec, "2. Carry over" and "Wire
 * summary"; ADR 0036). `stateImport.detect` looks for a source data folder
 * and a terminal-client state folder on the environment's machine (#581).
 * `stateImport.run` is the switch-over build's (#94): until it lands, the
 * environment serves no handler for it (`not_found`) and offers no
 * `stateImport` flag, and the Carry over card shows no state-import section.
 */

/**
 * Whether a source data folder or a terminal-client state folder is on the
 * environment's machine, and what the data folder holds by kind: profiles,
 * banks, routines, instructions, skill sources and connections. Reads the
 * folders and writes nothing.
 */
export const stateImportDetect = defineMethod({
  name: "stateImport.detect",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: StateImportDetection,
  errors: [],
});

/**
 * Imports what the source data folder and its terminal client's state
 * folder hold: the listed config directories adopted first, so their Carry
 * over cards appear, then each kind written through the service that owns
 * it with origin `import`, deduplicated by source ids, ending with
 * `state-import.finished` on the environment stream as the caller, which is
 * also the notice of that name. Answers the report's four groups (carried
 * with counts per kind, re-enter each with the step that takes it, arriving
 * in milestone 2, not carried), what failed, and the client-local values.
 * `dryRun` answers the same report and writes nothing. With no source data
 * folder or terminal-client state folder found it is `conflict` (reason
 * `no_source`); while an import is under way, `conflict` (reason
 * `import_in_progress`). A prepared command: the folders are read first,
 * outside the transaction.
 */
export const stateImportRun = defineMethod({
  name: "stateImport.run",
  scope: "admin",
  kind: "command",
  params: commandParams({
    dryRun: z.boolean().meta({ description: "Answer the report of what an import would do, and write nothing." }),
  }),
  result: StateImportReport,
  errors: [],
});
