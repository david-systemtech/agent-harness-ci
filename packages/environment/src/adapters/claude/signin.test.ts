import { describe, expect, it } from "vitest";
import { AUTH_HELP_WITHOUT_LOGIN, LOGIN_HELP, VERIFICATION_URL, loginBanner } from "../../../test/signin.js";
import { CLAUDE_STRIPPED_VARIABLES } from "./credentials.js";
import {
  CLAUDE_LOGIN_ARGV,
  CLAUDE_LOGIN_HELP_ARGV,
  claudeFallback,
  claudeSignInProgram,
  claudeVerificationUrl,
  runsClaudeLogin,
} from "./signin.js";

/**
 * Claude's sign-in program (#135): what the director runs, how it reads the
 * verification URL and the probe's answer, and the fallback command's two
 * renderings. The outputs are the bundled 2.1.281's, recorded with stdin a
 * pipe (the claude-adapter spec's Further Notes).
 */

describe("the sign-in argv", () => {
  it("is auth login, never --console, and the probe asks for its help", () => {
    expect(CLAUDE_LOGIN_ARGV).toEqual(["auth", "login"]);
    expect(CLAUDE_LOGIN_ARGV).not.toContain("--console");
    expect(CLAUDE_LOGIN_HELP_ARGV).toEqual(["auth", "login", "--help"]);
  });
});

describe("the probe", () => {
  it("reads a binary as running auth login when it exits 0 with the command's own usage", () => {
    expect(runsClaudeLogin({ code: 0, stdout: LOGIN_HELP, stderr: "" })).toBe(true);
  });

  it("reads the parent's usage, which a binary without the command prints with exit 0, as not running it", () => {
    expect(runsClaudeLogin({ code: 0, stdout: AUTH_HELP_WITHOUT_LOGIN, stderr: "" })).toBe(false);
    expect(runsClaudeLogin({ code: 0, stdout: "Usage: claude [options] [command] [prompt]\n", stderr: "" })).toBe(false);
  });

  it("reads a failure or a binary that could not run as not running it", () => {
    expect(runsClaudeLogin({ code: 1, stdout: LOGIN_HELP, stderr: "" })).toBe(false);
    expect(runsClaudeLogin({ code: null, stdout: "", stderr: "spawn ENOENT" })).toBe(false);
  });
});

describe("the verification URL", () => {
  it("is read from the line the binary prints once the line has ended", () => {
    expect(claudeVerificationUrl(loginBanner())).toBe(VERIFICATION_URL);
    expect(claudeVerificationUrl("Opening browser to sign in…\n")).toBeNull();
  });

  it("is never a stray https line before the visit line, nor a match that does not parse as a URL", () => {
    expect(claudeVerificationUrl(`A newer version is available: https://claude.com/download\n${loginBanner()}`)).toBe(VERIFICATION_URL);
    expect(claudeVerificationUrl("See https://docs.claude.com/auth for help.\nOpening browser to sign in…\n")).toBeNull();
    expect(claudeVerificationUrl("If the browser didn't open, visit: https://[not-a-host/oauth/authorize?x=1\n")).toBeNull();
  });

  it("is read from a line without the visit: prefix when it goes to /oauth/authorize", () => {
    expect(claudeVerificationUrl(`Open ${VERIFICATION_URL}\n`)).toBe(VERIFICATION_URL);
  });

  it("is not read from half a URL, split across two chunks, until the rest comes", () => {
    const banner = loginBanner();
    const cut = banner.indexOf("code_challenge");
    expect(claudeVerificationUrl(banner.slice(0, cut))).toBeNull();
    expect(claudeVerificationUrl(banner)).toBe(VERIFICATION_URL);
  });
});

describe("the fallback command", () => {
  it("sets the directory for the command alone in POSIX, quoted, and for the session in PowerShell, then calls the executable", () => {
    expect(claudeFallback("/home/david/.local/state/agent-harness/accounts/a1", "/opt/sdk/claude")).toEqual({
      posix: "CLAUDE_CONFIG_DIR='/home/david/.local/state/agent-harness/accounts/a1' /opt/sdk/claude auth login",
      powershell: "$env:CLAUDE_CONFIG_DIR = '/home/david/.local/state/agent-harness/accounts/a1'; & '/opt/sdk/claude' auth login",
    });
  });

  it("escapes a quote in the directory for each shell, and quotes an executable path a shell would split", () => {
    const fallback = claudeFallback("/home/o'brien/state dir", "/Applications/Agent Harness.app/claude");
    expect(fallback.posix).toBe(`CLAUDE_CONFIG_DIR='/home/o'\\''brien/state dir' '/Applications/Agent Harness.app/claude' auth login`);
    expect(fallback.powershell).toBe(`$env:CLAUDE_CONFIG_DIR = '/home/o''brien/state dir'; & '/Applications/Agent Harness.app/claude' auth login`);
  });

  it("doubles the typographic single quotes PowerShell also reads as quotes, and passes nothing that picks Console billing", () => {
    const fallback = claudeFallback("C:\\Users\\O\u2019Brien\\accounts\\a1", "C:\\Program Files\\claude.exe");
    expect(fallback.powershell).toBe("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O\u2019\u2019Brien\\accounts\\a1'; & 'C:\\Program Files\\claude.exe' auth login");
    expect(fallback.posix).not.toContain("--console");
    expect(fallback.powershell).not.toContain("--console");
  });
});

describe("the program", () => {
  it("runs with the account's directory and every stripped and scrubbed variable absent", () => {
    const program = claudeSignInProgram({
      bundled: "/opt/sdk/claude",
      hostEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-api03-key",
        ANTHROPIC_AUTH_TOKEN: "token",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        ANTHROPIC_BASE_URL: "https://proxy.example.com",
        CLAUDE_CONFIG_DIR: "/somewhere/else",
      },
      managedTool: () => null,
    });
    const env = program.env("/data/accounts/a1");
    // The login lands in the credential store every later process of the account reads, the directory's own (#229).
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/data/accounts/a1", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/data/accounts/a1" });
    for (const name of CLAUDE_STRIPPED_VARIABLES) expect(env).not.toHaveProperty(name);
    expect(program.argv).toEqual(["auth", "login"]);
    expect(program.bundled).toBe("/opt/sdk/claude");
  });
});
