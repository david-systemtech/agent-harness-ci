import { BankReviewHeldPayload, BankDraftQueuedPayload, BankDraftsConsumedPayload } from "./memory-drafts.js";
import { z } from "zod";
import { AccountUpdatedPayload, SignIn, SignInExecutableChosenPayload } from "./accounts.js";
import {
  BankAddedPayload,
  BankAwaitingReviewPayload,
  BankForgottenPayload,
  BankLandedPayload,
  BankLandingFailedPayload,
  BankPinnedPayload,
  BankSyncedPayload,
  BankUpdatedPayload,
  BankVerifiedPayload,
} from "./bank-registry.js";
import { ChromeUpdatedPayload } from "./browser-chromes.js";
import { ExtensionSeenPayload } from "./browser-status.js";
import { CarryOverImportedPayload, CarryOverMemoryAssignedPayload } from "./carry-over.js";
import { ChecksChangedPayload, ChecksFailuresResetPayload } from "./checks.js";
import { ClientCallPayload } from "./client-calls.js";
import { StateImportFinishedPayload } from "./state-import.js";
import { EnvironmentColourSetPayload, EnvironmentIconSetPayload, EnvironmentRenamedPayload } from "./environment-look.js";
import { ProtocolVersion } from "./flags.js";
import { KnownEnvironmentsUpdatedPayload } from "./known-environments.js";
import {
  ForgeAccountAddedPayload,
  ForgeAccountCapabilityLearnedPayload,
  ForgeAccountGitRejectedPayload,
  ForgeAccountPrimarySetPayload,
  ForgeAccountRemovedPayload,
  ForgeAccountUpdatedPayload,
  ForgeAccountVerifiedPayload,
  ForgeOriginAnsweredPayload,
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
import { DenylistUpdatedPayload } from "./denylist.js";
import { ReviewUpdatedPayload } from "./permissions.js";
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
import { WebOriginsUpdatedPayload } from "./web/origin-policy.js";
import { StepResult } from "./setup.js";
import { SkillsUpdatedPayload } from "./skills.js";
import { TrustUpdatedPayload } from "./trust.js";
import { InstructionsUpdatedPayload } from "./instructions.js";
import { ChannelCheckedPayload, EnvironmentUpdatedPayload, UpdateCancelledPayload, UpdateFailedPayload, UpdatePendingPayload, UpdateStartedPayload } from "./updates.js";
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
  // A check of the release channel changed what updates.status shows of it (#1795): a client reads it again, and a
  // desktop checks its own build.
  "environment.channel-checked",
  // The environment's name, icon and colour (#323): a client redraws its badge.
  "environment.renamed",
  "environment.icon-set",
  "environment.colour-set",
  // The union of what client sessions report of their other connections changed (#382): the orientation block's other
  // environments section.
  "environment.known-environments-updated",
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
  // The denylist changed, and the Unattended review did: each on a stream no client follows whole (the access log, a
  // session's, the settings stream), so a client's cached answers of them wait on these (#811).
  "denylist.updated",
  "review.updated",
  // The ForgeService's own events, which its store is kept from (#310).
  "forge.account.added",
  "forge.account.updated",
  "forge.account.primary-set",
  "forge.account.verified",
  "forge.account.capability-learned",
  "forge.account.git-rejected",
  "forge.account.removed",
  "forge.origin-missing",
  "forge.origin-answered",
  // The BankService's own events, which the BankRegistry is kept from (#1025); bank.updated is also a notice a client
  // refreshes banks.list and banks.get on.
  "bank.added",
  "bank.review-held",
  "bank.draft-queued",
  "bank.drafts-consumed",
  "bank.updated",
  "bank.pinned",
  "bank.forgotten",
  "bank.synced",
  "bank.verified",
  "bank.landed",
  "bank.landing-failed",
  "bank.awaiting-review",
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
  "web.origins.updated",
  "setup.result-changed",
  "skills.updated",
  "trust.updated",
  "instructions.updated",
  // The Managed tools registry's notice (#373); an extension that holds no credential seen at the
  // listener (the Browser card's Load sub-step, #547); an import of an adopted account's directory
  // ended (Carry over's, #578); a memory folder no transcript maps assigned to a repository (#580).
  "tools.updated",
  "tool.run-started",
  "tool.run-finished",
  "extension.seen",
  "carry-over.imported",
  "carry-over.memory-assigned",
  // A state import ended (#581's contract, #94's build).
  "state-import.finished",
  // A Workspace directory's check command was set, changed or cleared (#1187): a client reads checks.get again.
  "checks.changed",
  "checks.failures-reset",
  // A worktree the environment made stayed, unlocked, when the last session naming it was purged
  // (the reaper's notice, which the client runtime raises, #330).
  "workspace.kept",
  // A paired Chrome paired, renamed or unpaired, connected or disconnected, or reporting another
  // extension version (#548).
  "chrome.updated",
  // A call addressed to the client session that started a run: a verb on a Chrome paired with another
  // environment, relayed through that client (#554).
  "client.call",
] as const;

