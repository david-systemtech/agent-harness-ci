import type { SettingsValues } from "@agent-harness/contracts";
import { decideInjection, type InjectionSeam } from "../adapter/process-environment.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367), the Key manager step's two keys: `credentials.injection`,
 * the environment's `allow` or `deny`, and `credentials.injectionByAccount`,
 * each account's. The process environment's injection seam reads them as
 * each holder is built, so one answer governs every supplier (the forge's
 * variables and helper, #315; the key managers' block, #368).
 */

/** The injection seam over the settings as they are now: a holder's own override, else its account's entry, else the environment's value. */
export const settingsInjection =
  (settings: () => SettingsValues): InjectionSeam =>
  (scope) => {
    const values = settings();
    return decideInjection(scope, { environment: values["credentials.injection"], byAccount: values["credentials.injectionByAccount"] });
  };
