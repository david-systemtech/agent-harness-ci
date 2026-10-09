import { FAVOURITE_MODELS_MAX, type AccountCatalogue, type AccountRecord, type ModelEntry } from "@agent-harness/contracts";
import { modelsOf } from "../status/words.js";

/**
 * The favourite models (#1821): the order the account and model picker
 * offers an account's models in, and the edits Settings makes to
 * `accounts.favouriteModels`. The favourites the account lists come first,
 * in the person's order, as one-click picks; with none of them listed, the
 * provider's recommended models do; every other model the account lists is
 * under Other models, grouped by account while the session has none and so
 * lists every account's.
 */

/** How many recommended models the picker offers while no favourite is listed. */
export const RECOMMENDED_MODELS = 4;

/** The provider's recommended models: the first model it lists of each family, in its own order. */
export const recommendedModels = (models: readonly ModelEntry[]): readonly ModelEntry[] => {
  const families = new Set<string>();
  return models.filter((entry) => (families.has(entry.family) ? false : (families.add(entry.family), true))).slice(0, RECOMMENDED_MODELS);
};

/**
 * The favourites as the model ids they name, each once, in order: a
 * favourite `listed` holds is itself; any other is the part after its last
 * `/`, which reads the `<account>/<model>` form an earlier carry over wrote
 * (#1954) as the model it names. The edits Settings makes start from these,
 * so its next write leaves the plain ids.
 */
export const favouriteModelIds = (favourites: readonly string[], listed: { has(id: string): boolean }): readonly string[] =>
  [...new Set(favourites.map((id) => (listed.has(id) ? id : id.slice(id.lastIndexOf("/") + 1) || id)))];

/** One account's models under Other models. */
export interface ModelGroup {
  readonly accountId: string;
  readonly models: readonly ModelEntry[];
}

/** The models the picker offers, in its order. */
export interface PickerModels {
  /** The one-click picks: the favourites listed, else the recommended models, then the session's model when it is neither. */
  readonly quick: readonly ModelEntry[];
  /** Whether the quick picks are the person's favourites rather than the recommended models. */
  readonly pinned: boolean;
  /** Whether Other models names each group's account: the listing is every account's. */
  readonly grouped: boolean;
  /** Every model listed that is not a quick pick, each once, under the first account that lists it. */
  readonly others: readonly ModelGroup[];
}

/** Each catalogue's models that `taken` does not hold yet, taking them as it goes; an account left with none is left out. */
const groupsOf = (catalogues: readonly AccountCatalogue[], taken: Set<string>): readonly ModelGroup[] =>
  catalogues
    .map((catalogue) => ({ accountId: catalogue.accountId, models: catalogue.models.filter((entry) => (taken.has(entry.id) ? false : (taken.add(entry.id), true))) }))
    .filter((group) => group.models.length > 0);

/**
 * The models the picker offers for `accountId` (every account's, once each,
 * when null): the `favourites` it lists in their order, else the
 * recommended models; then `current`, the session's model, when listed and
 * neither; the rest under Other models.
 */
export const pickerModels = (catalogues: readonly AccountCatalogue[], accountId: string | null, favourites: readonly string[], current?: string): PickerModels => {
  const listed = modelsOf(catalogues, accountId);
  const byId = new Map(listed.map((entry) => [entry.id, entry]));
  const pinned = favouriteModelIds(favourites, byId).flatMap((id) => byId.get(id) ?? []);
  const first = pinned.length > 0 ? pinned : recommendedModels(listed);
  const held = current === undefined ? undefined : byId.get(current);
  const quick = held === undefined || first.includes(held) ? first : [...first, held];
  const sources = accountId === null ? catalogues : catalogues.filter((catalogue) => catalogue.accountId === accountId);
  return { quick, pinned: pinned.length > 0, grouped: sources.length > 1, others: groupsOf(sources, new Set(quick.map((entry) => entry.id))) };
};

/** What the picker says over recommended quick picks: how to pin favourites, or that none pinned is listed; nothing over favourites. */
export const pinWords = (picked: Pick<PickerModels, "pinned">, favourites: readonly string[]): string | undefined => {
  if (picked.pinned) return undefined;
  return favourites.length === 0 ? "Recommended models. Pin your favourites in Settings, Default account and model." : "None of your favourites is listed for this account: recommended models.";
};

/** What a favourite can be added from: the models the signed-in accounts list that are not favourites, each once, by account. */
export const favouriteCandidates = (catalogues: readonly AccountCatalogue[], accounts: readonly AccountRecord[], favourites: readonly string[]): readonly ModelGroup[] => {
  const signedIn = new Set(accounts.filter((account) => account.status.state === "signed-in").map((account) => account.id));
  const sources = catalogues.filter((catalogue) => signedIn.has(catalogue.accountId));
  return groupsOf(sources, new Set(favouriteModelIds(favourites, new Set(sources.flatMap((catalogue) => catalogue.models.map((entry) => entry.id))))));
};

/** The favourites with `id` added at the end; unchanged when it is one, or the list is full. */
export const addFavourite = (favourites: readonly string[], id: string): readonly string[] =>
  favourites.includes(id) || favourites.length >= FAVOURITE_MODELS_MAX ? favourites : [...favourites, id];

/** The favourites without `id`. */
export const removeFavourite = (favourites: readonly string[], id: string): readonly string[] => favourites.filter((entry) => entry !== id);

/** The favourites with `id` one place earlier (-1) or later (1); unchanged at either end. */
export const moveFavourite = (favourites: readonly string[], id: string, by: -1 | 1): readonly string[] => {
  const from = favourites.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= favourites.length) return favourites;
  const moved = [...favourites];
  [moved[from], moved[to]] = [moved[to]!, moved[from]!];
  return moved;
};
