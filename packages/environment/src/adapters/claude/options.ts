import type { RunSkillSet } from "@agent-harness/contracts";
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  McpServerConfig,
  Options,
  PermissionMode,
  SandboxSettings,
  SessionStore,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { isInProcess, type RunInput } from "../../adapter/contract.js";
import { GIT_PROGRAM_DENY_WRITE } from "../../permissions/git-program-paths.js";
import { composeRunEnvironment, type HostEnvironment } from "./credentials.js";
import { CLAUDE_FILE_TOOLS } from "./gate-access.js";
import { hostToolServer, serverRule } from "./host-tools.js";

/**
 * The options a Claude run is handed (claude-adapter spec, "The Claude
 * adapter, ported after the audit's fixes", options per run; ADR 0009, ADR
 * 0015, ADR 0018; permissions spec, the Claude mapping). Pure: the run's
 * input and what the process resolved for it (the bundled binary, the
 * auto-memory directory, a worktree's checkout, the store, a rewind's
 * resume point) in, the SDK's `Options` out,
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

/**
 * How long, in seconds, the CLI waits on the tool gate's `PreToolUse` hook
 * (and the file tools' capture after it, #1182) before it gives up on the
 * call: as long as its timer can hold. The CLI
 * arms `setTimeout(timeout * 1000)` for a callback hook (its own default is
 * ten minutes), and a JavaScript timer past 2^31 - 1 milliseconds fires at
 * once, so this is the longest wait there is: 24.8 days. A denylist prompt
 * the gate parks inside the hook waits for its TTL (a day by preset); one
 * whose TTL is longer, or `never`, is closed when this passes: the CLI
 * cancels the hook's request, the SDK aborts the gate's signal, and the
 * gate closes the prompt `cancelled` and denies the call (#132's note).
 */
export const GATE_HOOK_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** Who the provider's User-Agent names. */
export const CLIENT_APP = "agent-harness";

/**
 * Where a truncating resume re-enters the stored chain: the last entry kept
 * and, when everything after it is one turn, that turn's prompt, which the
 * provider validates before dropping it (`history.ts`). Or `passed`: the
 * stored session holds the anchor only on a branch its latest chain has
 * left, since a run after a rewind wrote a turn of its own and did not
 * complete (`sessions/fork-rewind.ts`, `pendingRewind`), so the run
 * continues the latest chain as it stands, which is what the harness's
 * transcript shows.
 */
export type ResumePoint = { readonly resumeSessionAt: string; readonly dropsTurn?: string } | { readonly passed: true };

export interface RunOptionsInput {
  readonly run: RunInput;
  /** The environment the process inherits from, before the scrub: the adapter's copy, taken once. */
  readonly hostEnv: HostEnvironment;
  /** What the run's process environment supplied this spawn (#307), layered over the scrubbed environment. */
  readonly supplied: Readonly<Record<string, string>>;
  /** The directories it supplied as the holder's own to write (#1119), which a contained run's commands may write beside its writable set. */
  readonly suppliedWritable: readonly string[];
  /** The account's config directory, resolved: the ambient default for an account with none. */
  readonly configDirectory: string;
  /** The SDK's bundled binary; null leaves the SDK to find it itself. */
  readonly executablePath: string | null;
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
  /** The tool gate, asked before the provider's own evaluation of every tool call (#140). */
  readonly preToolUse: HookCallback;
  /** The observation of the recognised file tools' calls (#1182), around what the gate lets through. */
  readonly fileTools: FileToolHooks;
  /** Called as each turn stops, with the session's scheduled jobs as the CLI lists them (`session_crons`). */
  readonly onStop?: HookCallback;
  /** Delivers allowed prompt notes after the matching tool succeeds or fails. */
  readonly onToolResult?: HookCallback;
  /** The process's own spawn of the CLI, so a kill reaches the child; absent, the SDK spawns it. */
  readonly spawnProcess?: NonNullable<Options["spawnClaudeCodeProcess"]>;
  readonly abortController: AbortController;
  readonly stderr?: (data: string) => void;
}

