import { presetPermissionSettings, type AutoDecider, type ContainmentLevel, type Mode, type ModeAvailability, type PromptKind, type Workspace } from "@agent-harness/contracts";
import { UNPROBED_REPORT } from "../permissions/containment.js";
import { policySettings, resolvePolicy, type PolicyOutcome, type RunActor } from "../permissions/resolver.js";
import type { PromptDecision, ToolServer } from "./contract.js";

/**
 * The host's seams other workstreams fill (claude-adapter spec, "The adapter
 * contract", the paragraph on what the host supplies): the tool-server
 * factory, the instruction composer, the broker's automatic answers and the
 * policy resolver. Each has a preset that keeps a run going without its
 * workstream.
 */

/** What a run's tool servers close over: the account, the workspace and the session. */
export interface ToolServerScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly workspace: Workspace;
}

/**
 * Builds a run's tool servers (memory tools #90, the browser #93, the
 * completions surface's client tools #139). Preset: none.
 */
export type ToolServerFactory = (scope: ToolServerScope) => readonly ToolServer[];

export const noToolServers: ToolServerFactory = () => [];

/** What instructions are composed for: one run of one session. */
export interface InstructionScope {
  readonly sessionId: string;
  readonly accountId: string;
  readonly workspace: Workspace;
}

/**
 * Composes the instruction text every run is handed, once, on the
 * environment, whatever started the run (ADR 0009, ADR 0011). In phase A
 * only two layers exist: a session's own instructions and the orientation
 * block; the user, team-bank and project layers, a bot's persona and
 * always-on skills are #89's.
 */
export type InstructionComposer = (scope: InstructionScope) => string;

export interface InstructionLayers {
  /** A session's own standing instructions; preset: none, until a session carries them. */
  readonly sessionInstructions?: (sessionId: string) => string | null;
  /** The orientation block rendered from live state (ADR 0011); preset: the placeholder, empty until #91 renders it. */
  readonly orientationBlock?: (scope: InstructionScope) => string;
}

/** The orientation block's placeholder: nothing, so no run is handed text that says nothing (#91 renders it). */
export const orientationPlaceholder = (): string => "";

/** The phase-A composer: the orientation block, then the session's own instructions, each left out when empty. */
export const composeInstructions =
  (layers: InstructionLayers = {}): InstructionComposer =>
  (scope) =>
    [(layers.orientationBlock ?? orientationPlaceholder)(scope), layers.sessionInstructions?.(scope.sessionId) ?? null]
      .filter((part): part is string => part !== null && part.trim() !== "")
      .join("\n\n");

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
