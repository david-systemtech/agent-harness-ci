import type { SessionEventType } from "./event-types.js";
import type { CommandMethodName } from "./registry.js";
import type { SessionSummary } from "./sessions.js";

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
 * elsewhere: every organisation command moves `updatedAt`, a pin moves
 * `settledOverride` through the companion events, a run's start moves the
 * filing fields through its own (unarchive, unsettle, wake, the `active`
 * override cleared) and a run's end wakes, a sync moves `pullRequests`, a
 * generated title (`session.title-generated`, from the first user message,
 * a fork's source or the provider) moves `title` and `titleSource`, a
 * fork, a rewind and `runs.withdraw` write `draft` (#137, #228), and
 * `sessions.setWorkspace` gives a missing session another `workspace` and
 * `repositoryIdentity` and clears `workspaceMissingSince` (#328).
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
  // Place (ADR 0005): written by the creating command, and again only by sessions.setWorkspace while the workspace is missing;
  // the missing mark is the availability watcher's (workspace-picker spec).
  workspace: { command: "sessions.create" },
  repositoryIdentity: { command: "sessions.create" },
  workspaceMissingSince: { event: "session.workspace-status-changed" },
  // Activity: the adapter's run events (#119) and the permissions workstream's prompt events (#130).
  activity: { event: "run.started" },
  parkedPromptCount: { event: "prompt.opened" },
  accountId: { event: "run.started" },
  model: { event: "run.started" },
  // The model and effort the next run goes out on (#1961): a person's choice; each run's start writes the model and effort it took.
  runChoice: { command: "sessions.setModel" },
  // Mode: the permissions workstream's command (#129); `sessions.create` records the first value.
  mode: { command: "permissions.mode.set" },
  // Browser (browser spec): `sessions.create` records the first value; the agent's answer to the several-Chromes question writes it too.
  browser: { command: "sessions.setBrowser" },
  // Forge (ADR 0012): the forge workstream's events.
  pullRequests: { event: "session.pull-request-linked" },
  // Composer: an absolute setter, which a client's outbox coalesces.
  draft: { command: "sessions.setDraft" },
} as const satisfies { readonly [K in keyof SessionSummary]-?: SummaryFieldOwner };
