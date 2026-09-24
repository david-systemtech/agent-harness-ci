import type { CanUseTool, EffortLevel, HookCallback, McpServerConfig, Options, PermissionMode, SessionStore, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { RunInput } from "../../adapter/contract.js";
import { composeRunEnvironment, type HostEnvironment } from "./credentials.js";

/**
 * The options a Claude run is handed (claude-adapter spec, "The Claude
 * adapter, ported after the audit's fixes", options per run; ADR 0009, ADR
 * 0015, ADR 0018; permissions spec, the Claude mapping). Pure: the run's
 * input and what the process resolved for it (the bundled binary, the
 * account's plugin directory, the auto-memory directory, a worktree's
 * checkout, the store, a rewind's resume point) in, the SDK's `Options` out,
 * the environment among them. Everything here is a row a test asserts, since
 * a wrong one is silent: a stranger's hooks loading, a stray key billing a
 * subscription, a resume that depends on the working directory.
 */

/** The modes Claude maps, by the SDK's own names (ADR 0006); `default` and `dontAsk` are never offered. */
export const CLAUDE_MODES = ["acceptEdits", "plan", "auto", "bypassPermissions"] as const satisfies readonly PermissionMode[];
export type ClaudeMode = (typeof CLAUDE_MODES)[number];

/**
 * The mode of a run that names none. Chosen default: the unattended preset
 * and the permissions spec's own fallback, until the policy resolver (#129)
 * always hands a run its mode.
 */
export const DEFAULT_CLAUDE_MODE: ClaudeMode = "acceptEdits";

/** The reasoning efforts the SDK takes; a model the provider cannot run at one degrades it itself. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

/** Who the provider's User-Agent names. */
export const CLIENT_APP = "agent-harness";

/**
 * Where a truncating resume re-enters the stored chain: the last entry kept
 * and, when everything after it is one turn, that turn's prompt, which the
 * provider validates before dropping it (`history.ts`).
 */
export interface ResumePoint {
  readonly resumeSessionAt: string;
  readonly dropsTurn?: string;
}

export interface RunOptionsInput {
  readonly run: RunInput;
  /** The environment the process inherits from, before the scrub: the adapter's copy, taken once. */
  readonly hostEnv: HostEnvironment;
  /** The account's config directory, resolved: the ambient default for an account with none. */
  readonly configDirectory: string;
  /** The SDK's bundled binary; null leaves the SDK to find it itself. */
  readonly executablePath: string | null;
  /** The account's skill-set plugin directory (ADR 0009, ticket 89); null until it has one. */
  readonly pluginDirectory: string | null;
  /** The environment's auto-memory directory for the repository (ADR 0018); null to leave the CLI's own. */
  readonly autoMemoryDirectory: string | null;
  /** The checkout a worktree belongs to, whose project settings a trusted run takes; null for a plain checkout. */
  readonly checkoutRoot: string | null;
  /** The environment's SDK session store (#137); passed on every run once there is one. */
  readonly sessionStore: SessionStore | null;
  /** Where a fork from a message or a rewind re-enters the chain, resolved from the stored session. */
  readonly resumePoint: ResumePoint | null;
  /** The host's broker seam, through the process's permission table. */
  readonly canUseTool: CanUseTool;
  /** Called as each turn stops, with the session's scheduled jobs as the CLI lists them (`session_crons`). */
  readonly onStop?: HookCallback;
  /** The process's own spawn of the CLI, so a kill reaches the child; absent, the SDK spawns it. */
  readonly spawnProcess?: NonNullable<Options["spawnClaudeCodeProcess"]>;
  readonly abortController: AbortController;
  readonly stderr?: (data: string) => void;
}

/** The mode a run runs in: its own, or the default; anything outside the four is refused, never downgraded. */
export const claudeMode = (mode: string | null): ClaudeMode => {
  if (mode === null) return DEFAULT_CLAUDE_MODE;
  if ((CLAUDE_MODES as readonly string[]).includes(mode)) return mode as ClaudeMode;
  throw new Error(`Claude does not offer the mode ${mode}; it maps ${CLAUDE_MODES.join(", ")}.`);
};

/** The effort a run asks for, if any; one the SDK does not know is refused rather than dropped. */
export const claudeEffort = (effort: string | null): EffortLevel | null => {
  if (effort === null) return null;
  if ((CLAUDE_EFFORTS as readonly string[]).includes(effort)) return effort as EffortLevel;
  throw new Error(`Claude does not take the reasoning effort ${effort}; it takes ${CLAUDE_EFFORTS.join(", ")}.`);
};

/**
 * The `claude_code` preset, with the composed instructions appended (ADR
 * 0009). Never omitted: the SDK reads an absent system prompt as an empty
 * custom one and drops the preset, which is what describes the tools.
 */
const systemPrompt = (instructions: string): NonNullable<Options["systemPrompt"]> =>
  instructions.trim() === "" ? { type: "preset", preset: "claude_code" } : { type: "preset", preset: "claude_code", append: instructions };

/** The factory's tool servers as the SDK's MCP servers, by name; their configs are the factory's (`ToolServer.config`). */
const mcpServers = (run: RunInput): Record<string, McpServerConfig> | null => {
  if (run.toolServers.length === 0) return null;
  return Object.fromEntries(run.toolServers.map((server) => [server.name, server.config as McpServerConfig]));
};

/** What the run continues from, as the SDK's resume, fork and truncation options. */
const continuation = (run: RunInput, point: ResumePoint | null): Partial<Options> => {
  const target = run.target;
  switch (target.kind) {
    case "fresh":
      return {};
    case "resume":
      return { resume: target.providerSessionId };
    case "fork":
      if (target.atMessageId === null) return { resume: target.providerSessionId, forkSession: true };
      // A fork from a message that could not be placed must not become a fork of the whole session.
      if (point === null) throw new Error(`The fork from ${target.atMessageId} was not placed in the stored session.`);
      return { resume: target.providerSessionId, forkSession: true, resumeSessionAt: point.resumeSessionAt };
    case "rewind":
      // A rewind that could not be placed must not become a resume of the whole session.
      if (point === null) throw new Error(`The rewind to ${target.toMessageId} was not placed in the stored session.`);
      return {
        resume: target.providerSessionId,
        resumeSessionAt: point.resumeSessionAt,
        ...(point.dropsTurn !== undefined && { resumeDropsTurn: point.dropsTurn }),
      };
  }
};

export const buildRunOptions = (input: RunOptionsInput): Options => {
  const { run } = input;
  const mode = claudeMode(run.mode);
  const effort = claudeEffort(run.effort);
  const servers = mcpServers(run);
  const settingSources: SettingSource[] = run.trusted ? ["project"] : [];
  return {
    cwd: run.workspace.path,
    // Only for a trusted repository: an untrusted one loads nothing of its project, from the branch or from its checkout.
    ...(run.trusted && input.checkoutRoot !== null && { projectConfigRoot: input.checkoutRoot }),
    env: composeRunEnvironment(input.hostEnv, input.configDirectory, {
      // The harness session names the project directory, so the transcript is found whatever the working directory.
      CLAUDE_CODE_PROJECT_DIR_NAME: run.sessionId,
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    }),
    ...(input.executablePath !== null && { pathToClaudeCodeExecutable: input.executablePath }),
    abortController: input.abortController,
    ...(input.stderr !== undefined && { stderr: input.stderr }),
    model: run.model,
    ...(effort !== null && { effort }),
    permissionMode: mode,
    // The SDK's explicit opt-in, tied to the mode that needs it (#129 may tie it to the ceiling instead).
    // Only under a bypass ceiling (permissions spec, the Claude mapping): a change to bypass under a lower one is refused by the provider as well as clamped.
    ...(run.ceiling === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    permissionPrompts: "host",
    canUseTool: input.canUseTool,
    ...(input.onStop !== undefined && { hooks: { Stop: [{ hooks: [input.onStop] }] } }),
    ...(input.spawnProcess !== undefined && { spawnClaudeCodeProcess: input.spawnProcess }),
    systemPrompt: systemPrompt(run.instructions),
    settingSources,
    strictMcpConfig: true,
    ...(servers !== null && { mcpServers: servers }),
    ...(input.pluginDirectory !== null && { plugins: [{ type: "local", path: input.pluginDirectory }] }),
    ...(input.autoMemoryDirectory !== null && { settings: { autoMemoryDirectory: input.autoMemoryDirectory } }),
    ...(input.sessionStore !== null && { sessionStore: input.sessionStore }),
    ...continuation(run, input.resumePoint),
    includePartialMessages: true,
    // An SDK-driven CLI otherwise returns every thinking block empty; the transcript shows reasoning.
    extraArgs: { "thinking-display": "summarized" },
  };
};
