import {
  EMPTY_RUN_SKILL_SET,
  presetPermissionSettings,
  type AutoDecider,
  type ContainmentLevel,
  type InstructionChannel,
  type InstructionLayer,
  type InstructionManifest,
  type JsonObject,
  type Mode,
  type ModeAvailability,
  type NativeSkillRoot,
  type PromptKind,
  type RunActorKind,
  type RunSkillSet,
  type SessionBrowser,
  type TrustState,
  type Workspace,
} from "@agent-harness/contracts";
import { UNPROBED_REPORT } from "../permissions/containment.js";
import { repositoryKey, type RepositoryKey, type RepositoryPlace } from "../workspace/repository-key.js";
import type { InjectionDecision } from "./process-environment.js";
import { policySettings, resolvePolicy, type PolicyOutcome, type RunActor } from "../permissions/resolver.js";
import type { GateDecision, GatedToolCall, PromptDecision, PromptDetail, RunContainment, ToolServer } from "./contract.js";
import type { ToolDecider } from "@agent-harness/contracts";

/**
 * The host's seams other workstreams fill (claude-adapter spec, "The adapter
 * contract", the paragraph on what the host supplies): the tool-server
 * factory, the instruction composer, the skill set, the broker's automatic
 * answers and the policy resolver. Each has a preset that keeps a run going
 * without its workstream (the composer's is `instructions/composer.ts`).
 */

/**
 * A tool a completions request declared for its run (#139, client-tool
 * passthrough): the caller runs it, and the run hands each call back to the
 * caller. Its name, what it does, and its parameters as the JSON Schema
 * object the caller wrote.
 */
export interface ClientTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/**
 * What a run's tool servers close over: the account, the workspace with its
 * session's repository identity, the session, the tools its request
 * declared for the caller to run, and its browser.
 */
export interface ToolServerScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly workspace: Workspace;
  /**
   * The session's repository identity as it was resolved when the run was planned (workspace-picker spec), the
   * repository's for a worktree and never a path; null when the session has none. The memory tools' repository
   * scope reads it (banks spec, "The seams"; #1022).
   */
  readonly repositoryIdentity: string | null;
  /** A completions request's own tools (#139), or those of the run before a run of the queue; empty for none. */
  readonly clientTools: readonly ClientTool[];
  /** The browser the run resolved at its start (#550), whose kind's verbs the `browser` server offers (#551); none for none. */
  readonly browser: SessionBrowser;
}

/**
 * Builds a run's tool servers (memory tools #90, the browser #93, the
 * completions surface's client tools #139, which the environment always
 * adds after this seam's). Preset: none.
 */
export type ToolServerFactory = (scope: ToolServerScope) => readonly ToolServer[];

export const noToolServers: ToolServerFactory = () => [];

/**
 * A repository's trust key (skills spec, "The trust gate"): its repository
 * key (`workspace/repository-key.ts`), the session's repository identity,
 * else its repository's main checkout, else its workspace path, on the
 * canonical host of a verified forge alias; a scratch workspace has none.
 */
export type TrustKey = RepositoryKey;

/** A run's trust as it is launched and its instructions composed under it: the key, null for a scratch workspace, and the decision recorded for it. */
export interface RunTrust {
  readonly key: TrustKey | null;
  readonly decision: TrustState;
}

/**
 * The trust a run in a place goes under, read once as it launches (#500):
 * the trust store's key and the decision recorded for it, which the run's
 * `trusted` and its instruction scope both take. The environment's is the
 * trust store (`trust/store.ts`); preset: the key, and no decision.
 */
export type TrustSeam = (place: RepositoryPlace) => RunTrust;

export const undecidedTrust: TrustSeam = (place) => ({ key: repositoryKey(place), decision: "undecided" });

/**
 * What a skill set is resolved for (skills spec, "Materialisation and the
 * Claude mapping"): the run's session (null for a preview of a session not
 * yet made), its account and workspace, its trust, and the roots the
 * account's adapter loads itself under trust, whose members are native. A
 * commands listing is resolved as its session's next run would be (#503).
 */
export interface SkillSetScope {
  readonly sessionId: string | null;
  readonly accountId: string;
  readonly workspace: Workspace;
  readonly trust: RunTrust;
  readonly nativeRoots: readonly NativeSkillRoot[];
}

