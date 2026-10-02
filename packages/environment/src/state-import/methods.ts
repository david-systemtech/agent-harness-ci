import type { KeyManagerConnections } from "../key-managers/connections.js";
import type { ForgeService } from "../forge/forge-service.js";
import { planCredentials } from "./credentials.js";
import { realpath } from "node:fs/promises";
import { ENVIRONMENT_STREAM_KIND, type StateImportFinishedPayload, type StateImportReport } from "@agent-harness/contracts";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { CommandRejection, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import type { SettingsHandlers } from "../settings/methods.js";
import type { ImportCoordinator } from "./coordinator.js";
import { applyItems, stateImportStream, type ImportItem } from "./items.js";
import { emptyPlan, includeReportStores, itemsOf, planImport, recheckStores, reportOf } from "./plan.js";
import { detectSource, type SourceMachine } from "./source/folders.js";
import { readSourceStores } from "./source/stores.js";
import { readSourceFileFrecency } from "./source/report-stores.js";

/**
 * The state import's methods (setup spec, "2. Carry over"; switch-over spec,
 * "Ownership, contracts and report" and "Preview, application and re-run";
 * ADR 0036): `stateImport.detect` answers whether a source data folder or a
 * terminal-client state folder is on the environment's machine, and what
 * the data folder holds by kind, read by the source reader each time it is
 * asked (#581). `stateImport.run` (#1165) is a prepared command. Its prepare
 * holds the environment's coordinator, reads the stores and plans; a dry run
 * stops there, and its transaction appends nothing. An import looks at the
 * stores again, appends `state-import.started`, and carries each item in a
 * command of its own (`items.ts`); its transaction then appends
 * `state-import.finished`, whatever failed, as the client session that asked,
 * correlated with the import, its payload the report without the
 * client-local values or the dry run. The same command id sent again is
 * answered from the receipt and plans nothing.
 */

/** Seams a test reaches the import through: after the plan, and after each item carried. */
export interface StateImportHooks {
  /** Heard once an import has planned, before it looks at the stores again and applies anything. */
  readonly planned?: () => void | Promise<void>;
  /** Heard after each item an import carried commits: a test stops the import there, as a crash would. */
  readonly carried?: (item: Pick<ImportItem, "kind" | "sourceId">) => void | Promise<void>;
}

export interface StateImportOptions {
  /** The machine the source reader looks at: this process's environment, platform and home. */
  readonly machine: SourceMachine;
  readonly log: EventLog;
  /** The environment's id: the id of its stream and of the state-import stream. */
  readonly environmentId: string;
  /** The environment's one import coordinator. */
  readonly coordinator: ImportCoordinator;
  /** The Instructions service's create command, which carries each instruction. */
  readonly createInstruction: MethodHandler<"instructions.create">;
  readonly forge: ForgeService;
  readonly managers: KeyManagerConnections;
  readonly getSettings: SettingsHandlers["settings.get"];
  readonly updateSettings: SettingsHandlers["settings.update"];
  readonly hooks?: StateImportHooks;
}

/** The report as `state-import.finished` carries it: without what only the client that asked is answered. */
const finishedPayload = ({ carried, reEnter, later, notCarried, failed }: StateImportReport): StateImportFinishedPayload => ({ carried, reEnter, later, notCarried, failed });

export const stateImportMethods = (options: StateImportOptions): MethodHandlers => {
  const { machine, log, coordinator, hooks } = options;
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };

  const detect: MethodHandler<"stateImport.detect"> = () => detectSource(machine);

  const run: PreparedCommand<"stateImport.run"> = {
    prepare: ({ commandId: importId, dryRun }, caller) => {
      const refused =
        (rejected: CommandRejection<"conflict">): MethodHandler<"stateImport.run"> =>
        () => ({ aggregate: environmentStream, rejected });
      const held = coordinator.exclusive(importId, dryRun, async (applying): Promise<MethodHandler<"stateImport.run">> => {
        const { dataFolder, terminalFolder } = await detectSource(machine);
        const folder = dataFolder ?? terminalFolder;
        if (folder === null) {
          return refused({ code: "conflict", message: "No source data folder or terminal-client state folder is on this machine.", data: { reason: "no_source" } });
        }
        // Terminal history/snippets remain client-owned; the Environment reports the file-picker cache omission.
        const dataPlan =
          dataFolder === null
            ? emptyPlan(await realpath(folder.path).catch(() => folder.path))
            : planImport(await readSourceStores(dataFolder.path), { log, create: options.createInstruction, get: options.getSettings, update: options.updateSettings });
        const planned = terminalFolder === null ? dataPlan : includeReportStores(dataPlan, [await readSourceFileFrecency(terminalFolder.path)]);
        const credentials = dataFolder === null ? null : await planCredentials(planned.sourceKey, log, options.forge, options.managers);
        const combined = credentials === null ? planned : { ...planned, stores: [...planned.stores, ...credentials.stores], failed: [...planned.failed, ...credentials.failed], notCarried: [...planned.notCarried, ...credentials.notCarried], repairs: credentials.repairs };
        if (dryRun) {
          const report = reportOf(combined, null);
          return () => ({ aggregate: environmentStream, result: report });
        }
        await hooks?.planned?.();
        const plan = await recheckStores(combined);
        applying();
        const actor = formatActor({ kind: "client_session", id: caller.clientSession.id });
        const attribution = { actor, commandId: importId, correlationId: importId };
        log.append(stateImportStream(options.environmentId), [{ type: "state-import.started", payload: { importId, sourceKey: plan.sourceKey } }], attribution);
        const applied = await applyItems(itemsOf(plan), {
          log,
          environmentId: options.environmentId,
          importId,
          caller,
          actor,
          afterItem: (item) => hooks?.carried?.({ kind: item.kind, sourceId: item.sourceId }),
        });
        const report = reportOf(plan, applied);
        return (_params, command) => {
          const finished = { type: "state-import.finished", payload: finishedPayload(report) };
          log.append(environmentStream, [finished], { tx: command.tx, actor: command.actor, commandId: command.commandId, correlationId: importId });
          return { aggregate: environmentStream, result: report };
        };
      });
      return (
        held ??
        refused({ code: "conflict", message: "A state import is under way on this environment: try again once it has finished.", data: { reason: "import_in_progress" } })
      );
    },
  };

  return { "stateImport.detect": detect, "stateImport.run": run };
};
