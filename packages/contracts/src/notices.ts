import { z } from "zod";
import { AccountUpdatedPayload, SignIn, SignInExecutableChosenPayload } from "./accounts.js";
import { ExtensionSeenPayload } from "./browser-status.js";
import { CarryOverImportedPayload } from "./carry-over.js";
import { StateImportFinishedPayload } from "./state-import.js";
import { EnvironmentColourSetPayload, EnvironmentIconSetPayload, EnvironmentRenamedPayload } from "./environment-look.js";
import { ProtocolVersion } from "./flags.js";
import {
  ForgeAccountAddedPayload,
  ForgeAccountCapabilityLearnedPayload,
  ForgeAccountGitRejectedPayload,
  ForgeAccountPrimarySetPayload,
  ForgeAccountRemovedPayload,
  ForgeAccountUpdatedPayload,
  ForgeAccountVerifiedPayload,
  ForgeOriginMissingPayload,
} from "./forge-accounts.js";
import {
  KeyManagerConnectionAddedPayload,
  KeyManagerConnectionBasePathSetPayload,
  KeyManagerConnectionInjectedSetPayload,
  KeyManagerConnectionPoliciesSetPayload,
  KeyManagerConnectionRemovedPayload,
  KeyManagerConnectionSignedInPayload,
  KeyManagerConnectionSignedOutPayload,
  KeyManagerConnectionUpdatedPayload,
  KeyManagerConnectionVerifiedPayload,
} from "./key-manager-connections.js";
import { KeyManagerMovedPayload, KeyManagerStoredValueDeletedPayload, KeyManagerValueCopiedPayload } from "./key-manager-moves.js";
import { DrainStarted } from "./lifecycle.js";
import { ToolRunFinishedPayload, ToolRunStartedPayload } from "./managed-tool-commands.js";
import { ToolsUpdatedPayload } from "./managed-tools.js";
import { DecidedBy, PromptDecisionValue, PromptKind, PROMPT_SUMMARY_MAX } from "./prompts.js";
import { RunId } from "./adapter.js";
import {
  RoutineDeliveredPayload,
  RoutineDeliveryFailedPayload,
  RoutineEndpointRemovedPayload,
  RoutineEndpointSetPayload,
  RoutineUpdatedPayload,
} from "./routines.js";
import { SessionId } from "./sessions.js";
import { SettingsChangedNoticePayload } from "./settings.js";
import { StepResult } from "./setup.js";
import { SkillsUpdatedPayload } from "./skills.js";
import { TrustUpdatedPayload } from "./trust.js";
import { InstructionsUpdatedPayload } from "./instructions.js";
import { EnvironmentUpdatedPayload, UpdateCancelledPayload, UpdateFailedPayload, UpdatePendingPayload, UpdateStartedPayload } from "./updates.js";
import { UsageUpdatedPayload } from "./usage.js";
import { WorkspaceKeptPayload } from "./workspaces.js";

/**
 * The environment's own notices: the events on its `environment` stream,
 * which `environment.subscribe` delivers. The stream's id is the
 * environment's id. Each notice is read from an event's `type` and `payload`;
 * the rest of the envelope is the envelope's.
 */

/** The stream kind of the environment's notices; the stream id is the environment id. */
export const ENVIRONMENT_STREAM_KIND = "environment";

/**
 * The notices there are, in the order the schema lists them, a comment above
 * each group naming the tickets that added it. Every one goes on the
 * environment stream, so every connected client learns of it whatever else it
 * is subscribed to; what each says is its line in `ENVIRONMENT_NOTICE_GLOSSES`.
 */
