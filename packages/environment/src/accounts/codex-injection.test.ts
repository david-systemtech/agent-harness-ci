import type { AccountStatusState, CodexForClaudeRuns } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { createProcessEnvironments, decideInjection, type ProcessEnvironmentScope } from "../adapter/process-environment.js";
import { sandboxOf } from "../adapters/claude/options.js";
import { readDenylistCall } from "../permissions/denylist-gate.js";
import { chooseCodexAccount, CODEX_SUPPLIER, codexExempt, codexHomeOf, createCodexSupplier, type CodexCandidate } from "./codex-injection.js";

const account = (id: string, provider: string, state: AccountStatusState = "signed-in", path = `/data/accounts/${id}`): CodexCandidate => ({
  id,
  provider,
  directory: { kind: "owned", path },
  status: { state, checkedAt: null, detail: null },
} as CodexCandidate);

const claude = account("claude-1", "claude");
const codexA = account("codex-a", "codex", "signed-in", "/home/me/.codex");
const codexB = account("codex-b", "codex");

const runScope = (overrides: Partial<ProcessEnvironmentScope> = {}): ProcessEnvironmentScope => ({
  sessionId: "session-1",
  accountId: "claude-1",
  origin: "client",
  holder: "provider-process",
  override: null,
  ...overrides,
});

describe("chooseCodexAccount (accounts.codexForClaudeRuns)", () => {
  it("chooses the only signed-in Codex account while the setting is unset", () => {
    expect(chooseCodexAccount([claude, codexA], null)?.id).toBe("codex-a");
    expect(codexHomeOf([claude, codexA], null)).toBe("/home/me/.codex");
  });

  it("chooses none of two signed-in Codex accounts unless the setting names one", () => {
    expect(chooseCodexAccount([claude, codexA, codexB], null)).toBeNull();
    expect(chooseCodexAccount([claude, codexA, codexB], "codex-b")?.id).toBe("codex-b");
  });

  it("chooses no signed-out, expired or unreadable Codex account, named or not", () => {
    for (const state of ["signed-out", "expired", "unreadable", "unavailable"] as const) {
      const lapsed = account("codex-a", "codex", state);
      expect(chooseCodexAccount([claude, lapsed], null), state).toBeNull();
      expect(chooseCodexAccount([claude, lapsed], "codex-a"), state).toBeNull();
    }
    // One signed-out beside one signed-in: the signed-in one is the only one.
    expect(chooseCodexAccount([account("codex-x", "codex", "signed-out"), codexB], null)?.id).toBe("codex-b");
  });

  it("chooses none when the setting names an account the environment no longer holds, or one not Codex's", () => {
    expect(chooseCodexAccount([claude, codexA], "codex-gone")).toBeNull();
    expect(chooseCodexAccount([claude, codexA], "claude-1")).toBeNull();
  });

  it("chooses none when the setting is off, even with one signed-in Codex account", () => {
    expect(chooseCodexAccount([claude, codexA], false)).toBeNull();
    expect(chooseCodexAccount([], null)).toBeNull();
  });
});

describe("the Codex account's process-environment supplier", () => {
  const environments = (setting: CodexForClaudeRuns, accounts: readonly CodexCandidate[], injection: "allow" | "deny" = "allow") => {
    const registry = createProcessEnvironments((scope) => decideInjection(scope, { environment: injection, byAccount: {} }));
    registry.register(createCodexSupplier({ codexHome: () => codexHomeOf(accounts, setting) }));
    return registry;
  };

  it("gives a Claude run CODEX_HOME and CODEX_WORKER_HOME naming the chosen directory, which it may write", async () => {
    const built = environments(null, [claude, codexA]).of(runScope());
    expect(built.key).toContain(CODEX_SUPPLIER);
    expect(built.key).toContain("/home/me/.codex");
    const supplied = await built.supply();
    expect(supplied.variables).toEqual({ CODEX_HOME: "/home/me/.codex", CODEX_WORKER_HOME: "/home/me/.codex" });
    expect(supplied.writable).toEqual(["/home/me/.codex"]);
  });

  it("gives nothing, and keys nothing, without a chosen Codex account", async () => {
    for (const [setting, accounts] of [
      [null, [claude]],
      [null, [claude, codexA, codexB]],
      [false, [claude, codexA]],
      ["codex-gone", [claude, codexA]],
    ] as const) {
      const built = environments(setting, accounts).of(runScope());
      expect(built.key).toBe("");
      const supplied = await built.supply();
      expect(supplied.variables).not.toHaveProperty("CODEX_HOME");
      expect(supplied.variables).not.toHaveProperty("CODEX_WORKER_HOME");
      expect(supplied.writable).toEqual([]);
    }
  });

  it("serves a run's provider process only: a terminal, a pre-check and a verify command get nothing", async () => {
    const registry = environments(null, [claude, codexA]);
    for (const holder of ["terminal", "pre-check", "verify-command"] as const) {
      const supplied = await registry.of(runScope({ holder })).supply();
      expect(supplied.variables, holder).toEqual({});
    }
  });

  it("gives nothing where the credential injection answer denies (ADR 0011)", async () => {
    const supplied = await environments(null, [claude, codexA], "deny").of(runScope()).supply();
    expect(supplied.variables).toEqual({});
  });

  it("changes the run's key when the chosen account does, so the next run gets a fresh process", () => {
    expect(environments("codex-a", [claude, codexA, codexB]).of(runScope()).key).not.toBe(environments("codex-b", [claude, codexA, codexB]).of(runScope()).key);
  });
});

describe("the chosen Codex directory under containment and the denylist", () => {
  it("is in a contained run's sandbox writable set beside its own", async () => {
    const supplier = createCodexSupplier({ codexHome: () => "/data/accounts/codex-b" });
    const supplied = await supplier.supply(runScope());
    const sandbox = sandboxOf(
      {
        containment: {
          level: "workspace",
          mechanism: "bubblewrap",
          scratchDirectory: "/data/containment/s/scratch",
          temporaryDirectory: "/data/containment/s/tmp",
          writable: ["/work/repo", "/data/containment/s/scratch", "/data/containment/s/tmp"],
          readOnly: [],
          network: true,
        },
        denylist: null,
      },
      supplied.writable ?? [],
    );
    expect(sandbox?.filesystem?.allowWrite).toEqual(["/work/repo", "/data/containment/s/scratch", "/data/containment/s/tmp", "/data/accounts/codex-b"]);
  });

  it("is left out of the denylist's data-directory preset while chosen, as the key-manager CLIs' directory is (#368)", () => {
    const denylist = () => ({ paths: [{ id: "data", pattern: "/data/**", enabled: true }], commandPatterns: [] }) as never;
    const context = (home: string | null) => ({ denylist, home: "/home/me", exempt: ["/data/key-manager-cli", ...codexExempt(() => home)], resolve: (path: string) => path });
    const call = { paths: ["/data/accounts/codex-b/auth.json"] };
    expect(readDenylistCall(context("/data/accounts/codex-b"), call, "/work").matches).toEqual([]);
    expect(readDenylistCall(context(null), call, "/work").matches).not.toEqual([]);
    expect(codexExempt(() => null)).toEqual([]);
  });
});
