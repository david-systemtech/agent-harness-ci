import { createHash } from "node:crypto";
import { ContractError, STATE_IMPORT_STREAM_KIND, type StateImportFailure, type StateImportItemCarriedPayload, type StateImportItemKind } from "@agent-harness/contracts";
import type { EventLog, Projector, StreamRef } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodContext, PrepareContext, Undo } from "../serve/methods.js";
import { ItemFailure } from "./failures.js";

/**
 * The state import's item protocol (switch-over spec, "Preview, application
 * and re-run"; #1165), which every kind an import carries goes through: an
 * item is named by the source folder's canonical path, the store it was read
 * from and its id there (or its natural identity), never its position in a
 * list. An import carries each of its items in a command of its own, one
 * after another, under an id derived from the import's and the item's, so a
 * retry of the import meets the item's receipt instead of doing it twice;
 * the command applies the item through the service that owns its kind and,
 * in the same transaction, appends `state-import.item-carried` naming the
 * target that service made. That event is the mapping: the read model here
 * is rebuilt from it, and a mapped item is never applied again, so a target
 * edited or deleted since stays as it is. An item that failed has no
 * mapping and is tried again by the next import.
 */

export const STATE_IMPORT_PROJECTOR = "state-import";

/** The state import's stream: the environment's one, where an import starts and what it carried. */
export const stateImportStream = (environmentId: string): StreamRef => ({ kind: STATE_IMPORT_STREAM_KIND, id: environmentId });

/** Only provider-session mappings can be redirected when shared-transcript repair removes redundant rows. */
export const stateImportProjector: Projector = {
  name: STATE_IMPORT_PROJECTOR,
  tables: {
    state_import_items: `CREATE TABLE state_import_items (
      source_key TEXT NOT NULL,
      store TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source_directory TEXT,
      import_id TEXT NOT NULL,
      PRIMARY KEY (source_key, store, source_id)
    ) STRICT`,
  },
  apply(event, db) {
    if (event.streamKind !== STATE_IMPORT_STREAM_KIND || event.type !== "state-import.item-carried") return;
    const { sourceKey, store, sourceId, kind, targetId, importId, sourceDirectory } = event.payload as StateImportItemCarriedPayload;
    db.run(
      "INSERT INTO state_import_items (source_key, store, source_id, kind, target_id, import_id, source_directory) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_key, store, source_id) DO UPDATE SET target_id = excluded.target_id, source_directory = excluded.source_directory, import_id = excluded.import_id WHERE state_import_items.kind = 'session' AND excluded.kind = 'session' AND excluded.store = 'provider-sessions'",
      sourceKey,
      store,
      sourceId,
      kind,
      targetId,
      importId,
      sourceDirectory ?? null,
    );
  },
};

/** Where an item came from: the source folder's canonical path, its store, and its id there. */
export interface ItemKey {
  readonly sourceKey: string;
  readonly store: string;
  readonly sourceId: string;
}

/** The target an earlier import made of the item; undefined for one never carried. Inside a command, as of its transaction. */
export const mappedTarget = (log: Pick<EventLog, "read">, { sourceKey, store, sourceId }: ItemKey): string | undefined =>
  log.read<{ target_id: string }>("SELECT target_id FROM state_import_items WHERE source_key = ? AND store = ? AND source_id = ?", sourceKey, store, sourceId)[0]?.target_id;

/** The original declared directory, retained alongside its Account mapping for secondary-source imports. */
export const mappedDirectory = (log: Pick<EventLog, "read">, { sourceKey, store, sourceId }: ItemKey): string | undefined =>
  log.read<{ source_directory: string | null }>("SELECT source_directory FROM state_import_items WHERE source_key = ? AND store = ? AND source_id = ?", sourceKey, store, sourceId)[0]?.source_directory ?? undefined;

/**
 * A version 4 UUID derived from `parts`: the same parts always give the
 * same one, so an item's command, and a target its owner names by a
 * client-minted id, are one across retries.
 */
