import type { EnvironmentView, ParkedAsk } from "@agent-harness/client-runtime";
import type { PromptKind } from "@agent-harness/contracts";

/**
 * The parked-asks card as rows (docs/specs/tui.md, "Cards: permissions,
 * questions, parked asks"; carried from Artemis's `AsksCard.tsx` at
 * 443cf2e): every environment's parked prompts from `projections.runs`,
 * oldest first on one clock, each with its environment's badge, the
 * session's title, what it asks, and how long until its TTL denies it,
 * counted on its environment's clock (the runtime's countdown); a prompt
 * with no expiry shows none.
 *
 * Artemis's safety rules stand: nothing here is a default that authorises
 * (Enter opens the session), Esc decides nothing, and only a yes-or-no
 * answers in place: a `permission` or `denylist` row takes `y` and `n`, a
 * question or a plan can only be opened, since its answer is an option or a
 * mode. `a` and `N` answer every `permission` row at once behind a confirm,
 * and only when there are two or more; a `denylist` row is never among them
 * (a chosen default: allowing a call the denylist caught is one decision at
 * a time).
 */

/** A prompt's place in this terminal: its environment, its session (lowercased, as the runtime keys it) and its id. */
export const promptKey = (environmentId: string, sessionId: string, promptId: string): string => `${environmentId} ${sessionId.toLowerCase()} ${promptId}`;

export const askKey = (ask: Pick<ParkedAsk, "environmentId" | "sessionId" | "promptId">): string => promptKey(ask.environmentId, ask.sessionId, ask.promptId);

/** The environment badge (ADR 0005): two letters of its name, in a colour of its own or one of the terminal's by its place in the list. */
export interface Badge {
  readonly abbreviation: string;
  readonly colour: string;
}

const BADGE_COLOURS = ["cyan", "magenta", "yellow", "green", "blue", "red"] as const;

/** The first letters of its first two words, else its first two letters, in capitals; "this machine" for a name not known yet. */
export const abbreviationOf = (name: string | null): string => {
  const words = (name ?? "this machine").split(/[\s\-_.]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = (word: string) => [...word.toUpperCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const [first = "", second] = words;
  return second !== undefined ? `${letters(first)[0] ?? ""}${letters(second)[0] ?? ""}` : letters(first).slice(0, 2).join("");
};

export const badgeOf = (views: readonly EnvironmentView[], environmentId: string): Badge => {
  const at = Math.max(0, views.findIndex((view) => view.environmentId === environmentId));
  const view = views[at];
  return { abbreviation: abbreviationOf(view?.name ?? null) || "??", colour: view?.colour ?? BADGE_COLOURS[at % BADGE_COLOURS.length] ?? "cyan" };
};

/** How long a TTL has left, in words: hours and minutes, then minutes and seconds, then seconds; "expiring" at zero. */
export const ttlWords = (remainingMs: number): string => {
  if (remainingMs <= 0) return "expiring";
  const seconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s left`;
  return `${seconds}s left`;
};

/** Whether `y` and `n` answer the row in place: a yes-or-no prompt. */
export const decidable = (kind: PromptKind): boolean => kind === "permission" || kind === "denylist";

/** Whether `a` and `N` answer the row with the rest. */
export const inBulk = (kind: PromptKind): boolean => kind === "permission";

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
    detail: ask.kind === "question" ? (ask.prompt.questions?.[0]?.question ?? ask.summary) : ask.summary,
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