export const ENVIRONMENT_NOTICE_TYPES = [
  // The environment's start, its update to another version (appended by the settle after the
  // restart, #344) and its drain (appended by the lifecycle ticket, #112).
  "environment.started",
  "environment.updated",
  "environment.draining",
  // An update pending, begun, failed or withdrawn: the update coordinator's, the launcher-update
  // spec's notices (#335).
  "environment.update-pending",
  "environment.update-started",
  "environment.update-failed",
  "environment.update-cancelled",
  // The environment's name, icon and colour (#323): a client redraws its badge.
  "environment.renamed",
  "environment.icon-set",
  "environment.colour-set",
  // An account changed, appended by the account store once the change has committed (#134); the
  // sign-in's state and the executable its sign-ins run, chosen once per environment and bundled
  // binary (the sign-in director, #135).
  "account.updated",
  "signin.updated",
  "signin.executable-chosen",
  // A prompt parked, waiting for a person, and resolved (#130); an account's plan-usage reading
  // changed (#136).
  "prompt.parked",
  "prompt.resolved",
  "usage.updated",
  // The ForgeService's own events, which its store is kept from (#310).
  "forge.account.added",
  "forge.account.updated",
  "forge.account.primary-set",
  "forge.account.verified",
  "forge.account.capability-learned",
  "forge.account.git-rejected",
  "forge.account.removed",
  "forge.origin-missing",
  // The key-manager connections' own events (#365, #366, #371), Move's (#371) and a stored value
  // copied to paste by hand (#372).
  "key-manager.connection.added",
  "key-manager.connection.signed-in",
  "key-manager.connection.signed-out",
  "key-manager.connection.updated",
  "key-manager.connection.policies-set",
  "key-manager.connection.base-path-set",
  "key-manager.connection.injected-set",
  "key-manager.connection.verified",
  "key-manager.connection.removed",
  "key-manager.moved",
  "key-manager.stored-value-deleted",
  "key-manager.value-copied",
  // The routines' notices (#519).
  "routine.updated",
  "routine.delivered",
  "routine.delivery-failed",
  "routine.endpoint-set",
  "routine.endpoint-removed",
  // Settings changed, with every settings.updated (#391); a Set up step's result changed (ADR
  // 0031's setup subscription, #569); the skill set changed, by a command or a read that found the
  // own directory changed (#494); a trust decision recorded or revoked (#500); an owned instruction
  // changed (#505).
  "settings.changed",
  "setup.result-changed",
  "skills.updated",
  "trust.updated",
  "instructions.updated",
  // The Managed tools registry's notice (#373); an extension that holds no credential seen at the
  // listener (the Browser card's Load sub-step, #547); an import of an adopted account's directory
  // ended (Carry over's, #578).
  "tools.updated",
  "tool.run-started",
  "tool.run-finished",
  "extension.seen",
  "carry-over.imported",
  // A state import ended (#581's contract, #94's build).
  "state-import.finished",
  // A worktree the environment made stayed, unlocked, when the last session naming it was purged
  // (the reaper's notice, which the client runtime raises, #330).
  "workspace.kept",
] as const;

/**
 * `EnvironmentNoticeType`'s description, a line for each notice type, which
 * the description joins in `ENVIRONMENT_NOTICE_TYPES` order: the separator
 * before the type (none for the first), the type, and its gloss in brackets,
 * which the types of a group share at the group's last. A line each, so two
 * changes that add notices edit different lines rather than the one long
 * string (#799), and a type without its line is a type error. A new type's
 * line reads `, <type> (<gloss>)`.
 */