/**
 * What each notice type tells a client, a line each, and a type without its
 * line is a type error (#799). `EnvironmentNoticeType` makes each gloss its
 * type's description, which the export writes on a line of its own beside the
 * type, so two changes that add notices in different places edit different
 * lines of the generated schema as well as of this file (#817). A new type's
 * line reads `"<type>": "<what it tells a client>."`.
 */
export const ENVIRONMENT_NOTICE_GLOSSES: { readonly [Type in (typeof ENVIRONMENT_NOTICE_TYPES)[number]]: string } = {
  "environment.started": "Startup finished.",
  "environment.updated": "A new harness version now runs.",
  "environment.draining": "New runs are refused before a restart.",
  "environment.update-pending": "An update waits for idle, the cap or a request.",
  "environment.update-started": "An update began its drain.",
  "environment.update-failed": "An update did not take, and the version it went from runs.",
  "environment.update-cancelled": "A pending update was withdrawn.",
  "environment.channel-checked": "A check of the release channel changed the newest or the last check updates.status shows; a client reads it again.",
  "environment.renamed": "The environment was renamed; a client redraws its badge.",
  "environment.icon-set": "The environment took another icon; a client redraws its badge.",
  "environment.colour-set": "The environment took another colour; a client redraws its badge.",
  "environment.known-environments-updated": "The union of the other environments client sessions report changed; a client reads instructions.list and instructions.preview again.",
  "account.updated": "An account changed; a client refreshes what it caches of the accounts.",
  "signin.updated": "The sign-in changed state: the verification URL, the end.",
  "signin.executable-chosen": "Which executable sign-ins run, recorded once.",
  "prompt.parked": "A run waits for a person's answer.",
  "prompt.resolved": "A parked prompt was answered.",
  "usage.updated": "An account's plan-usage reading changed; a client refreshes what it caches of the readings.",
  "denylist.updated": "The denylist changed; a client reads permissions.denylist.get and permissions.settings.get again.",
  "review.updated": "The Unattended review changed; a client reads permissions.review.list again.",
  "forge.account.added": "A forge account was added; a client refreshes what it caches of the forge accounts.",
  "forge.account.updated": "A forge account's slug, aliases or credential changed; a client refreshes what it caches of the forge accounts.",
  "forge.account.primary-set": "A forge account became the primary forge; a client refreshes what it caches of the forge accounts.",
  "forge.account.verified": "A verification of a forge account found something changed; a client refreshes what it caches of the forge accounts.",
  "forge.account.capability-learned": "An operation showed whether a forge account can do something; a client refreshes what it caches of the forge accounts.",
  "forge.account.git-rejected": "git refused a forge account's credential; a client refreshes what it caches of the forge accounts.",
  "forge.account.removed": "A forge account was removed; a client refreshes what it caches of the forge accounts.",
  "forge.origin-missing": "A harness operation was refused on an origin no forge account covers; a client refreshes what it caches of the forge accounts.",
  "forge.origin-answered": "An origin recorded as missing answered the operation it was refused, anonymously; a client withdraws the notice it raised for it.",
  "bank.drafts-consumed": "A landing consumed its queue snapshot; clients refresh banks.drafts.list.",
  "bank.review-held": "A validated bank change was held for review as an immutable snapshot.",
  "bank.draft-queued": "A session queued a validated draft or retirement; clients refresh banks.drafts.list.",
  "bank.added": "A bank was registered, created or joined; a client refreshes what it caches of the banks.",
  "bank.updated": "A bank's registry settings, sync status or what its BANK.md names changed; a client refreshes what it caches of the banks.",
  "bank.pinned": "A session pinned or unpinned a folder of a bank.",
  "bank.forgotten": "A bank left the registry; a client refreshes what it caches of the banks.",
  "bank.synced": "A sync moved a bank's checkout to a new head; a client refreshes what it caches of the banks.",
  "bank.verified": "A verification found a bank's status changed; a client refreshes what it caches of the banks.",
  "bank.landed": "Drafts landed on a bank's main; a client refreshes what it caches of the banks.",
  "bank.landing-failed": "A landing on a bank failed; a client refreshes what it caches of the banks.",
  "bank.awaiting-review": "A landing on a bank waits for an owner's review in a pull request; no bank's record changes.",
  "key-manager.connection.added": "A key-manager connection was added; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.signed-in": "A key-manager connection's sign-in ended; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.signed-out": "A key-manager connection was signed out; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.updated": "A key-manager connection's label, address, CA or token role changed; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.policies-set": "Which of a key-manager connection's policies runs receive was ticked; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.base-path-set": "Where Move keeps the harness's secrets on a key-manager connection was set; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.injected-set": "A key-manager connection became the one of its provider whose variables runs receive; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.verified": "A verification of a key-manager connection found something changed; a client refreshes what it caches of the key-manager connections.",
  "key-manager.connection.removed": "A key-manager connection was removed; a client refreshes what it caches of the key-manager connections.",
  "key-manager.moved": "An item's stored value was moved into a key manager.",
  "key-manager.stored-value-deleted": "A stored value a move left behind was deleted; a client refreshes what it caches of the items to move.",
  "key-manager.value-copied": "An item's stored value was answered once to a client session, to paste at a target the login cannot write.",
  "routine.updated": "A routine changed; a client refreshes its routines list.",
  "routine.delivered": "A routine's result, for every connected client.",
  "routine.delivery-failed": "A routine's result could not be delivered to its webhook.",
  "routine.endpoint-set": "A webhook endpoint was made or replaced; a client refreshes what it caches of the webhook endpoints.",
  "routine.endpoint-removed": "A webhook endpoint was removed; a client refreshes what it caches of the webhook endpoints.",
  "settings.changed": "Settings changed, with every settings.updated; a client refreshes what it caches of the settings.",
  "web.origins.updated": "Browser origins changed; every client refreshes web.origins.get.",
  "setup.result-changed": "A Set up step's result changed in anything but when it was checked; a client replaces that step's result in what the snapshot's setup gave it.",
  "skills.updated": "The skill set changed; a client reads skills.get again.",
  "trust.updated": "A trust decision was recorded or revoked; a client reads trust.get and trust.list again.",
  "instructions.updated": "An owned instruction changed; a client reads instructions.list and instructions.preview again.",
  "tools.updated": "The Managed tools registry's notice: a probe, or a latest version fetched, changed rows; a client refreshes what it caches of tools.list.",
  "tool.run-started": "A tool's install or update began in a tool terminal.",
  "tool.run-finished": "A tool's install or update in a tool terminal ended, with its exit code and verification.",
  "extension.seen": "An unpaired extension opened its socket to the listener; the Browser card ticks Load.",
  "carry-over.imported": "Carry over's notice: an import of an adopted account's directory ended, with its counts and what failed; a client reads carryOver.inventory again.",
  "carry-over.memory-assigned": "A memory folder no transcript maps was assigned to a repository and copied; a client reads carryOver.inventory again.",
  "state-import.finished": "A state import ended, with its report and what failed; a client reads stateImport.detect again.",
  "checks.failures-reset": "Clear stale failure-send offers in every Session of this canonical Workspace directory; a check passed or a manual check began.",
  "checks.changed": "A Workspace directory's check command was set, changed or cleared; a client reads checks.get again for its sessions in that directory.",
  "workspace.kept": "A worktree stayed, unlocked, when the last session naming it was purged; the client raises a notice naming it and why.",
  "chrome.updated": "A paired Chrome was paired, renamed or unpaired, connected, disconnected or reported another extension version; a client reads browser.chromes.list and browser.status again.",
  "client.call": "A call addressed to one client session, which answers it with client.answer before its deadline; every other client leaves it alone.",
};

