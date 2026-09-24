import type { Workspace } from "@agent-harness/contracts";
import type { PermissionBroker, ToolServer } from "./contract.js";

/**
 * The host's seams other workstreams fill (claude-adapter spec, "The adapter
 * contract", the paragraph on what the host supplies): the tool-server
 * factory, the instruction composer, the permission broker and the mode
 * clamp. Each has a preset that keeps a run going without its workstream.
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

/**
 * The broker's placeholder: every prompt is denied at once, with a message
 * the model reads, and nothing is parked or recorded. #130's broker, which
 * parks prompts as events any client answers, replaces it.
 */
export const autoDenyBroker: PermissionBroker = {
  request: async () => ({
    decision: "deny",
    message: "This environment cannot ask anyone yet, so the request was denied; carry on without it.",
  }),
};

/** A mode after the clamp to the connection's ceiling (ADR 0006): the mode, and whether the clamp lowered it. */
export interface ClampedMode {
  readonly mode: string | null;
  readonly clamped: boolean;
}

/**
 * Clamps a requested mode to a connection's ceiling, never refusing it
 * (ADR 0006). #129 fills it with the mode order; preset: the identity, the
 * requested mode unchanged.
 */
export type ModeClamp = (requested: string | null, ceiling: string) => ClampedMode;

export const identityClamp: ModeClamp = (requested) => ({ mode: requested, clamped: false });