const ENVIRONMENT_NOTICE_GLOSSES: { readonly [Type in (typeof ENVIRONMENT_NOTICE_TYPES)[number]]: string } = {
  "environment.started": "environment.started (startup finished)",
  "environment.updated": ", environment.updated (a new harness version now runs)",
  "environment.draining": ", environment.draining (new runs are refused before a restart)",
  "environment.update-pending": ", environment.update-pending (an update waits for idle, the cap or a request)",
  "environment.update-started": ", environment.update-started (an update began its drain)",
  "environment.update-failed": ", environment.update-failed (an update did not take, and the version it went from runs)",
  "environment.update-cancelled": ", environment.update-cancelled (a pending update was withdrawn)",
  "environment.renamed": ", environment.renamed (the environment was renamed; a client redraws its badge)",
  "environment.icon-set": ", environment.icon-set (the environment took another icon; a client redraws its badge)",
  "environment.colour-set": ", environment.colour-set (the environment took another colour; a client redraws its badge)",
  "account.updated": ", account.updated (an account changed; a client refreshes what it caches of the accounts)",
  "signin.updated": ", signin.updated (the sign-in changed state: the verification URL, the end)",
  "signin.executable-chosen": ", signin.executable-chosen (which executable sign-ins run, recorded once)",
  "prompt.parked": ", prompt.parked (a run waits for a person's answer)",
  "prompt.resolved": ", prompt.resolved (a parked prompt was answered)",
  "usage.updated": ", usage.updated (an account's plan-usage reading changed; a client refreshes what it caches of the readings)",
  "forge.account.added": ", and the forge's: forge.account.added",
  "forge.account.updated": ", forge.account.updated",
  "forge.account.primary-set": ", forge.account.primary-set",
  "forge.account.verified": ", forge.account.verified",
  "forge.account.capability-learned": ", forge.account.capability-learned",
  "forge.account.git-rejected": ", forge.account.git-rejected",
  "forge.account.removed": ", forge.account.removed",
  "forge.origin-missing": " and forge.origin-missing (a client refreshes what it caches of the forge accounts)",
  "key-manager.connection.added": ", and the key managers': key-manager.connection.added",
  "key-manager.connection.signed-in": ", key-manager.connection.signed-in",
  "key-manager.connection.signed-out": ", key-manager.connection.signed-out",
  "key-manager.connection.updated": ", key-manager.connection.updated",
  "key-manager.connection.policies-set": ", key-manager.connection.policies-set",
  "key-manager.connection.base-path-set": ", key-manager.connection.base-path-set",
  "key-manager.connection.injected-set": ", key-manager.connection.injected-set",
  "key-manager.connection.verified": ", key-manager.connection.verified",
  "key-manager.connection.removed": " and key-manager.connection.removed (a client refreshes what it caches of the key-manager connections)",
  "key-manager.moved": ", key-manager.moved (an item's stored value was moved into a key manager)",
  "key-manager.stored-value-deleted": ", key-manager.stored-value-deleted (a stored value a move left behind was deleted; a client refreshes what it caches of the items to move)",
  "key-manager.value-copied": " and key-manager.value-copied (an item's stored value was answered once to a client session, to paste at a target the login cannot write)",
  "routine.updated": ", and the routines': routine.updated (a routine changed; a client refreshes its routines list)",
  "routine.delivered": ", routine.delivered (a routine's result for every connected client)",
  "routine.delivery-failed": ", routine.delivery-failed (a routine's result could not be delivered to its webhook)",
  "routine.endpoint-set": ", routine.endpoint-set",
  "routine.endpoint-removed": " and routine.endpoint-removed (a client refreshes what it caches of the webhook endpoints)",
  "settings.changed": ", settings.changed (settings changed, with every settings.updated; a client refreshes what it caches of the settings)",
  "setup.result-changed": ", and setup.result-changed (a Set up step's result changed in anything but when it was checked; a client replaces that step's result in what the snapshot's setup gave it)",
  "skills.updated": ", skills.updated (the skill set changed; a client reads skills.get again)",
  "trust.updated": ", trust.updated (a trust decision was recorded or revoked; a client reads trust.get and trust.list again)",
  "instructions.updated": ", instructions.updated (an owned instruction changed; a client reads instructions.list and instructions.preview again)",
  "tools.updated": ", the Managed tools registry's tools.updated (a probe, or a latest version fetched, changed rows; a client refreshes what it caches of tools.list)",
  "tool.run-started": ", tool.run-started",
  "tool.run-finished": " and tool.run-finished (a tool's install or update began in a tool terminal, and ended with its exit code and verification)",
  "extension.seen": ", extension.seen (an unpaired extension opened its socket to the listener; the Browser card ticks Load)",
  "carry-over.imported": ", Carry over's carry-over.imported (an import of an adopted account's directory ended, with its counts and what failed; a client reads carryOver.inventory again)",
  "state-import.finished": ", state-import.finished (a state import ended, with its report and what failed; a client reads stateImport.detect again)",
  "workspace.kept": ", workspace.kept (a worktree stayed, unlocked, when the last session naming it was purged; the client raises a notice naming it and why)",
};

export const EnvironmentNoticeType = z.enum(ENVIRONMENT_NOTICE_TYPES).meta({
  description: `An environment notice's event type: ${ENVIRONMENT_NOTICE_TYPES.map((type) => ENVIRONMENT_NOTICE_GLOSSES[type]).join("")}.`,
});
export type EnvironmentNoticeType = z.infer<typeof EnvironmentNoticeType>;

const EnvironmentStarted = z
  .object({
    type: z.literal("environment.started"),
    payload: z.object({
      harnessVersion: z.string().min(1).meta({ description: "The harness version that started." }),
      protocolVersion: ProtocolVersion,
    }),
  })
  .meta({ description: "The environment finished starting and accepts work: which version started." });

const EnvironmentUpdated = z
  .object({ type: z.literal("environment.updated"), payload: EnvironmentUpdatedPayload })
  .meta({ description: "The environment now runs another harness version: from which, to which, and by which update." });

const EnvironmentDraining = z
  .object({
    type: z.literal("environment.draining"),
    payload: DrainStarted,
  })
  .meta({ description: "The environment refuses new runs and lets running ones finish before a restart: since when, and what started it." });