/**
 * A notice-type schema from the types, in their order, and a gloss for each:
 * each type a literal its gloss describes, which the export writes as an
 * `anyOf` entry of its own, never one description naming every type (#817).
 */
export const environmentNoticeTypeOf = <const Type extends string>(types: readonly Type[], glosses: { readonly [T in Type]: string }) =>
  z.union(types.map((type) => z.literal(type).meta({ description: glosses[type] }))).meta({
    description: "An environment notice's event type, each type described by what it tells a client.",
  });

export const EnvironmentNoticeType = environmentNoticeTypeOf(ENVIRONMENT_NOTICE_TYPES, ENVIRONMENT_NOTICE_GLOSSES);
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

const EnvironmentChannelChecked = z
  .object({ type: z.literal("environment.channel-checked"), payload: ChannelCheckedPayload })
  .meta({ description: "A check of the release channel changed what updates.status shows of it: the newest found, or the last check's result or reason." });

const EnvironmentRenamed = z
  .object({ type: z.literal("environment.renamed"), payload: EnvironmentRenamedPayload })
  .meta({ description: "The environment was renamed: its new name, which every client's badge takes." });

const EnvironmentIconSet = z
  .object({ type: z.literal("environment.icon-set"), payload: EnvironmentIconSetPayload })
  .meta({ description: "The environment took another icon, which every client's badge takes." });

