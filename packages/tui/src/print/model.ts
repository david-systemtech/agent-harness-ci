import { COMPLETIONS_NAMESPACE, type CompletionsModel } from "@agent-harness/contracts";

/**
 * The model a printed turn runs on, by the Account-qualified id the live
 * listing (`GET /v1/models`) gives it (docs/specs/switch-over.md L97): the
 * id asked for as listed; else a model of the account by its own id, or a
 * family of it (its strongest tier); with nothing asked for, the model the
 * selection chose for the account. Undefined when the listing has none.
 */
export const listedModel = (listing: readonly CompletionsModel[], accountId: string, asked: string | undefined, chosen: string | undefined): CompletionsModel | undefined => {
  const exact = asked === undefined ? undefined : listing.find((entry) => entry.id === asked);
  if (exact !== undefined) return exact;
  const offered = listing.filter((entry) => entry[COMPLETIONS_NAMESPACE].accountId === accountId);
  const named = asked ?? chosen;
  return (
    offered.find((entry) => entry.id.slice(entry.id.indexOf("/") + 1) === named) ??
    (asked === undefined ? undefined : offered.filter((entry) => entry.family === asked).sort((a, b) => b.tier - a.tier)[0])
  );
};