const EnvironmentUpdatePending = z
  .object({ type: z.literal("environment.update-pending"), payload: UpdatePendingPayload })
  .meta({ description: "An update is pending: installed, it waits for idle, the deferral cap, or a request." });

const EnvironmentUpdateStarted = z
  .object({ type: z.literal("environment.update-started"), payload: UpdateStartedPayload })
  .meta({ description: "An update began its drain before the switch: from and to which version, and why now." });

const EnvironmentUpdateFailed = z
  .object({ type: z.literal("environment.update-failed"), payload: UpdateFailedPayload })
  .meta({ description: "An update did not take: the stage, the reason and whether it was rolled back; the version it went from runs." });

const EnvironmentUpdateCancelled = z
  .object({ type: z.literal("environment.update-cancelled"), payload: UpdateCancelledPayload })
  .meta({ description: "A pending update was withdrawn before its drain." });

const EnvironmentRenamed = z
  .object({ type: z.literal("environment.renamed"), payload: EnvironmentRenamedPayload })
  .meta({ description: "The environment was renamed: its new name, which every client's badge takes." });

const EnvironmentIconSet = z
  .object({ type: z.literal("environment.icon-set"), payload: EnvironmentIconSetPayload })
  .meta({ description: "The environment took another icon, which every client's badge takes." });

const EnvironmentColourSet = z
  .object({ type: z.literal("environment.colour-set"), payload: EnvironmentColourSetPayload })
  .meta({ description: "The environment took another colour, which every client's badge takes." });

const AccountUpdated = z
  .object({
    type: z.literal("account.updated"),
    payload: AccountUpdatedPayload,
  })
  .meta({ description: "An account changed: which, how, and a warning when something is wrong." });

const SignInUpdated = z
  .object({
    type: z.literal("signin.updated"),
    payload: SignIn,
  })
  .meta({ description: "The sign-in changed state: the sign-in as it is now, with the verification URL once it is awaiting a code." });

const SignInExecutableChosen = z
  .object({
    type: z.literal("signin.executable-chosen"),
    payload: SignInExecutableChosenPayload,
  })
  .meta({ description: "The environment chose the executable its sign-ins for a provider run: the bundled binary, or the managed tool when the bundled one does not run a sign-in." });

const PromptParked = z
  .object({
    type: z.literal("prompt.parked"),
    payload: z.object({
      sessionId: SessionId,
      runId: RunId,
      promptId: z.string().min(1),
      kind: PromptKind,
      title: z.string().min(1).meta({ description: "The session's title as the list shows it, for a notification." }),
      summary: z.string().min(1).max(PROMPT_SUMMARY_MAX).meta({ description: "The prompt's one-line summary." }),
    }),
  })
  .meta({ description: "A run is parked on a prompt, waiting for a person: which session, run and prompt, the session's title and what is asked." });

const PromptResolved = z
  .object({
    type: z.literal("prompt.resolved"),
    payload: z.object({
      sessionId: SessionId,
      runId: RunId,
      promptId: z.string().min(1),
      decision: PromptDecisionValue,
      decidedBy: DecidedBy,
    }),
  })
  .meta({ description: "A parked prompt was answered, by a person or a rule: which one, the decision, and who made it." });

const UsageUpdated = z
  .object({
    type: z.literal("usage.updated"),
    payload: UsageUpdatedPayload,
  })
  .meta({ description: "An account's plan-usage reading changed: which account, and the identity whose gauge it is." });

/** A forge, key-manager, routine or managed-tools event as a notice: its type and its payload, described. */
const describedNotice = <const T extends string, P extends z.ZodType>(type: T, payload: P, description: string) =>
  z.object({ type: z.literal(type), payload }).meta({ description });

