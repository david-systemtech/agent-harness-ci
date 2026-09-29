import type { SettingsValues } from "@agent-harness/contracts";
import { decideInjection, type InjectionSeam } from "../adapter/process-environment.js";
import type { EventLog } from "../event-log/event-log.js";
import { recordSettingsChange, type SettingsChangeAttribution } from "../settings/changes.js";
import { readSettings } from "../settings/settings-store.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367), the Key manager step's two keys: `credentials.injection`,
 * the environment's `allow` or `deny`, and `credentials.injectionByAccount`,
 * each account's. The process environment's injection seam reads them as
 * each holder is built, so one answer governs every supplier (the forge's
 * variables and helper, #315; the key managers' block, #368). An account's
 * entry goes when the account does.
 */

/** The injection seam over the settings as they are now: a holder's own override, else its account's entry, else the environment's value. */
export const settingsInjection =
  (settings: () => SettingsValues): InjectionSeam =>
  (scope) => {
    const values = settings();
    return decideInjection(scope, { environment: values["credentials.injection"], byAccount: values["credentials.injectionByAccount"] });
  };

/**
 * Drops `accountId`'s entry from `credentials.injectionByAccount` in the
 * transaction that removes the account, recorded as a settings change
 * there; nothing when the account had none.
 */
export const dropAccountInjection = (log: EventLog, environmentId: string, accountId: string, attribution: SettingsChangeAttribution): void => {
  const held = readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["credentials.injectionByAccount"];
  if (!Object.hasOwn(held, accountId)) return;
  const kept = Object.fromEntries(Object.entries(held).filter(([id]) => id !== accountId));
  recordSettingsChange(log, environmentId, { "credentials.injectionByAccount": kept }, attribution);
};
