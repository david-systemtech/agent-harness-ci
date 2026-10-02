import { BrowserDevSites, registry, type SettingsPatch, type StateImportFailure } from "@agent-harness/contracts";
import type { CommandContext } from "../serve/methods.js";
import type { SettingsHandlers } from "../settings/methods.js";
import { mappedTarget, type ImportItem } from "./items.js";
import type { PlanInstructionsOptions } from "./instructions.js";
import type { SourceBrowser } from "./source/browser.js";

export interface PagePolicyOwner {
  readonly get: SettingsHandlers["settings.get"];
  readonly update: SettingsHandlers["settings.update"];
}

/** Add sites to this Environment's policy through its owning settings handler; mappings hold later edits. */
export const planPagePolicy = (records: SourceBrowser, options: Pick<PlanInstructionsOptions, "log" | "sourceKey"> & PagePolicyOwner) => {
  const items: ImportItem[] = [];
  const failed: StateImportFailure[] = [];
  const item = (sourceId: string, kind: ImportItem["kind"], label: string, values: (context: CommandContext) => SettingsPatch) => {
    const key = { sourceKey: options.sourceKey, store: kind === "dev-site" ? "browser.devSites" : "browser.evaluateEverywhere", sourceId };
    if (mappedTarget(options.log, key) !== undefined) return;
    items.push({
      ...key,
      kind,
      label,
      apply: (context) => {
        const params = registry["settings.update"].params.parse({ commandId: context.commandId, values: values(context) });
        const answer = options.update(params, context);
        return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: kind === "dev-site" ? sourceId : "browser.evaluateEverywhere" } };
      },
    });
  };
  for (const site of new Set(records.devSites)) {
    if (!BrowserDevSites.safeParse([site]).success) {
      failed.push({ label: "Dev site", message: "Browser settings require a host pattern without a scheme, port or path." });
      continue;
    }
    item(site, "dev-site", "Dev site", (context) => {
      const held = options.get({ keys: ["browser.devSites"] }, context).values["browser.devSites"] ?? [];
      return { "browser.devSites": [...new Set([...held, site])] };
    });
  }
  if (records.evaluateEverywhere !== undefined) {
    item("evaluate-everywhere", "page-policy", "Evaluate everywhere", () => ({ "browser.evaluateEverywhere": records.evaluateEverywhere }));
  }
  return { items, failed };
};
