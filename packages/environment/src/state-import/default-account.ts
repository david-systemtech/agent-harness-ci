import { StateImportDefaultAccountDeferredPayload, type StateImportReEnter } from "@agent-harness/contracts";
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

/** Follow the retained choice on account changes and startup, exactly once. Later default edits win. */
export const followDeferredDefaults = (options: { readonly log: EventLog; readonly accounts: AccountService; readonly environmentId: string; readonly onChange: () => void }): (() => void) => {
  const { log, accounts, environmentId } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const follow = () => {
    for (const choice of deferredDefaults(reader)) {
      const accountId = mappedTarget(log, { sourceKey: choice.sourceKey, store: "profiles", sourceId: choice.sourceId });
      if (accountId === undefined || !accounts.list().some((account) => account.id === accountId && account.status.state === "signed-in")) continue;
      log.atomically((tx) => {
        const actor = "system:state-import";
        const edited = reader.all<{ payload: string }>("SELECT payload FROM events WHERE stream_kind = 'settings' AND type = 'settings.updated' AND sequence > ?", choice.sequence)
          .some((row) => Object.hasOwn(JSON.parse(row.payload).values, "accounts.defaultAccount"));
        if (!edited) {
          recordSettingsChange(log, environmentId, { "accounts.defaultAccount": accountId }, { tx, actor });
          tx.afterCommit(options.onChange);
        }
        log.append(stateImportStream(environmentId), [{ type: "state-import.item-carried", payload: {
          importId: choice.importId, sourceKey: choice.sourceKey, sourceId: "active-profile", store: "preferences", kind: "account-default", targetId: accountId, origin: "import",
        } }], { tx, actor, correlationId: choice.importId });
      });
    }
  };
  const unsubscribe = log.subscribe((event) => {
    if (event.type === "account.updated" || event.type === "state-import.default-account-deferred" || (event.type === "state-import.item-carried" && event.payload["kind"] === "account")) follow();
  });
  follow();
  return unsubscribe;
};
