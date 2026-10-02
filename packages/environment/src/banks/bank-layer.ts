import { BANK_INDEX_BUDGET, utf8Bytes, type BankEntry } from "@agent-harness/contracts";
import { liveAccount } from "../accounts/account-store.js";
import type { EventLog } from "../event-log/event-log.js";
import type { LayerSeam } from "../instructions/composer.js";
import type { AutoMemory } from "../workspace/auto-memory.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex } from "./bank-index.js";
import { listBanks, sessionBankPins } from "./bank-store.js";
import { renderBankLayers, renderFixedTiers, renderTrail, type IndexBudget } from "./index-renderer.js";
import { bankInScope } from "./scope.js";
import { firstBankMessage, recentBankUse } from "./session-relevance.js";

interface Reading {
  readonly entry: BankEntry;
  readonly index: BankIndex | null;
}
const readerOf = (log: EventLog) => ({ all: <T>(sql: string, ...params: readonly (string | number | null)[]) => log.read<T>(sql, ...params) });
const repositoryScope = (bank: BankEntry, repositoryIdentity: string | null): boolean => bank.enabled && (bank.repositories === "all" || (repositoryIdentity !== null && bank.repositories.includes(repositoryIdentity)));
const readRepository = async (log: EventLog, repositoryIdentity: string | null): Promise<Reading[]> => {
  const reader = readerOf(log);
  const entries = listBanks(reader).filter((entry) => repositoryScope(entry, repositoryIdentity));
  const indices = await Promise.allSettled(entries.map(async (entry) => indexBank({ ...entry, files: await readBankFiles(entry.checkout) })));
  // A scope, role or manifest kind may have changed while git was being read.
  const live = new Map(listBanks(reader).filter((entry) => repositoryScope(entry, repositoryIdentity)).map((entry) => [entry.id, entry]));
  return indices.flatMap((result, i) => {
    const entry = live.get(entries[i]!.id);
    if (entry === undefined) return [];
    return [{ entry, index: result.status === "fulfilled" ? { ...result.value, name: entry.name, kind: entry.kind, role: entry.role } : null }];
  });
};
const indicesOf = (readings: readonly Reading[]): BankIndex[] => readings.flatMap(({ index }) => index === null ? [] : [index]);
const unavailable = (readings: readonly Reading[]): string => readings.flatMap(({ entry, index }) => index === null ? [`## ${entry.name} (${entry.kind ?? "unknown"}, ${entry.role}) — could not be read\n`] : []).join("");
const size = (text: string): IndexBudget => ({ lines: text === "" ? 0 : text.split("\n").length - 1, bytes: utf8Bytes(text) });
const remaining = (budget: IndexBudget, text: string): IndexBudget => ({ lines: budget.lines - size(text).lines, bytes: budget.bytes - size(text).bytes });

/** Render the manifest's facts and routing rules, never its Markdown body. */
const guidance = (readings: readonly Reading[]): string => {
  if (readings.length === 0) return "";
  const personal = readings.find(({ index }) => index?.kind === "personal");
  return [
    "# Memory banks",
    ...readings.flatMap(({ entry, index }) => [
      `- ${entry.name} (${entry.kind ?? "unknown"}, ${entry.role}) — ${index?.purpose ?? "purpose unavailable"}`,
      ...(index?.entities.map((entity) => `Facts about ${entity.name} go to ${entry.name}.`) ?? []),
      ...(entry.kind === "team" && personal !== undefined ? [`You may also keep a private copy of a team fact in ${personal.entry.name}: ${entry.privateCopy ? "on" : "off"}. A private copy points to the team fact.`] : []),
    ]),
    "Name a bank when several are writable; use org, project and area; one fact per memory; point rather than restate. Read and search pointers with memory_read and memory_search; write through memory_draft, memory_retire and memory_promote.",
    "",
  ].join("\n");
};

