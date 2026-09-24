import type { CommandMethodName } from "./registry.js";
import type { SessionEventType, SessionSummary } from "./sessions.js";

/**
 * Who owns a summary field: the command a user sets it with (a command-kind
 * registry entry, so a query or a stream does not compile here), or, for a
 * field only the system writes (the run and prompt events, the forge's
 * pull-request events), the `list`-flagged event type that writes it.
 */
export type SummaryFieldOwner = { readonly command: CommandMethodName } | { readonly event: SessionEventType };

/**
 * The field table (session-state spec, "The contract test and the lint";
 * ADR 0003): every key of the session summary and its owner. The contract
 * test fails when a key of the summary is missing here, a named command is
 * not in the registry or is not a command, or a named event type is not
 * `list`-flagged, so a session field with no command and no event cannot be
 * added.
 *
 * The table is ownership, not the complete list of writers. An owner is the
 * first writer of its field, the one a user (or, for a system field, the
 * system) sets it with; later commands and events also write fields owned
 * elsewhere: every organisation command moves `updatedAt`, a pin or a run
 * start moves `settledOverride` through the companion events, a sync moves
 * `pullRequests`, a generated title moves `title` and `titleSource`.
 */
export const SUMMARY_FIELD_OWNERS = {
  // Identity: born with the session; updatedAt then moves with every organisation command.
  id: { command: "sessions.create" },
  createdAt: { command: "sessions.create" },
  updatedAt: { command: "sessions.create" },
  lastActivityAt: { event: "run.started" },
  // Title: the user's; the generated title and the default are its fallbacks.
  title: { command: "sessions.rename" },
  titleSource: { command: "sessions.rename" },
  // Filing.
  archivedAt: { command: "sessions.archive" },
  pinnedAt: { command: "sessions.pin" },
  pinOrderKey: { command: "sessions.reorderPinned" },
  activeOrderKey: { command: "sessions.reorderActive" },
  tags: { command: "sessions.tag" },
  groupId: { command: "sessions.setGroup" },
  // Shelf.
  settledAt: { command: "sessions.settle" },
  settledOverride: { command: "sessions.settle" },
  settledBy: { command: "sessions.settle" },
  unsettledAt: { command: "sessions.unsettle" },
  snoozedUntil: { command: "sessions.snooze" },
  snoozedAt: { command: "sessions.snooze" },
  // Place (ADR 0005): written once, by the creating command.
  workspace: { command: "sessions.create" },
  repositoryIdentity: { command: "sessions.create" },
  // Activity: the adapter's run events (#119) and the permissions workstream's prompt events (#130).
  activity: { event: "run.started" },
  parkedPromptCount: { event: "prompt.opened" },
  accountId: { event: "run.started" },
  model: { event: "run.started" },
  // Forge (ADR 0012): the forge workstream's events.
  pullRequests: { event: "session.pull-request-linked" },
} as const satisfies { readonly [K in keyof SessionSummary]-?: SummaryFieldOwner };