const EnvironmentColourSet = z
  .object({ type: z.literal("environment.colour-set"), payload: EnvironmentColourSetPayload })
  .meta({ description: "The environment took another colour, which every client's badge takes." });

const KnownEnvironmentsUpdated = z
  .object({ type: z.literal("environment.known-environments-updated"), payload: KnownEnvironmentsUpdatedPayload })
  .meta({ description: "The union of what client sessions report of their other connections changed: the union as it now is, what the orientation block's other environments section lists." });

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

const DenylistUpdated = describedNotice(
  "denylist.updated",
  DenylistUpdatedPayload,
  "The denylist changed through permissions.denylist.set or restorePresets, in the transaction of the access log's denylist.changed events: the sections that changed, whose entries and counts a client reads again.",
);
const ReviewUpdated = describedNotice(
  "review.updated",
  ReviewUpdatedPayload,
  "The Unattended review changed once something committed: a run it lists was decided in, it was seen, or a session holding runs it lists was deleted or restored; a client reads permissions.review.list again.",
);

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
const ForgeOriginAnswered = describedNotice("forge.origin-answered", ForgeOriginAnsweredPayload, "An origin recorded as missing answered the operation it was refused, anonymously.");
const BankAdded = describedNotice("bank.added", BankAddedPayload, "A bank was registered, created or joined: its registry entry, whole.");
const BankUpdated = describedNotice("bank.updated", BankUpdatedPayload, "A bank's registry settings, sync status or what its BANK.md names changed: the fields that changed.");
const BankPinned = describedNotice("bank.pinned", BankPinnedPayload, "A session pinned or unpinned a folder of a bank.");
const BankForgotten = describedNotice("bank.forgotten", BankForgottenPayload, "A bank left the registry, its checkout removed or kept.");
const BankSynced = describedNotice("bank.synced", BankSyncedPayload, "A sync moved a bank's checkout to a new head of main.");
const BankVerified = describedNotice("bank.verified", BankVerifiedPayload, "A verification found a bank's status changed, as system:banks.");
const BankLanded = describedNotice("bank.landed", BankLandedPayload, "Drafts landed on a bank's main.");
const BankLandingFailed = describedNotice("bank.landing-failed", BankLandingFailedPayload, "A landing on a bank failed at a step of the Lander.");
const BankAwaitingReview = describedNotice("bank.awaiting-review", BankAwaitingReviewPayload, "A landing on a bank waits for an owner's review in a pull request.");
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
const CarryOverMemoryAssigned = describedNotice(
  "carry-over.memory-assigned",
  CarryOverMemoryAssignedPayload,
  "A memory folder of an adopted account's directory that no transcript maps was assigned to a repository and copied into its auto memory, in the transaction of the assignment's receipt: the account, the repository, and what the copy did.",
);
const StateImportFinished = describedNotice(
  "state-import.finished",
  StateImportFinishedPayload,
  "A state import ended, in the transaction of what it carried: what it carried per kind, what must be entered again, what arrives in milestone 2, what never carries, and what failed.",
);
const ChecksFailuresReset = describedNotice("checks.failures-reset", ChecksFailuresResetPayload, "A manual check began or a check passed: clear failure-send offers in every Session of the canonical directory.");
const ChecksChanged = describedNotice(
  "checks.changed",
  ChecksChangedPayload,
  "A Workspace directory's check command was set, changed or cleared by the client session the event's actor names: the canonical directory and its command, null once cleared.",
);
const ChromeUpdated = describedNotice(
  "chrome.updated",
  ChromeUpdatedPayload,
  "A paired Chrome was paired, renamed or unpaired, connected or disconnected, or reported another extension version: which, its name and what changed.",
);

