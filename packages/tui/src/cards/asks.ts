import { askDetail, ttlWords, type EnvironmentView, type ParkedAsk } from "@agent-harness/client-runtime";
import { UNLISTED_BADGE, badgesOf, type Badge } from "../rail/badge.js";

/**
 * The parked-asks card as rows (docs/specs/tui.md, "Cards: permissions,
 * questions, parked asks"): every environment's parked prompts from
 * `projections.runs`, oldest first on one clock, each with its
 * environment's badge, the session's title, what it asks, and how long
 * until its TTL denies it, counted on its environment's clock (the
 * runtime's countdown); a prompt with no expiry shows none.
 *
 * Which rows answer in place (`decidable`: `y` and `n`), which `a` and `N`
 * answer at once behind a confirm (`bulkAsks`: permissions only, two or
 * more), and what a row asks (`askDetail`) are the client runtime's, which
 * the desktop window's Parked asks view reads too. Enter opens the session,
 * and Esc decides nothing.
 */

/** A prompt's place in this terminal: its environment, its session (lowercased, as the runtime keys it) and its id. */
export const promptKey = (environmentId: string, sessionId: string, promptId: string): string => `${environmentId} ${sessionId.toLowerCase()} ${promptId}`;

export const askKey = (ask: Pick<ParkedAsk, "environmentId" | "sessionId" | "promptId">): string => promptKey(ask.environmentId, ask.sessionId, ask.promptId);

/** An environment's badge, the rail's (`rail/badge.ts`), so it has the same two letters here; one not listed wears none of another's. */
export const badgeOf = (views: readonly EnvironmentView[], environmentId: string): Badge =>
  badgesOf(views).get(environmentId) ?? UNLISTED_BADGE;

/** One row, as the card draws it. */
export interface AskRow {
  readonly key: string;
  readonly ask: ParkedAsk;
  readonly badge: Badge;
  readonly title: string;
  /** The session on screen behind the card. */
  readonly here: boolean;
  /** `question`, `plan` or `denylist`: the word before what it asks; empty for a permission. */
  readonly kindWord: string;
  /** What it asks: a question's question, else the prompt's summary. */
  readonly detail: string;
  readonly ttl: string | undefined;
}

export const askRows = (
  asks: readonly ParkedAsk[],
  views: readonly EnvironmentView[],
  open: { readonly environmentId: string; readonly sessionId: string } | null,
): readonly AskRow[] =>
  asks.map((ask) => ({
    key: askKey(ask),
    ask,
    badge: badgeOf(views, ask.environmentId),
    title: ask.title ?? "a session",
    here: open !== null && open.environmentId === ask.environmentId && open.sessionId.toLowerCase() === ask.sessionId.toLowerCase(),
    kindWord: ask.kind === "permission" ? "" : ask.kind,
    detail: askDetail(ask),
    ttl: ask.ttl === null ? undefined : ttlWords(ask.ttl.remainingMs),
  }));

/** The card's heading, which has to survive the list draining to one. */
export const asksHeading = (count: number): string => (count === 1 ? "1 prompt is waiting on you" : `${count} prompts are waiting on you`);

/** The sessions the asks are parked on, each once, in the asks' order. */
export const parkedSessions = (asks: readonly ParkedAsk[]): readonly { readonly environmentId: string; readonly sessionId: string }[] => {
  const seen = new Set<string>();
  return asks.flatMap((ask) => {
    const key = `${ask.environmentId} ${ask.sessionId.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ environmentId: ask.environmentId, sessionId: ask.sessionId }];
  });
};