export const derivedUuid = (...parts: readonly string[]): string => {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** One item an import plans to carry: where it came from, what it is called on the report, and how its owning service applies it. */
interface ImportItemKey extends ItemKey {
  readonly kind: StateImportItemKind;
  /** The item as the report names it when it fails: plain words, no path or id. */
  readonly label: string;
  /** The facts behind the label for Details when it fails (a repository, a folder): what the label leaves out. */
  readonly details?: readonly string[];
  /** Whether this item adds a report count; aliases and reused targets do not. */
  readonly contributes?: () => boolean;
  readonly sourceDirectory?: string;
  /** Read-only owner checks immediately before this child's transaction; null permits it, a message fails it independently. */
  readonly validate?: () => Promise<string | null>;
  /** Preview cannot fetch sources: report a name not yet known without reserving it. */
  readonly previewFailure?: StateImportFailure;
  /** False in a preview when the owner will reuse a target; apply answers its actual carried count at commit. */
  readonly counted?: boolean;
}

/** Prepared owners finish bounded filesystem/provider reads before the item transaction. A deferred result commits the owner's retained choice without a carried mapping. */
type ImportApply = (context: CommandContext) => CommandAnswer<{ readonly targetId: string; readonly carried?: boolean; readonly deferred?: boolean }>;
type ImportPrepare = (context: PrepareContext & { readonly commandId: string }) => Promise<ImportApply>;
export type ImportItem = ImportItemKey & (
  | { readonly apply: ImportApply; readonly prepare?: ImportPrepare }
  | { readonly apply?: never; readonly prepare: ImportPrepare }
);

/** What applying a plan's items did: those carried, and those that failed, each with why. */
export interface ItemsApplied {
  readonly carried: readonly ImportItem[];
  readonly failed: readonly StateImportFailure[];
  readonly heldDrafts?: number;
}

export interface ApplyItemsOptions {
  readonly log: EventLog;
  readonly environmentId: string;
  /** The import: the parent command's id. */
  readonly importId: string;
  /** The client session that asked for the import, as every item's command runs. */
  readonly caller: MethodContext;
  readonly actor: string;
  /** Heard after each item's command commits, before the next: a test stops the import there, as a crash would. */
  readonly afterItem?: (item: ImportItem) => void | Promise<void>;
}

/** The item's command's id: derived from the import's and the item's, never the import's own. */
const itemCommandId = (importId: string, item: ImportItem): string => derivedUuid("state-import.item", importId, item.kind, item.sourceKey, item.store, item.sourceId);

/**
 * Carries `items`, one command each, one after another, in order. Each
 * command checks again, in its transaction, that no import carried the item
 * meanwhile, and leaves one that was alone; its owning service checks its
 * own conditions. What one item's service refuses or throws fails that item
 * alone: the items carried before it stay carried.
 */
export const applyItems = async (items: readonly ImportItem[], options: ApplyItemsOptions): Promise<ItemsApplied> => {
  const { log, importId, caller, actor } = options;
  const stream = stateImportStream(options.environmentId);
  const carried: ImportItem[] = [];
  const failed: StateImportFailure[] = [];
  let heldDrafts = 0;
  for (const item of items) {
    const commandId = itemCommandId(importId, item);
    let outcome: "carried" | "held" | StateImportFailure;
    const failure = (said: Omit<StateImportFailure, "label">): StateImportFailure => {
      const details = [...item.details ?? [], ...said.details ?? []];
      return { label: item.label, ...said, ...(details.length > 0 && { details }) };
    };
    if (mappedTarget(log, item) !== undefined) continue;
    const undos: Undo[] = [];
    let accepted = false;
    try {
      const refusal = item.validate === undefined ? null : await item.validate();
      if (refusal != null) { failed.push(failure({ message: refusal })); continue; }
      const preparation = { ...caller, commandId, onUndo: (undo: Undo) => void undos.push(undo) };
      const apply = item.apply === undefined ? await item.prepare(preparation) : await item.prepare?.(preparation) ?? item.apply;
      const run = log.command<{ readonly carried: boolean }>({ actor, commandId }, (tx) => {
        if (mappedTarget(log, item) !== undefined) return { aggregate: stream, result: { carried: false } };
        const answer = apply({ ...caller, commandId, actor, tx });
        if (answer.rejected !== undefined) {
          const { code, message = `The item was refused: ${code}.`, data = {} } = answer.rejected;
          return { aggregate: answer.aggregate, rejected: { code, message, data } };
        }
        if (answer.result.deferred === true) return { aggregate: answer.aggregate, result: { carried: false } };
        const { sourceKey, store, sourceId, kind } = item;
        const payload: StateImportItemCarriedPayload = { importId, sourceKey, store, sourceId, kind, targetId: answer.result.targetId, origin: "import", ...(item.sourceDirectory !== undefined && { sourceDirectory: item.sourceDirectory }) };
        log.append(stream, [{ type: "state-import.item-carried", payload: { ...payload } }], { tx, actor, commandId, correlationId: importId });
        return { aggregate: answer.aggregate, result: { carried: answer.result.carried !== false }, ...(answer.events !== undefined && { events: answer.events }) };
      });
      accepted = run.receipt.status === "accepted";
      if (run.receipt.status === "rejected") outcome = failure({ message: run.receipt.error.message });
      // A receipt from before (a retry of this import) answers for an item whose command already ran: it is held now.
      else outcome = !run.replayed && run.result?.carried === true ? "carried" : "held";
    } catch (thrown) {
      // A failure the item names in full is the report's; anything else is logged as well.
      if (thrown instanceof ItemFailure) outcome = failure(thrown.failure);
      else {
        console.error(`Carrying ${item.kind} ${item.sourceId} failed:`, thrown);
        outcome = failure({ message: thrown instanceof ContractError ? thrown.message : "The environment failed while carrying it: a re-run tries it again." });
      }
    }
    if (!accepted) for (const undo of undos.reverse()) {
      try { await undo(); }
      catch { console.error(`Cleaning up a refused ${item.kind} failed.`); }
    }
    if (outcome === "carried") carried.push(item);
    else if (outcome !== "held") failed.push(outcome);
    else if (item.kind === "draft") heldDrafts++;
    // Outside the catch: what this throws stops the import, as a crash between two items would.
    if (outcome === "carried") await options.afterItem?.(item);
  }
  return { carried, failed, ...(heldDrafts > 0 && { heldDrafts }) };
};
