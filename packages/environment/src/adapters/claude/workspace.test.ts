import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledExecutable, executableCandidates } from "./executable.js";
import { worktreeCheckout } from "./workspace.js";

/** What the process resolves before building a run's options: a worktree's checkout, and the bundled binary. */

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "claude-workspace-"));
  roots.push(root);
  return root;
};

describe("a worktree's checkout", () => {
  it("is the directory holding the common .git a worktree's gitdir names", () => {
    const root = temp();
    const main = join(root, "repo");
    const worktree = join(root, "repo-121");
    mkdirSync(join(main, ".git", "worktrees", "repo-121"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "repo-121", "commondir"), "../..\n");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "repo-121")}\n`);
    expect(worktreeCheckout(worktree)).toBe(main);
  });

  it("is nothing for a plain checkout, a directory without git, or one that does not exist", () => {
    const root = temp();
    mkdirSync(join(root, "plain", ".git"), { recursive: true });
    expect(worktreeCheckout(join(root, "plain"))).toBeNull();
    expect(worktreeCheckout(root)).toBeNull();
    expect(worktreeCheckout(join(root, "missing"))).toBeNull();
  });
});

describe("the bundled binary", () => {
  it("is looked for where the SDK looks: the platform package, musl first on a musl Linux", () => {
    expect(executableCandidates("linux", "x64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
    ]);
    expect(executableCandidates("linux", "arm64", true)[0]).toBe("@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude");
    expect(executableCandidates("win32", "x64", false)).toEqual(["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"]);
    expect(executableCandidates("darwin", "arm64", false)).toEqual(["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);
  });

  it("answers the first candidate installed, and null when none is", () => {
    const installed = (paths: string[]) => ({
      resolve: (request: string) => {
        if (!paths.includes(request)) throw new Error("not found");
        return `/pnpm/${request}`;
      },
      exists: () => true,
    });
    expect(bundledExecutable({ platform: "linux", arch: "x64", musl: false, ...installed(["@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"]) })).toBe(
      "/pnpm/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
    );
    expect(bundledExecutable({ platform: "linux", arch: "riscv64", musl: false, ...installed([]) })).toBeNull();
  });
});
