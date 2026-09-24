import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CONFIG_DIR, CLAUDE_STRIPPED_VARIABLES, ambientConfigDirectory, claudeCredentials, composeRunEnvironment, isScrubbed, parseClaudeStatus, readClaudeStatus } from "./credentials.js";

/**
 * The Claude credential spec (claude-adapter spec, "The adapter contract";
 * ADR 0018): the directory variable, the stripped variables, the argv of the
 * bundled binary's auth commands, and the status parser. The status outputs
 * are what `claude auth status --json` prints: the signed-out one verbatim
 * from the bundled 2.1.281, the signed-in one in the fields Artemis reads.
 */

const SIGNED_OUT = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/tmp/authprobe/projects",
  "configDirectory": "/tmp/authprobe"
}`;

const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "david@example.com",
  orgId: "org-1",
  orgName: "David's Organization",
  subscriptionType: "max",
});

describe("the Claude credential spec", () => {
  it("names CLAUDE_CONFIG_DIR, strips the five variables, and holds the login, status and logout argv", () => {
    expect(claudeCredentials.configDirVariable).toBe("CLAUDE_CONFIG_DIR");
    expect(claudeCredentials.strippedVariables).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "IS_SANDBOX",
      "CLAUDE_CODE_BUBBLEWRAP",
    ]);
    expect(claudeCredentials.signIn).toEqual(["auth", "login"]);
    expect(claudeCredentials.status).toEqual(["auth", "status", "--json"]);
    expect(claudeCredentials.logout).toEqual(["auth", "logout"]);
  });

  it("never offers a Console sign-in: subscription is the binary's default", () => {
    expect(claudeCredentials.signIn).not.toContain("--console");
  });
});

describe("parsing the status", () => {
  it("reads a signed-in account as signed in, with its method, email, organisation and plan", () => {
    expect(parseClaudeStatus(SIGNED_IN)).toEqual({
      signedIn: true,
      authMethod: "claude.ai",
      email: "david@example.com",
      orgName: "David's Organization",
      subscriptionType: "max",
      error: null,
    });
  });

  it("reads the binary's signed-out answer as signed out, with no method", () => {
    expect(parseClaudeStatus(SIGNED_OUT)).toEqual({ signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null });
  });

  it("takes the object out of a notice printed before it", () => {
    expect(parseClaudeStatus(`A newer version is available.\n${SIGNED_IN}\n`).signedIn).toBe(true);
  });

  it("reads a missing loggedIn as signed out, never as ready to run", () => {
    expect(parseClaudeStatus(JSON.stringify({ email: "david@example.com" }))).toMatchObject({ signedIn: false, email: null, error: null });
  });

  it("reports what it could not read as an error, signed out", () => {
    expect(parseClaudeStatus("")).toMatchObject({ signedIn: false, error: expect.stringMatching(/readable status/) });
    expect(parseClaudeStatus("{ not json }")).toMatchObject({ signedIn: false, error: expect.stringMatching(/could not be parsed/) });
    expect(parseClaudeStatus("[1, 2]")).toMatchObject({ signedIn: false, error: expect.any(String) });
  });
});

describe("a Claude process's environment", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/david",
    ANTHROPIC_API_KEY: "sk-ant-shell",
    ANTHROPIC_AUTH_TOKEN: "token",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    IS_SANDBOX: "1",
    CLAUDE_CODE_BUBBLEWRAP: "1",
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-x",
    CLAUDE_CONFIG_DIR: "/home/david/.claude-other",
    CLAUDE_CODE_PROJECT_DIR_NAME: "stale",
    UNSET: undefined,
  };

  it("inherits the host's environment with every stripped variable absent and the account's directory present", () => {
    const env = composeRunEnvironment(host, "/data/accounts/work");
    for (const name of CLAUDE_STRIPPED_VARIABLES) expect(env, name).not.toHaveProperty(name);
    expect(env[CLAUDE_CONFIG_DIR]).toBe("/data/accounts/work");
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/david" });
    expect(env).not.toHaveProperty("UNSET");
  });

  it("keeps bare mode, other backends, other endpoints and model overrides out", () => {
    const env = composeRunEnvironment(host, "/data/accounts/work");
    for (const name of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_PROJECT_DIR_NAME"]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it("layers the run's own variables on top, and never a stripped one", () => {
    const env = composeRunEnvironment(host, "/data/accounts/work", { CLAUDE_CODE_PROJECT_DIR_NAME: "session-1", ANTHROPIC_API_KEY: "sk-ant-sneaky" });
    expect(env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe("session-1");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("scrubs by family: a stray refresh token, a backend selector, a token by descriptor, other endpoints", () => {
    const env = composeRunEnvironment(
      {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
        CLAUDE_CODE_USE_MANTLE: "1",
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "4",
        CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: "5",
        CLAUDE_CODE_API_BASE_URL: "https://elsewhere.example",
        CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://login.example",
        ANTHROPIC_DEFAULT_MODEL: "claude-x",
        ANTHROPIC_FOUNDRY_API_KEY: "key",
        ANTHROPIC_CONFIG_DIR: "/elsewhere",
        GITHUB_TOKEN: "ghp_x",
        AWS_SESSION_TOKEN: "aws",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
        MAX_THINKING_TOKENS: "10000",
        CLAUDE_CODE_IDLE_TOKEN_THRESHOLD: "5",
      },
      "/data/accounts/work",
    );
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_IDLE_TOKEN_THRESHOLD", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", CLAUDE_CONFIG_DIR, "MAX_THINKING_TOKENS", "PATH"].sort());
  });

  it("keeps the numeric token limits, which carry no credential", () => {
    for (const name of ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT", "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"]) {
      expect(isScrubbed(name), name).toBe(false);
    }
    for (const name of ["CLAUDE_BG_SOCKET_TOKENS_PATH", "CLAUDE_TRUSTED_DEVICE_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE"]) expect(isScrubbed(name), name).toBe(true);
  });

  it("resolves an account with no directory of its own to the ambient default, set explicitly", () => {
    expect(ambientConfigDirectory({ CLAUDE_CONFIG_DIR: "/home/david/.claude-other" })).toBe("/home/david/.claude-other");
    expect(ambientConfigDirectory({ HOME: "/home/seth" })).toBe("/home/seth/.claude");
    expect(ambientConfigDirectory({})).toBe(join(homedir(), ".claude"));
  });

  it("does not touch the host's environment", () => {
    const before = { ...host };
    composeRunEnvironment(host, "/data/accounts/work", { EXTRA: "1" });
    expect(host).toEqual(before);
  });
});

describe("reading the status through the bundled binary", () => {
  it("runs the status argv under the account's directory, with the stripped variables absent", async () => {
    const calls: { executable: string; argv: readonly string[]; env: Record<string, string> }[] = [];
    const status = await readClaudeStatus({
      executable: "/sdk/claude",
      directory: "/data/accounts/work",
      hostEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-shell" },
      run: async (executable, argv, env) => {
        calls.push({ executable, argv, env });
        return { code: 0, stdout: SIGNED_IN, stderr: "" };
      },
    });
    expect(status).toMatchObject({ signedIn: true, email: "david@example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ executable: "/sdk/claude", argv: ["auth", "status", "--json"] });
    expect(calls[0]?.env[CLAUDE_CONFIG_DIR]).toBe("/data/accounts/work");
    expect(calls[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("reads a signed-out exit 1 as signed out, not as a failure", async () => {
    const status = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 1, stdout: SIGNED_OUT, stderr: "" }) });
    expect(status).toEqual({ signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null });
  });

  it("prefers the binary's own words when nothing could be read", async () => {
    const status = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 2, stdout: "", stderr: "config unreadable\n" }) });
    expect(status).toMatchObject({ signedIn: false, error: "config unreadable" });
  });

  it("never spawns anything when this platform has no bundled binary", async () => {
    let ran = false;
    const status = await readClaudeStatus({
      executable: null,
      directory: "/d",
      hostEnv: {},
      run: async () => {
        ran = true;
        return { code: 0, stdout: SIGNED_IN, stderr: "" };
      },
    });
    expect(ran).toBe(false);
    expect(status).toMatchObject({ signedIn: false, error: expect.stringMatching(/bundled Claude binary/) });
  });
});