/**
 * Resolves the skill set a run is handed and a commands listing is made
 * under (ADR 0009), at each run's start, before its instructions are
 * composed, and at each listing: the environment's is `skills/run-skill-set.ts`
 * (#496), from the account, the trust, the choices and the layers, over
 * the materialiser. Preset: the empty set, with no fingerprint.
 */
export type SkillSetSeam = (scope: SkillSetScope) => Promise<RunSkillSet>;

export const noSkillSet: SkillSetSeam = async () => EMPTY_RUN_SKILL_SET;

/**
 * Holds a skill set's generation while a provider process uses it (#496):
 * asked as each spawn of a run's process is supplied, and as each commands
 * listing is made, its answer called once the pool lets that process go or
 * the listing has answered, so the materialiser's sweep keeps the
 * generation meanwhile. The environment's is the materialiser's hold
 * (`skills/generations.ts`); preset: nothing held.
 */
export type GenerationHold = (generation: string) => () => void;

export const holdNothing: GenerationHold = () => () => undefined;

/**
 * What a run's standing instructions are composed for (skills spec, "The
 * seam grows"): its session (null for a preview of a session not yet
 * made), account and workspace with its session's repository identity
 * (banks spec, "The seams"), its trust key and decision, who started it,
 * its effective containment level and its injection answer with the level
 * that decided it (#380), the bot it is for, the always-on names it asks for
 * beside its account's, the instruction channel of its account's adapter
 * with whether that adapter loads a trusted repository's own instructions
 * itself (#500), and the skill set resolved for it (#496).
 */
export interface InstructionScope {
  readonly sessionId: string | null;
  readonly accountId: string;
  readonly workspace: Workspace;
  /**
   * The session's repository identity as it was resolved (workspace-picker spec), the repository's for a worktree
   * and never a path; null for a session without one, and for a preview of a session not yet made, whose identity is
   * read when it is made. The bank layer's repository scope reads it (banks spec, "The seams"; #1022).
   */
  readonly repositoryIdentity: string | null;
  readonly trust: RunTrust;
  /** The run's skill set, resolved before its instructions are composed: the manifest carries its fingerprint. */
  readonly skillSet: RunSkillSet;
  /** Who started the run: a client, a routine, a bot or the completions surface. */
  readonly origin: RunActorKind;
  /** The run's effective containment level, its policy's: what the orientation block's environment section states. */
  readonly containment: ContainmentLevel;
  /** The run's injection answer, with the level that decided it: the one its process environment is built under (#380). */
  readonly injection: InjectionDecision;
  /** The bot the run is for: null in milestone 1, the Bot object being milestone 2's (#92). */
  readonly bot: null;
  /** The run's extra always-on names, after its account's: held in memory and inherited by runs of the queue (#507). */
  readonly alwaysOn: readonly string[];
  readonly channel: InstructionChannel;
  /** Whether the account's adapter loads a trusted repository's own instruction files itself; without it the project layer hands them over. */
  readonly nativeProjectInstructions: boolean;
}

/** One part of a composed text: its layer, what it is (an id and its version), its title, and its text. */
export interface InstructionPart {
  readonly layer: InstructionLayer;
  readonly id: string;
  readonly version: string | null;
  readonly title: string;
  readonly text: string;
}

/** A composition: the text a run is handed, its parts in the order the text holds them, and its manifest. */
export interface ComposedInstructions {
  readonly text: string;
  readonly parts: readonly InstructionPart[];
  readonly manifest: InstructionManifest;
}

/**
 * Composes the instruction text every run is handed, once, on the
 * environment, whatever started the run (ADR 0009, ADR 0011): the layers
 * in their fixed order, from state alone and never a clock, so unchanged
 * state gives the same text byte for byte. It answers asynchronously, and a
 * run's launch awaits it before its adapter's `createRun`. The environment's
 * is `instructions/composer.ts`.
 */
export type InstructionComposer = (scope: InstructionScope) => Promise<ComposedInstructions>;

/** A prompt as the broker's automatic rules read it: its kind, and the run's attendance and mode when it asked. */
export interface AutoAnswerRequest {
  readonly kind: PromptKind;
  readonly attended: boolean;
  readonly mode: Mode;
}

