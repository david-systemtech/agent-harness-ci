import type { CanUseTool, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { RunInput, RunTarget } from "../../adapter/contract.js";
import { CLAUDE_STRIPPED_VARIABLES } from "./credentials.js";
import { CLAUDE_MODES, buildRunOptions, type RunOptionsInput } from "./options.js";

/**
 * The options table (claude-adapter spec, "The Claude adapter, ported after
 * the audit's fixes", options per run; permissions spec, the Claude
 * mapping): every row asserted on the pure builder, since a wrong row is
 * silent and expensive (a project's hooks loading untrusted, a stray key
 * billing a subscription, a resume that depends on the directory).
 */

const SESSION_ID = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";

const store: SessionStore = {
  append: async () => undefined,
  load: async () => null,
};

const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: "no" });

const run = (overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION_ID,
  runId: "0b8f5c1e-2d3a-4b6c-8e9f-0a1b2c3d4e5f",
  account: { id: "work", directory: "/data/accounts/work" },
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: "git.example/david/repo",
  model: "opus",
  effort: "high",
  mode: "acceptEdits",
  instructions: "Orientation.\n\nThe session's own instructions.",
  target: { kind: "fresh" },
  toolServers: [],
  trusted: false,
  prompt: [{ messageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", text: "Go", attachments: [] }],
  ...overrides,
});

const input = (overrides: Partial<RunInput> = {}, extra: Partial<RunOptionsInput> = {}): RunOptionsInput => ({
  run: run(overrides),
  hostEnv: { PATH: "/usr/bin", HOME: "/home/david", ANTHROPIC_API_KEY: "sk-ant-shell", IS_SANDBOX: "1", CLAUDE_CODE_BUBBLEWRAP: "1" },
  configDirectory: "/data/accounts/work",
  executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
  pluginDirectory: "/data/skills/work",
  autoMemoryDirectory: "/data/auto-memory/repo",
  checkoutRoot: null,
  sessionStore: store,
  resumePoint: null,
  canUseTool,
  abortController: new AbortController(),
  ...extra,
});

describe("the options a run is handed", () => {
  it("runs in the workspace, with the model and effort asked for", () => {
    const options = buildRunOptions(input());
    expect(options.cwd).toBe("/work/repo");
    expect(options.model).toBe("opus");
    expect(options.effort).toBe("high");
    expect(options).not.toHaveProperty("projectConfigRoot");
  });

  it("takes a trusted repository's project settings from the checkout a worktree belongs to, and an untrusted one's from nowhere", () => {
    expect(buildRunOptions(input({ trusted: true }, { checkoutRoot: "/work/repo-main" })).projectConfigRoot).toBe("/work/repo-main");
    expect(buildRunOptions(input({ trusted: false }, { checkoutRoot: "/work/repo-main" }))).not.toHaveProperty("projectConfigRoot");
  });

  it("leaves the effort to the model when none is asked for, and refuses one the SDK does not know", () => {
    expect(buildRunOptions(input({ effort: null }))).not.toHaveProperty("effort");
    expect(() => buildRunOptions(input({ effort: "ludicrous" }))).toThrow(/effort/);
  });

  it.each(CLAUDE_MODES)("passes the mode %s by the same name, prompts answered by the host", (mode) => {
    const options = buildRunOptions(input({ mode }));
    expect(options.permissionMode).toBe(mode);
    expect(options.permissionPrompts).toBe("host");
    if (mode === "bypassPermissions") expect(options.allowDangerouslySkipPermissions).toBe(true);
    else expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("offers acceptEdits, plan, auto and bypassPermissions, and never default or dontAsk", () => {
    expect([...CLAUDE_MODES]).toEqual(["acceptEdits", "plan", "auto", "bypassPermissions"]);
    expect(() => buildRunOptions(input({ mode: "default" }))).toThrow(/mode/);
    expect(() => buildRunOptions(input({ mode: "dontAsk" }))).toThrow(/mode/);
  });

  it("runs a run with no mode of its own in acceptEdits", () => {
    expect(buildRunOptions(input({ mode: null })).permissionMode).toBe("acceptEdits");
  });

  it("keeps the claude_code preset and appends the composed instructions", () => {
    expect(buildRunOptions(input()).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Orientation.\n\nThe session's own instructions.",
    });
  });

  it("keeps the preset, and appends nothing, when there are no instructions", () => {
    expect(buildRunOptions(input({ instructions: "  " })).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("loads the project's settings only when the repository passed the trust gate, and never user or local", () => {
    expect(buildRunOptions(input({ trusted: true })).settingSources).toEqual(["project"]);
    expect(buildRunOptions(input({ trusted: false })).settingSources).toEqual([]);
  });

  it("runs only the factory's tool servers", () => {
    const options = buildRunOptions(input({ toolServers: [{ name: "memory", config: { type: "sdk", name: "memory" } }] }));
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({ memory: { type: "sdk", name: "memory" } });
    const none = buildRunOptions(input());
    expect(none.strictMcpConfig).toBe(true);
    expect(none).not.toHaveProperty("mcpServers");
  });

  it("hands the account's skill-set plugin directory over as a local plugin", () => {
    expect(buildRunOptions(input()).plugins).toEqual([{ type: "local", path: "/data/skills/work" }]);
    expect(buildRunOptions(input({}, { pluginDirectory: null }))).not.toHaveProperty("plugins");
  });

  it("points auto memory at the environment's directory for the repository", () => {
    expect(buildRunOptions(input()).settings).toEqual({ autoMemoryDirectory: "/data/auto-memory/repo" });
    expect(buildRunOptions(input({}, { autoMemoryDirectory: null }))).not.toHaveProperty("settings");
  });

  it("streams partial messages and asks the host's broker through canUseTool", () => {
    const options = buildRunOptions(input());
    expect(options.includePartialMessages).toBe(true);
    expect(options.canUseTool).toBe(canUseTool);
  });

  it("asks for reasoning a transcript can show, since an SDK-driven CLI otherwise omits it", () => {
    expect(buildRunOptions(input()).extraArgs).toEqual({ "thinking-display": "summarized" });
  });

  it("runs the bundled executable", () => {
    expect(buildRunOptions(input()).pathToClaudeCodeExecutable).toBe("/sdk/claude-agent-sdk-linux-x64/claude");
    expect(buildRunOptions(input({}, { executablePath: null }))).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("names the project directory after the harness session, so a resume never depends on the working directory", () => {
    expect(buildRunOptions(input()).env?.["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(SESSION_ID);
  });

  it("gives the process the account's directory and none of the stripped variables", () => {
    const env = buildRunOptions(input()).env ?? {};
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/work");
    for (const name of CLAUDE_STRIPPED_VARIABLES) expect(env, name).not.toHaveProperty(name);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("agent-harness");
  });

  describe("what a run continues from", () => {
    const targets: [string, RunTarget][] = [
      ["fresh", { kind: "fresh" }],
      ["resume", { kind: "resume", providerSessionId: "provider-1" }],
      ["fork", { kind: "fork", providerSessionId: "provider-1", atMessageId: null }],
      ["rewind", { kind: "rewind", providerSessionId: "provider-1", toMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }],
    ];

    it.each(targets)("passes the session store on a %s run", (_kind, target) => {
      expect(buildRunOptions(input({ target }, { resumePoint: { resumeSessionAt: "entry-before" } })).sessionStore).toBe(store);
    });

    it("starts a fresh run with nothing to resume", () => {
      const options = buildRunOptions(input());
      expect(options).not.toHaveProperty("resume");
      expect(options).not.toHaveProperty("forkSession");
      expect(options).not.toHaveProperty("resumeSessionAt");
    });

    it("resumes the provider's session", () => {
      const options = buildRunOptions(input({ target: { kind: "resume", providerSessionId: "provider-1" } }));
      expect(options.resume).toBe("provider-1");
      expect(options).not.toHaveProperty("forkSession");
    });

    it("forks the whole session, or from the entry before an anchored prompt", () => {
      const whole = buildRunOptions(input({ target: { kind: "fork", providerSessionId: "provider-1", atMessageId: null } }));
      expect(whole).toMatchObject({ resume: "provider-1", forkSession: true });
      expect(whole).not.toHaveProperty("resumeSessionAt");
      const anchored = buildRunOptions(
        input({ target: { kind: "fork", providerSessionId: "provider-1", atMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } }, { resumePoint: { resumeSessionAt: "entry-before" } }),
      );
      expect(anchored).toMatchObject({ resume: "provider-1", forkSession: true, resumeSessionAt: "entry-before" });
      expect(anchored).not.toHaveProperty("resumeDropsTurn");
    });

    it("rewinds to the entry before the message, declaring the dropped turn when it is one", () => {
      const options = buildRunOptions(
        input(
          { target: { kind: "rewind", providerSessionId: "provider-1", toMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } },
          { resumePoint: { resumeSessionAt: "entry-before", dropsTurn: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } },
        ),
      );
      expect(options).toMatchObject({ resume: "provider-1", resumeSessionAt: "entry-before", resumeDropsTurn: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" });
      expect(options).not.toHaveProperty("forkSession");
    });

    it("refuses a rewind it could not place, rather than resuming the whole session", () => {
      expect(() => buildRunOptions(input({ target: { kind: "rewind", providerSessionId: "provider-1", toMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } }))).toThrow(/rewind/);
    });
  });

  it("never enables file checkpointing, which cannot be combined with the store", () => {
    expect(buildRunOptions(input())).not.toHaveProperty("enableFileCheckpointing");
  });
});
