import { COMPLETIONS_NAMESPACE, type CompletionsModel } from "@agent-harness/contracts";
import type { ModelOption } from "../adapter/contract.js";

/**
 * The model ids of the completions surface (claude-adapter spec, "The
 * completions surface": model ids): `<account label slug>/<model or
 * family>`, the slug slash-free, so the rest of `/v1/models/<id>` is the id
 * as the listing gave it; a bare model or family is the default account's.
 * The listing is every signed-in account's catalogue.
 */

/** An account as the surface reads it: its id, label and provider, whether it is signed in, and its catalogue. */
export interface CatalogueAccount {
  readonly id: string;
  /** The account's label, whose slug names it in a model id. */
  readonly label: string;
  readonly provider: string;
  readonly signedIn: boolean;
  readonly models: readonly ModelOption[];
}

/** Where the surface reads accounts from: the account store's records (#134), each with what the host would run it with. */
export interface CompletionsCatalogue {
  /** Every account the environment holds, in its order. */
  accounts(): readonly CatalogueAccount[];
  /** The account a bare model id names: the environment's default. */
  defaultAccountId(): string | null;
}

/** A label as a model id's first part: lower case, every run of anything but a letter, digit, dot, underscore or hyphen one hyphen, never a slash. */
export const accountSlug = (label: string): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "account" : slug;
};

/** An account with the slug its model ids carry: a slug two labels share gets `-2`, `-3` after the first, in the accounts' order. */
interface Slugged {
  readonly account: CatalogueAccount;
  readonly slug: string;
}

const slugged = (accounts: readonly CatalogueAccount[]): Slugged[] => {
  const used = new Set<string>();
  return accounts.map((account) => {
    const base = accountSlug(account.label);
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}-${n}`;
    used.add(slug);
    return { account, slug };
  });
};

/** A model id resolved: the account, its slug, the model, and the id the listing gives it. */
export interface ResolvedModel {
  readonly account: CatalogueAccount;
  readonly model: ModelOption;
  /** `<slug>/<model id>`: the id the listing names the model by, whatever named it. */
  readonly id: string;
}

/** The model a name picks in an account's catalogue: the model of that id, else the strongest of that family. */
const pick = (account: CatalogueAccount, name: string): ModelOption | undefined =>
  account.models.find((model) => model.id === name) ??
  [...account.models].filter((model) => model.family === name).sort((a, b) => b.tier - a.tier)[0];

/**
 * Resolves a requested model: `<slug>/<model or family>` on the account of
 * that slug (the part after the first slash may hold slashes of its own), or
 * a bare model or family on `bareAccountId`: the default account, or, for a
 * request continuing a session, the session's own, so a change of default
 * does not move an ongoing conversation. Undefined when nothing matches.
 */
export const resolveModel = (catalogue: CompletionsCatalogue, asked: string, bareAccountId: string | null = catalogue.defaultAccountId()): ResolvedModel | undefined => {
  const accounts = slugged(catalogue.accounts());
  const slash = asked.indexOf("/");
  const target =
    slash >= 0
      ? { entry: accounts.find((candidate) => candidate.slug === asked.slice(0, slash).toLowerCase()), name: asked.slice(slash + 1) }
      : { entry: accounts.find((candidate) => candidate.account.id === bareAccountId), name: asked };
  if (target.entry === undefined || target.name === "") return undefined;
  const model = pick(target.entry.account, target.name);
  return model === undefined ? undefined : { account: target.entry.account, model, id: `${target.entry.slug}/${model.id}` };
};

/** The id the listing names the model `modelId` of the account `accountId` by, whether or not its catalogue still offers it; undefined when the account is not here. */
export const listingId = (catalogue: CompletionsCatalogue, accountId: string, modelId: string): string | undefined => {
  const entry = slugged(catalogue.accounts()).find(({ account }) => account.id === accountId);
  return entry === undefined ? undefined : `${entry.slug}/${modelId}`;
};

/** A model as the listing shows it. */
export const modelObject = (resolved: ResolvedModel, created: number): CompletionsModel => ({
  id: resolved.id,
  object: "model",
  created,
  owned_by: resolved.account.provider,
  family: resolved.model.family,
  tier: resolved.model.tier,
  [COMPLETIONS_NAMESPACE]: { account: resolved.account.label, accountId: resolved.account.id },
});

/** Every signed-in account's catalogue, in the accounts' order and each catalogue's own. */
export const listModels = (catalogue: CompletionsCatalogue, created: number): CompletionsModel[] =>
  slugged(catalogue.accounts())
    .filter(({ account }) => account.signedIn)
    .flatMap(({ account, slug }) => account.models.map((model) => modelObject({ account, model, id: `${slug}/${model.id}` }, created)));
