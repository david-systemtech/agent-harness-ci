import { z } from "zod";
import { AccountUpdatedPayload, SignIn, SignInExecutableChosenPayload } from "./accounts.js";
import { ExtensionSeenPayload } from "./browser-status.js";
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
import { EnvironmentUpdatedPayload, UpdateCancelledPayload, UpdateFailedPayload, UpdatePendingPayload, UpdateStartedPayload } from "./updates.js";
import { UsageUpdatedPayload } from "./usage.js";

/**
 * The environment's own notices: the events on its `environment` stream,
 * which `environment.subscribe` delivers. The stream's id is the
 * environment's id. Each notice is read from an event's `type` and `payload`;
 * the rest of the envelope is the envelope's.
 */

/** The stream kind of the environment's notices; the stream id is the environment id. */
export const ENVIRONMENT_STREAM_KIND = "environment";

/**
 * The notices there are: the environment finished starting; it was updated
 * from one harness version to another (appended by the settle after the
 * restart, #344); it began to drain (appended by the lifecycle ticket,
 * #112); an update became pending, began, failed or was withdrawn (the
 * update coordinator: the launcher-update spec's notices, #335); it was
 * renamed, or took an icon or a colour (#323, whose three commands append
 * them, so every client redraws its badge); an account
 * changed (the account store, #134), appended once the change has committed;
 * the sign-in changed state, carrying the sign-in (the sign-in director,
 * #135); the executable sign-ins run was chosen, once per environment and
 * bundled binary (#135); a prompt parked, waiting for a person, and a parked
 * prompt was resolved (#130); an account's plan-usage reading changed
 * (#136); a forge account was added, updated, made primary, verified,
 * taught a capability, refused by git or removed, or an origin had no forge
 * account (#310: the ForgeService's own events, which its store is kept
 * from); a key-manager connection was added, signed in, signed out,
 * updated, had its policies ticked or its base path set, was verified with
 * something changed, or was removed (#365, #366, #371: the key-manager
 * connections' own events), an item's stored value was moved into a key
 * manager, or one a move left behind was deleted (#371), or an item's
 * stored value was copied to a client session to paste by hand (#372); a
 * routine changed, a routine's result was delivered to the clients or could
 * not be delivered to its webhook, or a webhook endpoint was set or removed
 * (#519: the routines' notices); settings changed, with every
 * `settings.updated` (#391); a Set up step's result changed from the one
 * its result cache held, carrying the result (#569: ADR 0031's `setup`
 * subscription); the skill set changed, by a command or a read that
 * found the own directory changed (#494); a trust decision was recorded or
 * revoked (#500); a probe, or a fetch of the latest versions, changed
 * managed-tool rows (#373, #374: the Managed tools registry's notice); an
 * extension that holds no credential opened its
 * socket to the environment's listener (#547: the Browser card's Load
 * sub-step); so every connected client
 * learns of it whatever else it is subscribed to.
 */
export const ENVIRONMENT_NOTICE_TYPES = [
  "environment.started",
  "environment.updated",
  "environment.draining",
  "environment.update-pending",
  "environment.update-started",
  "environment.update-failed",
  "environment.update-cancelled",
  // The environment's name, icon and colour (#323): a client redraws its badge.
  "environment.renamed",
  "environment.icon-set",
  "environment.colour-set",
  "account.updated",
  "signin.updated",
  "signin.executable-chosen",
  "prompt.parked",
  "prompt.resolved",
  "usage.updated",
  "forge.account.added",
  "forge.account.updated",
  "forge.account.primary-set",
  "forge.account.verified",
  "forge.account.capability-learned",
  "forge.account.git-rejected",
  "forge.account.removed",
  "forge.origin-missing",
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
  "routine.updated",
  "routine.delivered",
  "routine.delivery-failed",
  "routine.endpoint-set",
  "routine.endpoint-removed",
  "settings.changed",
  "setup.result-changed",
  "skills.updated",
  "trust.updated",
  "tools.updated",
  "extension.seen",
] as const;
export const EnvironmentNoticeType = z.enum(ENVIRONMENT_NOTICE_TYPES).meta({
  description:
    "An environment notice's event type: environment.started (startup finished), environment.updated (a new harness version now runs), environment.draining (new runs are refused before a restart), environment.update-pending (an update waits for idle, the cap or a request), environment.update-started (an update began its drain), environment.update-failed (an update did not take, and the version it went from runs), environment.update-cancelled (a pending update was withdrawn), account.updated (an account changed; a client refreshes what it caches of the accounts), signin.updated (the sign-in changed state: the verification URL, the end), signin.executable-chosen (which executable sign-ins run, recorded once), prompt.parked (a run waits for a person's answer), prompt.resolved (a parked prompt was answered), usage.updated (an account's plan-usage reading changed; a client refreshes what it caches of the readings), and the forge's: forge.account.added, forge.account.updated, forge.account.primary-set, forge.account.verified, forge.account.capability-learned, forge.account.git-rejected, forge.account.removed and forge.origin-missing (a client refreshes what it caches of the forge accounts), and the key managers': key-manager.connection.added, key-manager.connection.signed-in, key-manager.connection.signed-out, key-manager.connection.updated, key-manager.connection.policies-set, key-manager.connection.base-path-set, key-manager.connection.injected-set, key-manager.connection.verified and key-manager.connection.removed (a client refreshes what it caches of the key-manager connections), key-manager.moved (an item's stored value was moved into a key manager), key-manager.stored-value-deleted (a stored value a move left behind was deleted; a client refreshes what it caches of the items to move) and key-manager.value-copied (an item's stored value was answered once to a client session, to paste at a target the login cannot write), and the routines': routine.updated (a routine changed; a client refreshes its routines list), routine.delivered (a routine's result for every connected client), routine.delivery-failed (a routine's result could not be delivered to its webhook), routine.endpoint-set and routine.endpoint-removed (a client refreshes what it caches of the webhook endpoints), settings.changed (settings changed, with every settings.updated; a client refreshes what it caches of the settings), and setup.result-changed (a Set up step's result changed in anything but when it was checked; a client replaces that step's result in what the snapshot's setup gave it), skills.updated (the skill set changed; a client reads skills.get again), trust.updated (a trust decision was recorded or revoked; a client reads trust.get and trust.list again), the Managed tools registry's tools.updated (a probe, or a fetch of the latest versions, changed rows; a client refreshes what it caches of tools.list), and extension.seen (an unpaired extension opened its socket to the listener; the Browser card ticks Load).",
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
const ToolsUpdated = describedNotice("tools.updated", ToolsUpdatedPayload, "A probe of the managed tools, or a fetch of their latest versions, changed rows: those rows as they are now.");
const ExtensionSeen = describedNotice(
  "extension.seen",
  ExtensionSeenPayload,
  "An extension that holds no credential opened its socket to the environment's listener and announced itself: the unpaired signal, which ticks the Browser card's Load sub-step.",
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
    ToolsUpdated,
    ExtensionSeen,
  ])
  .meta({
    description:
      "An event on the environment stream, as environment.subscribe delivers it: its type and payload, read from the event's envelope.",
  });
export type EnvironmentNotice = z.infer<typeof EnvironmentNotice>;
