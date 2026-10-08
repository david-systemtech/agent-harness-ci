import { NO_RUN_YET, runInfoFacts, type SessionProjection } from "@agent-harness/client-runtime";
import type { AccountCatalogue, AccountRecord } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { wrap, type Line } from "../transcript/lines.js";

/** Run info follows the open session's latest run; each fact wraps before the card scrolls it. */
export const runInfoLines = (projection: SessionProjection | undefined, accounts: readonly AccountRecord[] | null | undefined, catalogues: readonly AccountCatalogue[] | null | undefined, width: number): Line[] => {
  const run = projection?.runs.at(-1);
  if (run === undefined) return wrap([{ text: NO_RUN_YET, dim: true }], width).map((spans) => ({ row: "no-run", spans }));
  const account = accounts?.find((candidate) => candidate.id === run.accountId);
  return runInfoFacts(run, projection?.policies[run.runId], account, catalogues ?? null).flatMap(({ term, words }) =>
    wrap([{ text: `${term}: `, color: TERMINAL_ROLES.faint }, { text: words }], width).map((spans) => ({ row: term, spans })),
  );
};