const ForgeAccountAdded = describedNotice("forge.account.added", ForgeAccountAddedPayload, "A forge account was added: its origin, kind, slug, identity, credential source, primary flag and problem.");
const ForgeAccountUpdated = describedNotice("forge.account.updated", ForgeAccountUpdatedPayload, "A forge account's slug, aliases or credential changed.");
const ForgeAccountPrimarySet = describedNotice("forge.account.primary-set", ForgeAccountPrimarySetPayload, "A forge account became the primary forge, and the one that was is cleared.");
const ForgeAccountVerified = describedNotice("forge.account.verified", ForgeAccountVerifiedPayload, "A verification of a forge account found something changed.");
const ForgeAccountCapabilityLearned = describedNotice(
  "forge.account.capability-learned",
  ForgeAccountCapabilityLearnedPayload,
  "An operation showed whether a forge account can do something.",
);
const ForgeAccountGitRejected = describedNotice("forge.account.git-rejected", ForgeAccountGitRejectedPayload, "git refused a forge account's credential.");
const ForgeAccountRemoved = describedNotice("forge.account.removed", ForgeAccountRemovedPayload, "A forge account was removed.");
const ForgeOriginMissing = describedNotice("forge.origin-missing", ForgeOriginMissingPayload, "A harness operation was refused on an origin no forge account covers.");
const KeyManagerConnectionAdded = describedNotice(
  "key-manager.connection.added",
  KeyManagerConnectionAddedPayload,
  "A key-manager connection was added: its provider, label, address, settings and where its sign-in left it.",
);
const KeyManagerConnectionSignedIn = describedNotice("key-manager.connection.signed-in", KeyManagerConnectionSignedInPayload, "A key-manager connection's sign-in ended, and how.");
const KeyManagerConnectionSignedOut = describedNotice("key-manager.connection.signed-out", KeyManagerConnectionSignedOutPayload, "A key-manager connection was signed out, and awaits a sign-in.");
const KeyManagerConnectionUpdated = describedNotice("key-manager.connection.updated", KeyManagerConnectionUpdatedPayload, "A key-manager connection's label, address, CA or token role changed.");
const KeyManagerConnectionPoliciesSet = describedNotice(
  "key-manager.connection.policies-set",
  KeyManagerConnectionPoliciesSetPayload,
  "Which of a key-manager connection's policies runs receive was ticked.",
);
const KeyManagerConnectionVerified = describedNotice(
  "key-manager.connection.verified",
  KeyManagerConnectionVerifiedPayload,
  "A verification of a key-manager connection found its status, token information, policies or whether it can mint changed.",
);
const KeyManagerConnectionBasePathSet = describedNotice(
  "key-manager.connection.base-path-set",
  KeyManagerConnectionBasePathSetPayload,
  "Where Move keeps the harness's secrets on a key-manager connection was set.",
);
const KeyManagerConnectionInjectedSet = describedNotice(
  "key-manager.connection.injected-set",
  KeyManagerConnectionInjectedSetPayload,
  "Which key-manager connection of a provider runs receive the variables of was moved.",
);
const KeyManagerConnectionRemoved = describedNotice("key-manager.connection.removed", KeyManagerConnectionRemovedPayload, "A key-manager connection was removed.");
const KeyManagerMoved = describedNotice("key-manager.moved", KeyManagerMovedPayload, "An item's stored value was moved into a key manager, and the item swapped to the reference.");
const KeyManagerStoredValueDeleted = describedNotice(
  "key-manager.stored-value-deleted",
  KeyManagerStoredValueDeletedPayload,
  "A stored value a move left behind was deleted at a later start.",
);
const KeyManagerValueCopied = describedNotice(
  "key-manager.value-copied",
  KeyManagerValueCopiedPayload,
  "An item's stored value was answered once to a client session, to paste at a target the connection's login cannot write.",
);
const RoutineUpdated = describedNotice("routine.updated", RoutineUpdatedPayload, "A routine changed: which, and the record that changed it.");
const RoutineDelivered = describedNotice("routine.delivered", RoutineDeliveredPayload, "A routine's result for every connected client: the routine, the entry, its session, outcome, summary and body.");
const RoutineDeliveryFailed = describedNotice("routine.delivery-failed", RoutineDeliveryFailedPayload, "A routine's result could not be delivered to a webhook endpoint: which, and why.");
const RoutineEndpointSet = describedNotice("routine.endpoint-set", RoutineEndpointSetPayload, "A webhook endpoint was made or replaced: its name, URL and secret kind.");
const RoutineEndpointRemoved = describedNotice("routine.endpoint-removed", RoutineEndpointRemovedPayload, "A webhook endpoint was removed.");
const SettingsChanged = describedNotice(
  "settings.changed",
  SettingsChangedNoticePayload,
  "Settings changed on the environment, in the transaction of the settings.updated that changed them: the keys, whose values a client reads again.",
);
const SetupResultChanged = describedNotice(
  "setup.result-changed",
  StepResult,
  "A Set up step's check answered a result that differs from the one the environment's result cache held, in anything but when it was checked, or the step's first: the result, which replaces that step's in environment.subscribe's snapshot. A result that only refreshes when it was checked is not noticed.",
);
const SkillsUpdated = describedNotice(
  "skills.updated",
  SkillsUpdatedPayload,
  "The skill set changed: a command changed it, or a read found the own directory changed.",
);
const TrustUpdated = describedNotice(
  "trust.updated",
  TrustUpdatedPayload,
  "A trust decision was recorded or revoked, in the transaction of its trust event: a client reads trust.get and trust.list again.",
);
const InstructionsUpdated = describedNotice(
  "instructions.updated",
  InstructionsUpdatedPayload,
  "An owned instruction changed, in the transaction of its instructions event: a client reads instructions.list and instructions.preview again.",
);
const ToolsUpdated = describedNotice(
  "tools.updated",
  ToolsUpdatedPayload,
  "A probe of the managed tools, or a latest version fetched, changed rows: those rows as they are now.",
);
const ToolRunStarted = describedNotice("tool.run-started", ToolRunStartedPayload, "A client session began installing or updating a tool in a tool terminal (tools.run): the tool, the action, the method, the terminal and the command line.");
const ToolRunFinished = describedNotice(
  "tool.run-finished",
  ToolRunFinishedPayload,
  "A tool run ended: its exit code and why, once the tool was probed again and verified.",
);
const ExtensionSeen = describedNotice(
  "extension.seen",
  ExtensionSeenPayload,
  "An extension that holds no credential opened its socket to the environment's listener and announced itself: the unpaired signal, which ticks the Browser card's Load sub-step.",
);
const CarryOverImported = describedNotice(
  "carry-over.imported",
  CarryOverImportedPayload,
  "An import of an adopted account's directory ended, in the transaction of what it imported: the account, what it did with the sessions, and what failed.",
);
const StateImportFinished = describedNotice(
  "state-import.finished",
  StateImportFinishedPayload,
  "A state import ended, in the transaction of what it carried: what it carried per kind, what must be entered again, what arrives in milestone 2, what never carries, and what failed.",
);

