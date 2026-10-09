import type { ModelUsage } from "@agent-harness/contracts";

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** A result's `modelUsage` per model, as the CLI counts it: since its process started, not for the turn alone. */
export const readModelUsage = (raw: unknown): ModelUsage[] => {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).flatMap(([model, entry]): ModelUsage[] => {
    if (!isRecord(entry) || model === "") return [];
    const cost = entry["costUSD"];
    const window = entry["contextWindow"];
    return [
      {
        model,
        inputTokens: count(entry["inputTokens"]),
        outputTokens: count(entry["outputTokens"]),
        cacheReadTokens: count(entry["cacheReadInputTokens"]),
        cacheWriteTokens: count(entry["cacheCreationInputTokens"]),
        costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
        contextWindow: typeof window === "number" && Number.isInteger(window) && window > 0 ? window : null,
      },
    ];
  });
};

const TOKENS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/** What a model spent between two readings; the whole reading when the count started again (it went down). */
const since = (reading: ModelUsage, before: ModelUsage | undefined): ModelUsage => {
  if (before === undefined || TOKENS.some((key) => reading[key] < before[key]) || (reading.costUsd !== null && before.costUsd !== null && reading.costUsd < before.costUsd)) return reading;
  return {
    ...reading,
    inputTokens: reading.inputTokens - before.inputTokens,
    outputTokens: reading.outputTokens - before.outputTokens,
    cacheReadTokens: reading.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: reading.cacheWriteTokens - before.cacheWriteTokens,
    // A cost the reading before did not know cannot be split off this one.
    costUsd: reading.costUsd === null || before.costUsd === null ? null : reading.costUsd - before.costUsd,
  };
};

const spentNothing = (usage: ModelUsage): boolean => TOKENS.every((key) => usage[key] === 0) && !(usage.costUsd !== null && usage.costUsd > 0);

/**
 * The spend of one Claude process (#1949). The CLI is kept between runs, and
 * every result's `modelUsage` is its running total since it started, so a
 * turn's own spend is the difference from the reading before. The process
 * owns one, shared by its turns as the ledger is, and every result it hears
 * moves it, a turn's or not, so each request is counted once. A new process
 * has a new meter; a cold continuation seeds it with the saved ledger the CLI restores,
 * while a process with no saved spend counts from nothing.
 */
export class SpendMeter {
  readonly #last = new Map<string, ModelUsage>();

  /** A cold resume restores the provider's saved ledger before sampling; that spend belongs to earlier runs. */
  restore(modelUsage: unknown): void {
    for (const usage of readModelUsage(modelUsage)) this.#last.set(usage.model, usage);
  }

  /** A result message's reading, and its share: each model's spend since the reading before, a model that spent nothing left out. Null for any other message. */
  read(message: unknown): { readonly reading: ModelUsage[]; readonly share: ModelUsage[] } | null {
    if (!isRecord(message) || message["type"] !== "result") return null;
    const reading = readModelUsage(message["modelUsage"]);
    const share = reading.map((usage) => since(usage, this.#last.get(usage.model))).filter((usage) => !spentNothing(usage));
    for (const usage of reading) this.#last.set(usage.model, usage);
    return { reading, share };
  }
}
