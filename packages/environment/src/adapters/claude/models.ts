import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCatalogue, ModelOption } from "../../adapter/contract.js";
import { CLAUDE_EFFORTS } from "./options.js";

/**
 * Claude's model catalogue (claude-adapter spec, "The adapter contract":
 * models with a family and an ordinal tier the adapter supplies). The live
 * listing is the
 * authoritative one, asked of the binary on an unsampled query; this static
 * list, aliases rather than dated ids, is what answers when that fails.
 * The family is read off the wire id, since a tier has to survive ids this
 * build has never seen; a family missing from the table ranks below every
 * known one rather than being guessed at.
 */

// The families the pinned 0.3.281 names as model aliases, Fable above Opus: `AgentDefinition.model` in its sdk.d.ts (line 56) lists
// 'fable', 'opus', 'sonnet' and 'haiku', with 'claude-fable-5' as a full id, and `Options.model` (line 1902) names 'claude-fable-5' too.
const FAMILY_TIERS: Readonly<Record<string, number>> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

/** The tier of a family nobody here can place. */
export const UNKNOWN_TIER = -1;

/** The family of a Claude model id: the vendor prefix, a dated snapshot and a bracketed variant stripped. */
export const claudeFamily = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/^claude-/, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .split("-")[0] ?? "";

export const claudeTier = (id: string): number => FAMILY_TIERS[claudeFamily(id)] ?? UNKNOWN_TIER;

const ALL_EFFORTS = [...CLAUDE_EFFORTS];

export const CLAUDE_STATIC_MODELS: readonly ModelOption[] = [
  { id: "fable", family: "fable", tier: 3, efforts: ALL_EFFORTS, label: "Fable" },
  { id: "opus", family: "opus", tier: 2, efforts: ALL_EFFORTS, label: "Opus" },
  { id: "sonnet", family: "sonnet", tier: 1, efforts: ALL_EFFORTS, label: "Sonnet" },
  { id: "haiku", family: "haiku", tier: 0, efforts: [], label: "Haiku" },
];

/** The static catalogue, flagged as such. */
export const staticCatalogue = (): ModelCatalogue => ({ live: false, models: CLAUDE_STATIC_MODELS });

/**
 * The binary's own list as the catalogue: its `default` row dropped, since
 * it names no model and so no cost or capability; the tier from the
 * resolved id, which always names a real family; the efforts the model
 * takes (none when it takes no effort setting). Empty answers the static list.
 */
export const catalogueOf = (infos: readonly ModelInfo[]): ModelCatalogue => {
  const models = infos
    .filter((info) => info.value !== "" && info.value !== "default" && !/^default\b/i.test(info.displayName))
    .map((info): ModelOption => {
      const wire = info.resolvedModel ?? info.value;
      return {
        id: info.value,
        family: claudeFamily(wire),
        tier: claudeTier(wire),
        efforts: info.supportsEffort === false ? [] : [...(info.supportedEffortLevels ?? CLAUDE_EFFORTS)],
        label: info.displayName.replace(/^Claude\s+/i, "").trim() || info.value,
      };
    });
  return models.length === 0 ? staticCatalogue() : { live: true, models };
};