/**
 * The process's observation of the recognised file tools' calls
 * (`file-tools.ts`; switch-over spec, "File undo"), as SDK callbacks:
 * `before`, asked in the run's one `PreToolUse` callback once the gate has
 * let a call through, which the CLI waits on before it evaluates the call and
 * runs it; `completed`, the `PostToolUse` of a file tool's call that
 * succeeded; `failed`, its `PostToolUseFailure`. What they answer is never
 * the hook's answer: an observation decides nothing about a call.
 */
export interface FileToolHooks {
  readonly before: HookCallback;
  readonly completed: HookCallback;
  readonly failed: HookCallback;
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

/**
 * The factory's tool servers as the SDK's MCP servers, by name: a configured
 * server's config is the factory's (`ToolServer.config`); an in-process
 * server's tools are served by an in-process MCP server (`host-tools.ts`).
 */
const mcpServers = (run: RunInput): Record<string, McpServerConfig> | null => {
  if (run.toolServers.length === 0) return null;
  return Object.fromEntries(run.toolServers.map((server) => [server.name, isInProcess(server) ? hostToolServer(server) : (server.config as McpServerConfig)]));
};

/**
 * The permission rules that let an external in-process server's tools go
 * ahead without asking (#139): a completions caller runs its own tools, so a
 * call to one touches nothing here, and a prompt nobody present could answer
 * would deny it on every unattended run.
 */
const allowedTools = (run: RunInput): string[] => run.toolServers.filter((server) => isInProcess(server) && server.external).map((server) => serverRule(server.name));

/** The recognised file tools as a hook matcher: the pinned CLI reads a list of plain names joined by `|` as those exact tools. */
const FILE_TOOL_MATCHER = CLAUDE_FILE_TOOLS.join("|");

/** Whether a `PreToolUse` answer denies the call. */
const deniesCall = (output: HookJSONOutput): boolean =>
  "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse" && output.hookSpecificOutput.permissionDecision === "deny";

/**
 * The gate, then, for a call it did not deny, the file tools' observation,
 * as one callback answering the gate's answer: the CLI runs an event's
 * callbacks in parallel, so an observer registered beside the gate would see
 * calls the gate denies and could not wait for it to rule.
 */
const gatedThenObserved =
  (gate: HookCallback, observe: HookCallback): HookCallback =>
  async (hookInput, toolUseID, options) => {
    const ruling = await gate(hookInput, toolUseID, options);
    if (deniesCall(ruling)) return ruling;
    await observe(hookInput, toolUseID, options);
    return ruling;
  };

/**
 * The run's hooks: one `PreToolUse`, matching every tool (no matcher) and
 * waiting as long as the CLI can, which is the tool gate and then the file
 * tools' observation of a call it let through; the file tools' `PostToolUse`
 * and `PostToolUseFailure`, matching those tools alone; a prompt-note
 * callback on every tool result when supplied; and the process's `Stop`
 * when it has one.
 */
const hooksOf = (input: Pick<RunOptionsInput, "preToolUse" | "fileTools" | "onStop" | "onToolResult">): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
  PreToolUse: [{ hooks: [gatedThenObserved(input.preToolUse, input.fileTools.before)], timeout: GATE_HOOK_TIMEOUT_SECONDS }],
  PostToolUse: [{ matcher: FILE_TOOL_MATCHER, hooks: [input.fileTools.completed] }, ...(input.onToolResult === undefined ? [] : [{ hooks: [input.onToolResult] }])],
  PostToolUseFailure: [{ matcher: FILE_TOOL_MATCHER, hooks: [input.fileTools.failed] }, ...(input.onToolResult === undefined ? [] : [{ hooks: [input.onToolResult] }])],
  ...(input.onStop !== undefined && { Stop: [{ hooks: [input.onStop] }] }),
});