const WorkspaceKept = describedNotice(
  "workspace.kept",
  WorkspaceKeptPayload,
  "A worktree the environment made stayed, unlocked, when the last session naming it was purged: its path, branch, the session's title and why.",
);

/**
 * One environment notice, as an event's `type` and `payload`. Parsing an
 * event envelope with it reads the notice and leaves the envelope's other
 * fields aside, so a client parses the `event` of an `event` frame directly.
 */
export const EnvironmentNotice = z
  .discriminatedUnion("type", [
    EnvironmentStarted,
    EnvironmentUpdated,
    EnvironmentDraining,
    EnvironmentUpdatePending,
    EnvironmentUpdateStarted,
    EnvironmentUpdateFailed,
    EnvironmentUpdateCancelled,
    EnvironmentRenamed,
    EnvironmentIconSet,
    EnvironmentColourSet,
    AccountUpdated,
    SignInUpdated,
    SignInExecutableChosen,
    PromptParked,
    PromptResolved,
    UsageUpdated,
    ForgeAccountAdded,
    ForgeAccountUpdated,
    ForgeAccountPrimarySet,
    ForgeAccountVerified,
    ForgeAccountCapabilityLearned,
    ForgeAccountGitRejected,
    ForgeAccountRemoved,
    ForgeOriginMissing,
    KeyManagerConnectionAdded,
    KeyManagerConnectionSignedIn,
    KeyManagerConnectionSignedOut,
    KeyManagerConnectionUpdated,
    KeyManagerConnectionPoliciesSet,
    KeyManagerConnectionBasePathSet,
    KeyManagerConnectionInjectedSet,
    KeyManagerConnectionVerified,
    KeyManagerConnectionRemoved,
    KeyManagerMoved,
    KeyManagerStoredValueDeleted,
    KeyManagerValueCopied,
    RoutineUpdated,
    RoutineDelivered,
    RoutineDeliveryFailed,
    RoutineEndpointSet,
    RoutineEndpointRemoved,
    SettingsChanged,
    SetupResultChanged,
    SkillsUpdated,
    TrustUpdated,
    InstructionsUpdated,
    ToolsUpdated,
    ToolRunStarted,
    ToolRunFinished,
    ExtensionSeen,
    CarryOverImported,
    StateImportFinished,
    WorkspaceKept,
  ])
  .meta({
    description:
      "An event on the environment stream, as environment.subscribe delivers it: its type and payload, read from the event's envelope.",
  });
export type EnvironmentNotice = z.infer<typeof EnvironmentNotice>;
