import type { PromptKind } from "@agent-harness/contracts";
import type { ParkedAsk } from "../projections/runs.js";

/**
 * The parked asks as both renderers list them (docs/specs/tui.md, "Cards:
 * permissions, questions, parked asks"; docs/specs/gui.md, "Parked asks,
 * attention and notices"; #149): every environment's parked prompts from
 * `projections.runs`, oldest first, each saying what it asks. How the list
 * is drawn, and the keys or pointer that answer it, stay each renderer's.
 *
 * The safety rules stand: only a yes-or-no answers in place, so a
 * `permission` or `denylist` row is allowed or denied from the list, and a
 * question or a plan is only opened, since its answer is an option or a
 * mode. Allow all and Deny all answer every `permission` row at once behind
 * one confirmation, and only when there are two or more; a `denylist` row is
 * never among them (a chosen default: allowing a call the denylist caught is
 * one decision at a time).
 */

/** Whether a row is allowed or denied in place: a yes-or-no prompt. */
export const decidable = (kind: PromptKind): boolean => kind === "permission" || kind === "denylist";

/** Whether Allow all and Deny all answer the row with the rest. */
export const inBulk = (kind: PromptKind): boolean => kind === "permission";

/** The fewest rows Allow all and Deny all are offered for: with one, its own answer is the same thing. */
export const BULK_LEAST = 2;

/** The rows Allow all and Deny all would answer, in the list's order: none while fewer than `BULK_LEAST` are listed. */
export const bulkAsks = <Ask extends Pick<ParkedAsk, "kind">>(asks: readonly Ask[]): readonly Ask[] => {
  const bulk = asks.filter((ask) => inBulk(ask.kind));
  return bulk.length < BULK_LEAST ? [] : bulk;
};

/** The one question Allow all or Deny all asks before it answers `count` rows. */
export const bulkQuestion = (decision: "allow" | "deny", count: number): string =>
  decision === "allow" ? `Allow all ${count} permissions once?` : `Deny all ${count} permissions?`;

/** What a row asks: a question's first question, else the prompt's summary. */
export const askDetail = (ask: Pick<ParkedAsk, "kind" | "summary" | "prompt">): string =>
  ask.kind === "question" ? (ask.prompt.questions?.[0]?.question ?? ask.summary) : ask.summary;
