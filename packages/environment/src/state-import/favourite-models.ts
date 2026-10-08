import { registry } from "@agent-harness/contracts";
import { mappedTarget, stateImportStream, type ImportItem } from "./items.js";
import type { PlanInstructionsOptions } from "./instructions.js";
import type { PagePolicyOwner } from "./page-policy.js";

/** How many of the source's chosen models become favourites: the picker's quick picks, not the source's whole history. */
export const CARRIED_FAVOURITES = 5;

/**
 * The favourite models (#1821) made of the models chosen in the source
 * (`models`, the composer's first, then by how many sessions chose each):
 * the first `CARRIED_FAVOURITES`, written through `settings.update` while the
 * environment has none. An environment with a list of its own keeps it, and
 * the item is carried without a write, so a later import never replaces it.
 * Nothing is planned while the source chose no model or an import carried
 * the item already.
 */
export const planFavouriteModels = (models: readonly string[], options: Pick<PlanInstructionsOptions, "log" | "sourceKey"> & PagePolicyOwner & { readonly environmentId: string }): readonly ImportItem[] => {
  const key = { sourceKey: options.sourceKey, store: "preferences", sourceId: "favourite-models" };
  if (models.length === 0 || mappedTarget(options.log, key) !== undefined) return [];
  return [{
    ...key,
    kind: "favourite-models",
    label: "Favourite models",
    apply: (context) => {
      const held = options.get({ keys: ["accounts.favouriteModels"] }, context).values["accounts.favouriteModels"] ?? [];
      if (held.length > 0) return { aggregate: stateImportStream(options.environmentId), result: { targetId: "accounts.favouriteModels", carried: false } };
      const params = registry["settings.update"].params.parse({ commandId: context.commandId, values: { "accounts.favouriteModels": models.slice(0, CARRIED_FAVOURITES) } });
      const answer = options.update(params, context);
      return answer.rejected !== undefined ? answer : { ...answer, result: { targetId: "accounts.favouriteModels" } };
    },
  }];
};