/**
 * The shell side of the run's containment, as the SDK's sandbox
 * (permissions spec, "Enforcement for Claude"): none at `off`; at both
 * workspace levels enabled, failing the run rather than running a command
 * unsandboxed, with no way for the model to ask its way out
 * (`allowUnsandboxedCommands`) and no approval for being sandboxed
 * (`autoAllowBashIfSandboxed`: containment changes where a command may
 * reach, never whether it asks). A command may write in the run's writable
 * set (the workspace is the CLI's working directory already) and in the
 * directories the spawn was supplied as its holder's own (a key-manager
 * CLI's configuration directory, #1119), less what the run may not write
 * inside them (`denyWrite`, which the sandbox puts above `allowWrite`: the
 * repository git directory's hooks and config, #791, plus recursive git
 * program paths under Seatbelt, #1094). The
 * network is open at `workspace`, local binding included; the pinned
 * sandbox cannot name "any domain", so it asks the host about each new
 * host, which the adapter answers itself once the gate lets the host
 * through (`process.ts`, #140's verify note). At `workspace-no-network` it
 * is closed: no domain, no unix socket, no local binding, and a host
 * outside the (empty) list is refused without asking. On an unattended run
 * the denylist's paths are unreadable to a command, the directories the
 * denylist leaves out read again.
 */
export const sandboxOf = (run: Pick<RunInput, "containment" | "denylist">, suppliedWritable: readonly string[]): SandboxSettings | null => {
  const { containment, denylist } = run;
  if (containment.level === "off") return null;
  const denyRead = denylist?.paths ?? [];
  const allowRead = denyRead.length > 0 ? (denylist?.exempt ?? []) : [];
  const denyWrite = [...containment.readOnly, ...(containment.mechanism === "seatbelt" ? GIT_PROGRAM_DENY_WRITE : [])];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    network: containment.network
      ? { allowLocalBinding: true }
      : { allowedDomains: [], strictAllowlist: true, allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: {
      allowWrite: [...containment.writable, ...suppliedWritable],
      ...(denyWrite.length > 0 && { denyWrite }),
      ...(denyRead.length > 0 && { denyRead: [...denyRead] }),
      ...(allowRead.length > 0 && { allowRead: [...allowRead] }),
    },
  };
};

/**
 * What of its repository's project a run, or a listing of what a run would
 * offer, loads (ADR 0009, ADR 0015): under trust the `project` source, and
 * for a workspace in a linked worktree its main checkout as
 * `projectConfigRoot`, so project settings, hooks and the `.claude` trees,
 * native skills among them, come from that checkout (#998); untrusted,
 * nothing of the project, from the branch or from its checkout.
 */
export const projectOptions = (trusted: boolean, checkoutRoot: string | null): Pick<Options, "settingSources" | "projectConfigRoot"> => ({
  settingSources: trusted ? ["project"] : [],
  ...(trusted && checkoutRoot !== null && { projectConfigRoot: checkoutRoot }),
});

/**
 * The run's skill set as the SDK's plugins (ADR 0009): its generation as
 * the one local plugin, whose skills the CLI offers as
 * `agent-harness:<name>`; none without a generation.
 */
export const skillPlugins = (skillSet: RunSkillSet): NonNullable<Options["plugins"]> =>
  skillSet.generation === null ? [] : [{ type: "local", path: skillSet.generation }];

/**
 * The flag settings a run is handed, the layer the CLI reads before the
 * project's (whose own values it ignores for these, for security) and the
 * user's: the auto-memory directory, and each native name to hide switched
 * `off` in `skillOverrides`, which hides a project skill or command from
 * the model and from `/name` and leaves a plugin's skills alone (#495's
 * verify note). Null when there is neither.
 */
export const flagSettings = (autoMemoryDirectory: string | null, skillSet: RunSkillSet): Settings | null => {
  const hidden = skillSet.hiddenNativeNames;
  if (autoMemoryDirectory === null && hidden.length === 0) return null;
  return {
    ...(autoMemoryDirectory !== null && { autoMemoryDirectory }),
    ...(hidden.length > 0 && { skillOverrides: Object.fromEntries(hidden.map((name) => [name, "off" as const])) }),
  };
};