const ClientCall = describedNotice(
  "client.call",
  ClientCallPayload,
  "A call addressed to the client session that started a run: a verb on a Chrome paired with another environment, its arguments and its deadline, never its answer.",
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
    EnvironmentChannelChecked,
    EnvironmentRenamed,
    EnvironmentIconSet,
    EnvironmentColourSet,
    KnownEnvironmentsUpdated,
    AccountUpdated,
    SignInUpdated,
    SignInExecutableChosen,
    PromptParked,
    PromptResolved,
    UsageUpdated,
    DenylistUpdated,
    ReviewUpdated,
    ForgeAccountAdded,
    ForgeAccountUpdated,
    ForgeAccountPrimarySet,
    ForgeAccountVerified,
    ForgeAccountCapabilityLearned,
    ForgeAccountGitRejected,
    ForgeAccountRemoved,
    ForgeOriginMissing,
    ForgeOriginAnswered,
    describedNotice("bank.drafts-consumed", BankDraftsConsumedPayload, "A landing consumed the queued changes it verified on main."),
    describedNotice("bank.review-held", BankReviewHeldPayload, "A validated bank change waits for review with its submitted files."),
    describedNotice("bank.draft-queued", BankDraftQueuedPayload, "A session queued a validated draft or retirement for its bank."),
    BankAdded,
    BankUpdated,
    BankPinned,
    BankForgotten,
    BankSynced,
    BankVerified,
    BankLanded,
    BankLandingFailed,
    BankAwaitingReview,
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
    describedNotice("web.origins.updated", WebOriginsUpdatedPayload, "The browser origin lists changed; read web.origins.get again."),
    SetupResultChanged,
    SkillsUpdated,
    TrustUpdated,
    InstructionsUpdated,
    ToolsUpdated,
    ToolRunStarted,
    ToolRunFinished,
    ExtensionSeen,
    CarryOverImported,
    CarryOverMemoryAssigned,
    StateImportFinished,
    ChecksChanged,
    ChecksFailuresReset,
    WorkspaceKept,
    ChromeUpdated,
    ClientCall,
  ])
  .meta({
    description:
      "An event on the environment stream, as environment.subscribe delivers it: its type and payload, read from the event's envelope.",
  });
export type EnvironmentNotice = z.infer<typeof EnvironmentNotice>;
