import { BANK_INDEX_BUDGET, utf8Bytes } from "@agent-harness/contracts";
import type { LayerSeam } from "../instructions/composer.js";
import type { EventLog } from "../event-log/event-log.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank } from "./bank-index.js";
import { listBanks, sessionBankPins } from "./bank-store.js";
import { renderTrail } from "./index-renderer.js";
import { bankInScope } from "./scope.js";
import { firstBankMessage, recentBankUse } from "./session-relevance.js";

/** The renderer's run layer; placement can separate its fixed tiers from session expansions. */
export const bankInstructionsLayer = (log: EventLog): LayerSeam => async (scope) => {
  const reader = { all: <T>(sql: string, ...params: readonly (string | number | null)[]) => log.read<T>(sql, ...params) };
  const entries = listBanks(reader).filter((bank) => bankInScope(bank, scope));
  const indices = await Promise.allSettled(entries.map(async (bank) => indexBank({ ...bank, files: await readBankFiles(bank.checkout) })));
  const live = new Set(listBanks(reader).filter((bank) => bankInScope(bank, scope)).map((bank) => bank.id));
  const scoped = indices.flatMap((result, i) => live.has(entries[i]!.id) ? [{ result, entry: entries[i]! }] : []);
  if (scoped.length === 0) return [];
  const banks = scoped.flatMap(({ result }) => result.status === "fulfilled" ? [result.value] : []);
  const unavailable = scoped.flatMap(({ result, entry }) => result.status === "rejected" ? [`## ${entry.name} (${entry.kind ?? "unknown"}, ${entry.role}) — could not be read\n`] : []);
  const missing = unavailable.join("");
  const text = renderTrail(banks, {
    registryPins: entries.filter((bank) => live.has(bank.id)).flatMap((bank) => bank.pins),
    repositoryIdentity: scope.repositoryIdentity,
    ...(scope.sessionId !== null && {
      sessionPins: sessionBankPins(reader, scope.sessionId),
      recentUse: recentBankUse(log, scope.sessionId, live),
      firstMessage: firstBankMessage(log, scope.sessionId),
    }),
  }, { lines: BANK_INDEX_BUDGET.lines - unavailable.length, bytes: BANK_INDEX_BUDGET.bytes - utf8Bytes(missing) }).text + missing;
  return [{ id: "banks", version: null, title: "Memory banks", text }];
};
