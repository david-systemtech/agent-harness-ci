import { SettingsUpdatedPayload, StateImportDefaultAccountDeferredPayload, type StateImportReEnter } from "@agent-harness/contracts";
import type { AccountService } from "../accounts/account-service.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";
import { recordSettingsChange } from "../settings/changes.js";
import { mappedTarget, stateImportStream } from "./items.js";

/** Deferred choices are durable import evidence, separate from successfully carried defaults. */
export const deferredDefaults = (reader: Reader) => {
  const rows = reader.all<{ payload: string; sequence: number }>("SELECT payload, sequence FROM events WHERE stream_kind = 'state-import' AND type = 'state-import.default-account-deferred' ORDER BY sequence");
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const choice = StateImportDefaultAccountDeferredPayload.parse(JSON.parse(row.payload));
    if (seen.has(choice.sourceKey)) return [];
    seen.add(choice.sourceKey);
    const held = reader.all("SELECT target_id FROM state_import_items WHERE source_key = ? AND store = 'preferences' AND source_id = 'active-profile'", choice.sourceKey);
    return held.length === 0 ? [{ ...choice, sequence: row.sequence }] : [];
  });
};

export const defaultAccountRepair = (label: string): StateImportReEnter => ({ label: `Sign in ${label}, then the default follows`, step: "account" });

/** Follow the retained choice on account changes and startup, exactly once. A default edit resolves it immediately, even before sign-in. */
export const followDeferredDefaults = (options: { readonly log: EventLog; readonly accounts: AccountService; readonly environmentId: string; readonly onChange: () => void }): (() => void) => {
  const { log, accounts, environmentId } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const follow = () => {
    for (const choice of deferredDefaults(reader)) {
      const edits = reader.all<{ payload: string }>("SELECT payload FROM events WHERE stream_kind = 'settings' AND stream_id = ? AND type = 'settings.updated' AND sequence > ? ORDER BY sequence", environmentId, choice.sequence)
        .map((row) => SettingsUpdatedPayload.parse(JSON.parse(row.payload)))
        .filter((update) => Object.hasOwn(update.values, "accounts.defaultAccount"));
      const editedDefault = edits.at(-1)?.values["accounts.defaultAccount"];
      const accountId = mappedTarget(log, { sourceKey: choice.sourceKey, store: "profiles", sourceId: choice.sourceId });
      if (editedDefault === undefined && !accounts.list().some((account) => account.id === accountId && account.status.state === "signed-in")) continue;
      const targetId = editedDefault === undefined ? accountId : editedDefault ?? "accounts.defaultAccount";
      if (targetId === undefined) continue;
      log.atomically((tx) => {
        const actor = "system:state-import";
        if (editedDefault === undefined) {
          recordSettingsChange(log, environmentId, { "accounts.defaultAccount": targetId }, { tx, actor });
          tx.afterCommit(options.onChange);
        }
        log.append(stateImportStream(environmentId), [{ type: "state-import.item-carried", payload: {
          importId: choice.importId, sourceKey: choice.sourceKey, sourceId: "active-profile", store: "preferences", kind: "account-default", targetId, origin: "import",
        } }], { tx, actor, correlationId: choice.importId });
      });
    }
  };
  const unsubscribe = log.subscribe((event) => {
    if ((event.type === "settings.changed" && Array.isArray(event.payload["keys"]) && event.payload["keys"].includes("accounts.defaultAccount")) || event.type === "account.updated" || event.type === "state-import.default-account-deferred" || (event.type === "state-import.item-carried" && event.payload["kind"] === "account")) follow();
  });
  follow();
  return unsubscribe;
};
