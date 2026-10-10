import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CONFIG_DIR, CLAUDE_STRIPPED_VARIABLES, ambientConfigDirectory, claudeCredentials, composeRunEnvironment, isScrubbed, parseClaudeStatus, readClaudeStatus, spawnCommand } from "./credentials.js";

/**
 * The Claude credential spec (claude-adapter spec, "The adapter contract";
 * ADR 0018): the directory variable, the stripped variables, the argv of the
 * bundled binary's auth commands, and the status parser. The status outputs
 * are what `claude auth status --json` prints: the signed-out one verbatim
 * from the bundled 2.1.281, the signed-in one in the fields read here.
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

  it("points the CLI's credential store at the account's directory, never the host's (#229)", () => {
    // A resume through the session store runs the CLI in a temporary copy whose credentials have no refresh token: the
    // store's own directory is where the CLI reads and refreshes the account's login, and names its keychain item on macOS.
    const env = composeRunEnvironment({ ...host, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/david/.claude-other" }, "/data/accounts/work");
    expect(env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(isScrubbed("CLAUDE_SECURESTORAGE_CONFIG_DIR")).toBe(true);
    // Both set from the account whoever asks: a caller's own value for either never wins.
    const asked = composeRunEnvironment(host, "/data/accounts/work", { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere", [CLAUDE_CONFIG_DIR]: "/elsewhere" });
    expect(asked["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(asked[CLAUDE_CONFIG_DIR]).toBe("/data/accounts/work");
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
    expect(Object.keys(env).sort()).toEqual(
      ["CLAUDE_CODE_IDLE_TOKEN_THRESHOLD", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", CLAUDE_CONFIG_DIR, "CLAUDE_SECURESTORAGE_CONFIG_DIR", "MAX_THINKING_TOKENS", "PATH"].sort(),
    );
  });

  it("keeps the numeric token limits, which carry no credential", () => {
    for (const name of ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT", "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"]) {
      expect(isScrubbed(name), name).toBe(false);
    }
    for (const name of ["CLAUDE_BG_SOCKET_TOKENS_PATH", "CLAUDE_TRUSTED_DEVICE_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE"]) expect(isScrubbed(name), name).toBe(true);
  });

  it("resolves an account with no directory of its own to the ambient default, set explicitly", () => {
    expect(ambientConfigDirectory({ CLAUDE_CONFIG_DIR: "/home/david/.claude-other" })).toBe("/home/david/.claude-other");
    expect(ambientConfigDirectory({ HOME: "/home/milo" })).toBe("/home/milo/.claude");
    expect(ambientConfigDirectory({})).toBe(join(homedir(), ".claude"));
  });

  it("reads an empty HOME or USERPROFILE as unset, never a relative .claude", () => {
    expect(ambientConfigDirectory({ HOME: "", USERPROFILE: "C:\\Users\\milo" })).toBe(join("C:\\Users\\milo", ".claude"));
    expect(ambientConfigDirectory({ HOME: "", USERPROFILE: "" })).toBe(join(homedir(), ".claude"));
    expect(ambientConfigDirectory({ CLAUDE_CONFIG_DIR: "", HOME: "" })).toBe(join(homedir(), ".claude"));
  });

  it("puts the process-only git configuration its spawn was supplied after the host's own entries, which it keeps (#315)", () => {
    const inherited = { PATH: "/usr/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "vi" };
    const supplied = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!/opt/agent-harness git-credential github",
    };
    const env = composeRunEnvironment(inherited, "/data/accounts/work", {}, supplied);
    expect(Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("GIT_")))).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.editor",
      GIT_CONFIG_VALUE_0: "vi",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_2: "!/opt/agent-harness git-credential github",
    });
    // With nothing inherited, the supplied entries are as they came.
    expect(composeRunEnvironment({ PATH: "/usr/bin" }, "/data/accounts/work", {}, supplied)).toMatchObject(supplied);
  });

  it("removes every inherited FORGE_ variable, so a run's forge variables are the harness's alone (#315)", () => {
    const env = composeRunEnvironment(
      { PATH: "/usr/bin", FORGE_URL: "https://stale.example", FORGE_KIND: "gitea", FORGE_HOME_URL: "https://stale.example", GH_TOKEN: "token-for-tests" },
      "/data/accounts/work",
      {},
      { FORGE_GITHUB_URL: "https://github.com", FORGE_GITHUB_TOKEN: "token-for-tests" },
    );
    expect(Object.keys(env).filter((name) => name.startsWith("FORGE_") || name === "GH_TOKEN")).toEqual(["FORGE_GITHUB_URL", "FORGE_GITHUB_TOKEN"]);
  });

  it("removes every inherited BWS_ variable, so an inherited server URL never bypasses the Bitwarden block's profile and state folder (#1141)", () => {
    const env = composeRunEnvironment(
      { PATH: "/usr/bin", BWS_SERVER_URL: "https://stray.example", BWS_PROFILE: "stray-profile-for-tests", BWS_CONFIG_FILE: "/home/someone/.bws/config" },
      "/data/accounts/work",
      {},
      { BWS_ACCESS_TOKEN: "token-for-tests", BWS_CONFIG_FILE: "/data/key-manager-cli/bitwarden-a/config", BWS_PROFILE: "agent-harness" },
    );
    expect(Object.entries(env).filter(([name]) => name.startsWith("BWS_"))).toEqual([
      ["BWS_ACCESS_TOKEN", "token-for-tests"],
      ["BWS_CONFIG_FILE", "/data/key-manager-cli/bitwarden-a/config"],
      ["BWS_PROFILE", "agent-harness"],
    ]);
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
    // The status reads the credential store every other process of the account uses (#229).
    expect(calls[0]?.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe("/data/accounts/work");
    expect(calls[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("reports its own process deadline as temporary unavailability rather than unreadable credentials", async () => {
    await expect(readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {},
      timeoutMs: 15_000, run: async () => ({ code: null, stdout: "", stderr: "Timed out.", timedOut: true }),
    })).rejects.toMatchObject({ name: "ProbeTimeoutError", message: "The Claude status command did not answer within 15000 ms." });
  });

  it("reads a signed-out exit 1 as signed out, not as a failure", async () => {
    const status = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 1, stdout: SIGNED_OUT, stderr: "" }) });
    expect(status).toEqual({ signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null });
  });

  it("prefers the binary's own words when nothing could be read", async () => {
    const status = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 2, stdout: "", stderr: "config unreadable\n" }) });
    expect(status).toMatchObject({ signedIn: false, error: "config unreadable" });
  });

  it("says how the binary exited when it printed nothing, and that it could not be run when it never exited", async () => {
    const exited = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 3, stdout: "", stderr: "" }) });
    expect(exited).toMatchObject({ signedIn: false, error: "The Claude binary exited with code 3." });
    const unrun = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: null, stdout: "", stderr: "" }) });
    expect(unrun).toMatchObject({ signedIn: false, error: "The bundled Claude binary could not be run." });
  });

  it("says what was wrong with the status when the binary exited cleanly with nothing readable", async () => {
    const status = await readClaudeStatus({ executable: "/sdk/claude", directory: "/d", hostEnv: {}, run: async () => ({ code: 0, stdout: "not json", stderr: "" }) });
    expect(status).toMatchObject({ signedIn: false, error: "The Claude binary did not print a readable status." });
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

describe("the command runner", () => {
  it("decodes what the binary prints once, so a character split across two writes arrives whole", async () => {
    // The two bytes of é, written apart on each stream, so they reach the runner as separate chunks.
    const script = [
      "process.stdout.write(Buffer.from([0xc3]));",
      "process.stderr.write(Buffer.from([0xc3]));",
      "setTimeout(() => { process.stdout.write(Buffer.from([0xa9])); process.stderr.write(Buffer.from([0xa9])); }, 50);",
    ].join(" ");
    const result = await spawnCommand(process.execPath, ["-e", script], { PATH: process.env["PATH"] ?? "" }, 10_000);
    expect(result).toEqual({ code: 0, stdout: "é", stderr: "é" });
  });
});
