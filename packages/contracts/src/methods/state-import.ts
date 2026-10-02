import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { StateImportDetection, StateImportReport } from "../state-import.js";

/**
 * The state import's methods (setup spec, "2. Carry over" and "Wire
 * summary"; ADR 0036). `stateImport.detect` looks for a source data folder
 * and a terminal-client state folder on the environment's machine (#581).
 * `stateImport.run` is the switch-over build's (#94, served since #1165): an
 * environment that serves it offers the `stateImport` flag, and the Carry
 * over card shows its state-import section only with the flag and a source
 * detected.
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
 * in milestone 2, not carried), what failed, and the client-local values,
 * which only this answer carries. `dryRun` answers the same report from the
 * same plan and writes nothing but the receipt. With no source data folder
 * or terminal-client state folder found it is `conflict` (reason
 * `no_source`); while an import or a dry run is under way on the
 * environment, `conflict` (reason `import_in_progress`).
 *
 * A prepared command: the stores are read first, outside any transaction,
 * and the plan made from them; an import appends `state-import.started`,
 * then carries each item in a command of its own, one after another, each
 * committing its owner's events with its `state-import.item-carried`, and
 * then, in this command's transaction, the notice. An item carried before
 * a later one failed stays carried; a re-run, under a fresh command id,
 * leaves carried items alone and tries again what failed. The same command
 * id sent again is answered from its receipt.
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