/** Reserve the largest account's fixed instruction content so every account gets the same shared bytes. */
const sharedBudget = (readings: readonly Reading[]): IndexBudget => {
  const accounts = new Set(["", ...readings.flatMap(({ entry }) => entry.accounts === "all" ? [] : entry.accounts)]);
  let lines = 0;
  let bytes = 0;
  for (const account of accounts) {
    const scoped = readings.filter(({ entry }) => entry.accounts === "all" || entry.accounts.includes(account));
    const privateBanks = scoped.filter(({ entry }) => entry.accounts !== "all");
    const reserved = size(guidance(scoped) + privateBanks.map(({ index }) => index === null ? "" : renderFixedTiers(index).text).join("") + unavailable(privateBanks));
    lines = Math.max(lines, reserved.lines);
    bytes = Math.max(bytes, reserved.bytes);
  }
  return remaining({ lines: BANK_INDEX_BUDGET.lines - lines, bytes: BANK_INDEX_BUDGET.bytes - bytes }, unavailable(readings.filter(({ entry }) => entry.accounts === "all")));
};
const sharedText = (readings: readonly Reading[], repositoryIdentity: string | null): string => {
  const shared = readings.filter(({ entry }) => entry.accounts === "all");
  return renderTrail(indicesOf(shared), { registryPins: shared.flatMap(({ entry }) => entry.pins), repositoryIdentity, entities: false }, sharedBudget(readings)).text + unavailable(shared);
};
const renderSharedBanks = async (log: EventLog, repositoryIdentity: string | null): Promise<string> => sharedText(await readRepository(log, repositoryIdentity), repositoryIdentity);

/** Fill the composer's bank seam, with Claude's fixed public tiers in shared auto memory. */
export const bankInstructionsLayer = (log: EventLog, autoMemory?: AutoMemory): LayerSeam => async (scope) => {
  const reader = readerOf(log);
  const readings = await readRepository(log, scope.repositoryIdentity);
  const scoped = readings.filter(({ entry }) => bankInScope(entry, scope));
  const live = new Set(scoped.map(({ entry }) => entry.id));
  const relevance = {
    registryPins: scoped.flatMap(({ entry }) => entry.pins),
    repositoryIdentity: scope.repositoryIdentity,
    ...(scope.sessionId !== null && {
      sessionPins: sessionBankPins(reader, scope.sessionId),
      recentUse: recentBankUse(log, scope.sessionId, live),
      firstMessage: firstBankMessage(log, scope.sessionId),
    }),
  };
  const header = guidance(scoped);
  const claude = autoMemory !== undefined && liveAccount(reader, scope.accountId)?.provider === "claude";
  let text: string;
  if (claude) {
    const layers = renderBankLayers(indicesOf(scoped), new Set(scoped.filter(({ entry }) => entry.accounts === "all").map(({ entry }) => entry.name)), relevance, remaining(BANK_INDEX_BUDGET, header + unavailable(scoped)), sharedBudget(readings));
    // Render inside the shared Carry over queue, from the registry current when the write runs.
    await autoMemory.banks(scope, (identity) => renderSharedBanks(log, identity));
    text = layers.instructions.text + unavailable(scoped.filter(({ entry }) => entry.accounts !== "all"));
  } else text = renderTrail(indicesOf(scoped), relevance, remaining(BANK_INDEX_BUDGET, header + unavailable(scoped))).text + unavailable(scoped);
  if (scoped.length === 0) return [];
  return [{ id: "banks", version: null, title: "Memory banks", text: header + text }];
};

/** Refresh former as well as current repository scope; run composition joins the same auto-memory queue. */
export const connectBankMemory = (log: EventLog, autoMemory: AutoMemory): (() => Promise<void>) => {
  let pending = autoMemory.refreshBanks((identity) => renderSharedBanks(log, identity)).catch((error: unknown) => console.error("Rewriting memory bank blocks failed:", error));
  const unsubscribe = log.subscribe((event) => {
    if (!["bank.added", "bank.updated", "bank.forgotten", "bank.synced", "bank.landed", "bank.verified"].includes(event.type)) return;
    pending = autoMemory.refreshBanks((identity) => renderSharedBanks(log, identity)).catch((error: unknown) => console.error("Rewriting memory bank blocks failed:", error));
  });
  return async () => { unsubscribe(); await pending; };
};
