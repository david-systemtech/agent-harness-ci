import { EMPTY_RUN_SKILL_SET, type RunSkillSet } from "@agent-harness/contracts";
import type { CanUseTool, HookCallback, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { RunInput, RunTarget } from "../../adapter/contract.js";
import { EMPTY_PROCESS_ENVIRONMENT } from "../../adapter/process-environment.js";
import { CLAUDE_STRIPPED_VARIABLES } from "./credentials.js";
import { CLAUDE_MODES, GATE_HOOK_TIMEOUT_SECONDS, buildRunOptions, type RunOptionsInput } from "./options.js";

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
const preToolUse: HookCallback = async () => ({});

const run = (overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION_ID,
  runId: "0b8f5c1e-2d3a-4b6c-8e9f-0a1b2c3d4e5f",
  account: { id: "work", directory: "/data/accounts/work" },
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: "git.example/david/repo",
  model: "opus",
  effort: "high",
  mode: "acceptEdits",
  ceiling: "acceptEdits",
  instructions: "Orientation.\n\nThe session's own instructions.",
  target: { kind: "fresh" },
  toolServers: [],
  trusted: false,
  containment: {
    level: "off",
    mechanism: null,
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
    network: true,
  },
  denylist: null,
  processEnvironment: EMPTY_PROCESS_ENVIRONMENT,
  skillSet: EMPTY_RUN_SKILL_SET,
  prompt: [{ messageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", text: "Go", attachments: [] }],
  ...overrides,
});

/** A resolved set: its generation linking `tdd`, a trusted repository's `release` native, and its native `triage` switched off. */
const skillSet: RunSkillSet = {
  generation: "/data/skills/generations/3f9a",
  fingerprint: "3f9a",
  members: [
    { name: "tdd", origin: null, invocation: "model+slash", native: false },
    { name: "release", origin: null, invocation: "slash-only", native: true },
  ],
  hiddenNativeNames: ["triage"],
};

const input = (overrides: Partial<RunInput> = {}, extra: Partial<RunOptionsInput> = {}): RunOptionsInput => ({
  run: run(overrides),
  hostEnv: { PATH: "/usr/bin", HOME: "/home/david", ANTHROPIC_API_KEY: "sk-ant-shell", IS_SANDBOX: "1", CLAUDE_CODE_BUBBLEWRAP: "1" },
  supplied: {},
  configDirectory: "/data/accounts/work",
  executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
  autoMemoryDirectory: "/data/auto-memory/repo",
  checkoutRoot: null,
  sessionStore: store,
  resumePoint: null,
  canUseTool,
  preToolUse,
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
    const options = buildRunOptions(input({ mode, ceiling: mode }));
    expect(options.permissionMode).toBe(mode);
    expect(options.permissionPrompts).toBe("host");
  });

  it("opts into bypass (allowDangerouslySkipPermissions) exactly when the run's ceiling is bypassPermissions, whatever its mode", () => {
    for (const mode of CLAUDE_MODES) {
      expect(buildRunOptions(input({ mode, ceiling: "bypassPermissions" })).allowDangerouslySkipPermissions, mode).toBe(true);
    }
    for (const ceiling of ["plan", "acceptEdits", "auto"] as const) {
      expect(buildRunOptions(input({ mode: "plan", ceiling })), ceiling).not.toHaveProperty("allowDangerouslySkipPermissions");
    }
  });

  it("offers acceptEdits, plan, auto and bypassPermissions, and never default or dontAsk", () => {
    expect([...CLAUDE_MODES]).toEqual(["acceptEdits", "plan", "auto", "bypassPermissions"]);
    expect(() => buildRunOptions(input({ mode: "default" as never }))).toThrow(/mode/);
    expect(() => buildRunOptions(input({ mode: "dontAsk" as never }))).toThrow(/mode/);
  });

  it("runs a run with no mode of its own in acceptEdits", () => {
    expect(buildRunOptions(input({ mode: null as never })).permissionMode).toBe("acceptEdits");
  });

  it("hands the process's Stop hook to the SDK when it has one, beside the gate's", async () => {
    const onStop = async () => ({});
    expect(buildRunOptions(input({}, { onStop })).hooks).toEqual({ PreToolUse: [{ hooks: [preToolUse], timeout: GATE_HOOK_TIMEOUT_SECONDS }], Stop: [{ hooks: [onStop] }] });
    expect(buildRunOptions(input()).hooks).not.toHaveProperty("Stop");
  });

  it.each(CLAUDE_MODES)("asks the tool gate first for every tool call in %s: a PreToolUse hook matching every tool, waiting as long as the CLI's timer can", (mode) => {
    const options = buildRunOptions(input({ mode, ceiling: mode }));
    expect(options.hooks?.PreToolUse).toEqual([{ hooks: [preToolUse], timeout: GATE_HOOK_TIMEOUT_SECONDS }]);
    expect(options.hooks?.PreToolUse?.[0]).not.toHaveProperty("matcher");
    // The CLI arms a timer of the timeout's seconds in milliseconds: past 2^31 - 1 ms a JavaScript timer fires at once.
    expect(GATE_HOOK_TIMEOUT_SECONDS * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
    expect((GATE_HOOK_TIMEOUT_SECONDS + 1) * 1000).toBeGreaterThan(2 ** 31 - 1);
    // A day's TTL, the preset, fits under it.
    expect(GATE_HOOK_TIMEOUT_SECONDS).toBeGreaterThan(24 * 60 * 60);
  });

  it("never asks the SDK for dontAsk or default, and never answers prompts anywhere but the host", () => {
    for (const mode of CLAUDE_MODES) {
      for (const ceiling of CLAUDE_MODES) {
        const options = buildRunOptions(input({ mode, ceiling }));
        expect(options.permissionMode, `${mode} under ${ceiling}`).toBe(mode);
        expect(options.permissionPrompts).toBe("host");
        expect(options.canUseTool).toBe(canUseTool);
      }
    }
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

  it("serves an in-process server's tools through an in-process MCP server, and lets an external one's go ahead without asking (#139)", () => {
    const tool = { name: "get_weather", description: "The weather.", inputSchema: { type: "object" }, call: async () => ({ text: "Sunny", isError: false }) };
    const options = buildRunOptions(
      input({
        toolServers: [
          { name: "client", tools: [tool], external: true },
          { name: "memory", tools: [tool], external: false },
          { name: "browser", config: { type: "sdk", name: "browser" } },
        ],
      }),
    );
    expect(options.mcpServers?.["client"]).toMatchObject({ type: "sdk", name: "client", instance: expect.anything() });
    expect(options.mcpServers?.["memory"]).toMatchObject({ type: "sdk", name: "memory", instance: expect.anything() });
    expect(options.mcpServers?.["browser"]).toEqual({ type: "sdk", name: "browser" });
    // The caller runs its own tools: a call touches nothing here, so no prompt stands between the model and the caller.
    expect(options.allowedTools).toEqual(["mcp__client"]);
    expect(buildRunOptions(input())).not.toHaveProperty("allowedTools");
  });

  it("hands the run's generation over as its one local plugin, and no plugin when it has none", () => {
    expect(buildRunOptions(input({ skillSet })).plugins).toEqual([{ type: "local", path: "/data/skills/generations/3f9a" }]);
    expect(buildRunOptions(input())).not.toHaveProperty("plugins");
    expect(buildRunOptions(input({ skillSet: { ...skillSet, generation: null } }))).not.toHaveProperty("plugins");
  });

  it("points auto memory at the environment's directory for the repository", () => {
    expect(buildRunOptions(input()).settings).toEqual({ autoMemoryDirectory: "/data/auto-memory/repo" });
    expect(buildRunOptions(input({}, { autoMemoryDirectory: null }))).not.toHaveProperty("settings");
  });

  it("hides each native name to hide with skillOverrides off, in the flag settings beside the auto-memory directory", () => {
    const hiding = { ...skillSet, hiddenNativeNames: ["triage", "to-spec"] };
    expect(buildRunOptions(input({ skillSet: hiding })).settings).toEqual({ autoMemoryDirectory: "/data/auto-memory/repo", skillOverrides: { triage: "off", "to-spec": "off" } });
    expect(buildRunOptions(input({ skillSet: hiding }, { autoMemoryDirectory: null })).settings).toEqual({ skillOverrides: { triage: "off", "to-spec": "off" } });
    // Nothing hidden overrides nothing: a member of the generation is never named, whatever the set holds.
    expect(buildRunOptions(input({ skillSet: { ...skillSet, hiddenNativeNames: [] } })).settings).toEqual({ autoMemoryDirectory: "/data/auto-memory/repo" });
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

    it("refuses a fork from a message it could not place, rather than forking the whole session", () => {
      expect(() => buildRunOptions(input({ target: { kind: "fork", providerSessionId: "provider-1", atMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } }))).toThrow(/fork/);
    });

    it("refuses a rewind it could not place, rather than resuming the whole session", () => {
      expect(() => buildRunOptions(input({ target: { kind: "rewind", providerSessionId: "provider-1", toMessageId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" } }))).toThrow(/rewind/);
    });
  });

  it("never enables file checkpointing, which cannot be combined with the store", () => {
    expect(buildRunOptions(input())).not.toHaveProperty("enableFileCheckpointing");
  });

  describe("containment as the SDK's sandbox (permissions spec, the enforcement for Claude)", () => {
    const at = (level: "off" | "workspace" | "workspace-no-network", denylist: RunInput["denylist"] = null) =>
      buildRunOptions(
        input({
          containment: {
            level,
            mechanism: level === "off" ? null : "bubblewrap",
            scratchDirectory: "/data/containment/session/scratch",
            temporaryDirectory: "/data/containment/session/tmp",
            writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
            network: level !== "workspace-no-network",
          },
          denylist,
        }),
      );

    it("sets no sandbox at off", () => {
      expect(at("off")).not.toHaveProperty("sandbox");
    });

    it.each(["workspace", "workspace-no-network"] as const)("enables it at %s, failing rather than running unsandboxed, with no way to ask out of it and no approval by being sandboxed", (level) => {
      expect(at(level).sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
    });

    it.each(["workspace", "workspace-no-network"] as const)("lets a command at %s write in the workspace, the session's scratch directory and its temporary directory", (level) => {
      expect(at(level).sandbox?.filesystem?.allowWrite).toEqual(["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"]);
    });

    it("leaves the network open at workspace, local binding included, and names no domain", () => {
      const network = at("workspace").sandbox?.network;
      expect(network).toEqual({ allowLocalBinding: true });
      expect(network).not.toHaveProperty("allowedDomains");
      expect(network).not.toHaveProperty("strictAllowlist");
    });

    it("closes the network at workspace-no-network: no domain, no unix socket, no local binding, and nothing asked about", () => {
      expect(at("workspace-no-network").sandbox?.network).toEqual({
        allowedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      });
    });
  });

  describe("the denylist projected onto the provider's own rules, on unattended runs only", () => {
    const projected: NonNullable<RunInput["denylist"]> = {
      paths: ["/home/david/.ssh", "/home/david/.docker/config.json", "/data/agent-harness"],
      exempt: ["/data/agent-harness/containment", "/data/agent-harness/scratch"],
      commandPatterns: ["sudo *", "curl * |  *sh *", "rm -rf (x)\\y"],
    };
    const contained = (denylist: RunInput["denylist"], level: "off" | "workspace" = "workspace") =>
      buildRunOptions(
        input({
          containment: {
            level,
            mechanism: level === "off" ? null : "seatbelt",
            scratchDirectory: "/data/containment/session/scratch",
            temporaryDirectory: "/data/containment/session/tmp",
            writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
            network: true,
          },
          denylist,
        }),
      );

    it("puts the path section into the sandbox's denyRead, the directories the denylist leaves out read again", () => {
      const filesystem = contained(projected).sandbox?.filesystem;
      expect(filesystem?.denyRead).toEqual(projected.paths);
      expect(filesystem?.allowRead).toEqual(projected.exempt);
    });

    it("makes each command pattern a disallowed shell rule, its brackets and backslashes escaped as the CLI reads a rule", () => {
      expect(contained(projected).disallowedTools).toEqual(["Bash(sudo *)", "Bash(curl * | *sh *)", "Bash(rm -rf \\(x\\)\\\\y)"]);
    });

    it("keeps the disallowed shell rules at off, where no sandbox carries the paths", () => {
      const options = contained(projected, "off");
      expect(options).not.toHaveProperty("sandbox");
      expect(options.disallowedTools).toEqual(["Bash(sudo *)", "Bash(curl * | *sh *)", "Bash(rm -rf \\(x\\)\\\\y)"]);
    });

    it("projects neither on an attended run, so a person's explicit allow is never blocked by a rule", () => {
      const options = contained(null);
      expect(options).not.toHaveProperty("disallowedTools");
      expect(options.sandbox?.filesystem).not.toHaveProperty("denyRead");
      expect(options.sandbox?.filesystem).not.toHaveProperty("allowRead");
    });

    it("adds nothing for empty sections", () => {
      const options = contained({ paths: [], exempt: ["/data/agent-harness/containment"], commandPatterns: [] });
      expect(options).not.toHaveProperty("disallowedTools");
      expect(options.sandbox?.filesystem).not.toHaveProperty("denyRead");
      expect(options.sandbox?.filesystem).not.toHaveProperty("allowRead");
    });
  });
});