/** An answer a rule gives at once: which rule, and the decision the run is handed. */
export interface AutoAnswer {
  readonly auto: AutoDecider;
  readonly decision: PromptDecision;
}

/**
 * The broker's automatic branches (permissions spec, the prompt state
 * machine): a rule that answers a prompt at once, recorded as its
 * `prompt.answered` in the transaction of its `prompt.opened`, so it never
 * parks and no notice is raised; null parks the prompt for a person. The
 * environment fills it with the unattended and bypass rules
 * (`permissions/auto-answer.ts`, #131; a reviewer's is milestone 2's); the
 * TTL's sweeper answers parked prompts later, and `run_ended` is the host's
 * own. Preset: no rule, every prompt parks.
 */
export type PromptAutoAnswer = (request: AutoAnswerRequest) => AutoAnswer | null;

export const noAutoAnswer: PromptAutoAnswer = () => null;

/** What a run's policy is resolved from, beside the settings: who started it, the mode asked for, the account's modes, and the session's own containment level. */
export interface PolicyRequest {
  readonly actor: RunActor;
  /** The mode the run or its session asks for; null when neither names one. */
  readonly requested: Mode | null;
  readonly accountModes: readonly ModeAvailability[];
  /** The containment level the session set for itself; null when it set none, and the default applies. */
  readonly containment: ContainmentLevel | null;
}

/**
 * Resolves a run's policy at its start (#129, `permissions/resolver.ts`):
 * the mode clamped to the ceiling and the account's modes, never refused
 * for being above them, and the containment level lowered to what can be
 * enforced (#133). The environment's reads the permission settings and its
 * probe's findings; preset: the resolver on the settings' presets, with
 * nothing probed, so every run is at `off`.
 */
export type PolicySeam = (request: PolicyRequest) => PolicyOutcome;

export const presetPolicy: PolicySeam = ({ actor, requested, accountModes, containment }) =>
  resolvePolicy({
    actor,
    requested,
    ceiling: actor.ceiling,
    accountModes,
    settings: policySettings(presetPermissionSettings()),
    containment,
    enforceable: UNPROBED_REPORT,
  });

/** A run as the tool gate's rules see it: its ids, the directory its relative paths are read against, and its person. */
export interface RuledRun {
  readonly runId: string;
  readonly sessionId: string;
  /** The run's workspace: a relative path in a call is read against it. */
  readonly workspace: string;
  /** The run's containment, as its adapter was handed it (#133). */
  readonly containment: RunContainment;
  /**
   * Asks through the broker, as the run's own prompt: recorded as
   * `prompt.opened`, parked for a person on an attended run, answered at once
   * by the broker's automatic rules otherwise (#131); the answer, whoever
   * gives it, settles the ask. The host hands the answer to the gate and
   * never to the adapter, which did not raise the prompt. A request the
   * broker denies at once (the run has ended, the provider has given up on
   * the call, the log refuses the prompt) opens none, and is answered deny
   * with what the model is told.
   */
  ask(kind: PromptKind, detail: PromptDetail, signal?: AbortSignal): Promise<PromptDecision>;
}

/**
 * One rule of the tool gate (`RunContext.gate`): a deny is final and ends
 * the ruling, and the rules after it are not asked; an allow or null passes
 * the call on to the next rule, and past the last to the provider's own
 * evaluation. A rule that throws denies the call (the gate fails closed).
 * A rule records nothing itself: the gate records a denial the rule made
 * without asking anyone as the call's `tool.decision` by the rule's
 * `decider` (a throw's too), through #131's `recordToolDecision`, which
 * leaves a call decided already as it is; a denial through `ask` is the
 * prompt's answer's to record (or, when a stop denied it in memory, the
 * prompt stays open for a later answer, ADR 0007), and one the broker gave
 * before any prompt opened is the gate's (`createToolGate`). The
 * environment's rule is the denylist's (#132, `permissions/denylist-gate.ts`);
 * containment's hard denials come first (#133). Preset: none, every call
 * goes on to the provider.
 */
export interface ToolGateRule {
  /** What decided a call this rule denied, or could not rule on. */
  readonly decider: ToolDecider;
  check(call: GatedToolCall, run: RuledRun, signal?: AbortSignal): GateDecision | null | Promise<GateDecision | null>;
}