/** A rule's content as the CLI reads it back (`Tool(content)`): its backslashes and brackets escaped. */
const ruleContent = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

/**
 * The denylist's command patterns as the CLI's disallowed shell rules, on
 * an unattended run only: `Bash(<pattern>)`, its white space made single
 * spaces. A deny rule from the command line holds in every mode, bypass
 * included. The CLI matches a rule against each sub-command from its start,
 * where the gate matches a pattern anywhere in the line: the gate asks
 * first, and these catch what it could not read.
 */
export const disallowedShell = (denylist: RunInput["denylist"]): string[] =>
  (denylist?.commandPatterns ?? []).map((pattern) => `Bash(${ruleContent(pattern.trim().split(/\s+/).join(" "))})`);

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
      if ("passed" in point) return { resume: target.providerSessionId, forkSession: true };
      return { resume: target.providerSessionId, forkSession: true, resumeSessionAt: point.resumeSessionAt };
    case "rewind":
      // A rewind that could not be placed must not become a resume of the whole session.
      if (point === null) throw new Error(`The rewind to ${target.toMessageId} was not placed in the stored session.`);
      if ("passed" in point) return { resume: target.providerSessionId };
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
  const allowed = allowedTools(run);
  const sandbox = sandboxOf(run, input.suppliedWritable);
  const disallowedTools = disallowedShell(run.denylist);
  const plugins = skillPlugins(run.skillSet);
  const settings = flagSettings(input.autoMemoryDirectory, run.skillSet);
  const env = composeRunEnvironment(input.hostEnv, input.configDirectory, {
    // The harness session names the project directory, so the transcript is found whatever the working directory, and
    // the session store keys every entry by it (the SDK takes it as the project key beside CLAUDE_CONFIG_DIR, #137).
    CLAUDE_CODE_PROJECT_DIR_NAME: run.sessionId,
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
  }, input.supplied);
  return {
    cwd: run.workspace.path,
    ...(run.additionalDirectories !== undefined && run.additionalDirectories.length > 0 && { additionalDirectories: [...run.additionalDirectories] }),
    ...projectOptions(run.trusted, input.checkoutRoot),
    env,
    ...(input.executablePath !== null && { pathToClaudeCodeExecutable: input.executablePath }),
    abortController: input.abortController,
    ...(input.stderr !== undefined && { stderr: input.stderr }),
    model: run.model,
    ...(effort !== null && { effort }),
    permissionMode: mode,
    // The SDK's explicit opt-in, only under a bypass ceiling (permissions spec, the Claude mapping): a change to bypass under a
    // lower one is refused by the provider as well as clamped. With a fresh config directory it is enough on its own (#140).
    ...(run.ceiling === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    permissionPrompts: "host",
    canUseTool: input.canUseTool,
    hooks: hooksOf(input),
    ...(sandbox !== null && { sandbox }),
    ...(disallowedTools.length > 0 && { disallowedTools }),
    ...(input.spawnProcess !== undefined && { spawnClaudeCodeProcess: input.spawnProcess }),
    systemPrompt: systemPrompt(run.instructions),
    strictMcpConfig: true,
    ...(servers !== null && { mcpServers: servers }),
    ...(allowed.length > 0 && { allowedTools: allowed }),
    ...(plugins.length > 0 && { plugins }),
    ...(settings !== null && { settings }),
    // The store mirrors successful local writes; disabling persistence would disable resume from the store (#622).
    // Tool image copies follow these local transcripts and are removed by deleteTranscript when the purge asks for it.
    persistSession: true,
    ...(input.sessionStore !== null && { sessionStore: input.sessionStore }),
    ...continuation(run, input.resumePoint),
    includePartialMessages: true,
    promptSuggestions: true,
    // An SDK-driven CLI otherwise returns every thinking block empty; the transcript shows reasoning.
    extraArgs: { "thinking-display": "summarized" },
  };
};
