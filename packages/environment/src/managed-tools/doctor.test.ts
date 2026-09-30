import { realpathSync } from "node:fs";
import type { ManagedToolDetail } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeToolPath, type FakeToolAnswer, type FakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * `tools.detail` through the primary seam (key-managers spec, "Managed
 * tools" and "Wire methods"; ADR 0026; #374): an in-process environment and
 * a real client over a real WebSocket, with a fake `claude` on a PATH the
 * test sets whose `doctor` prints scripted fields, as the pinned SDK's
 * Claude Code 2.1.283 prints them when its output is not a terminal.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

/** What Claude Code 2.1.283's `claude doctor` printed for a native install, run with no terminal, its paths shortened. */
const NATIVE_DOCTOR = [
  "Claude Code doctor",
  "",
  "Running: native (2.1.283)",
  "Commit: 4631ccd7cfe4",
  "Platform: linux-x64",
  "Path: /home/david/.local/share/claude/versions/2.1.283",
  "Config install method: unknown",
  "Search: OK (bundled)",
  "Auto-updates: enabled",
  "Auto-update channel: latest",
  "Last update attempt: none recorded",
  "Managed settings (remote): not fetched — requires an Enterprise or Team subscription",
  "Organization policy: not applicable to Pro and Max accounts",
  "",
  "Remote Control",
  "Control this session from claude.ai/code or the Claude mobile app",
  "",
  "1 warning found",
  "- Running native installation but config install method is 'unknown'",
  "  Fix: Run claude install to update configuration",
  "",
  "For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.",
].join("\n");

/** The same doctor misreporting the install method, as it does for the SDK's own binary: npm-global. */
const MISREPORTING_DOCTOR = NATIVE_DOCTOR.replace("Running: native (2.1.283)", "Running: npm-global (2.1.283)")
  .replace(/\n1 warning found\n[^]*?\n\n/, "\nNo installation issues found.\n\n");

/** A fake PATH under a fresh directory, with its root's links resolved so realpaths compare. */
const fakePath = (): FakeToolPath => fakeToolPath(realpathSync(tempDir()));

/** A `claude` installed by its native installer, whose `doctor` answers as `doctor` says. */
const nativeClaude = (path: FakeToolPath, doctor: FakeToolAnswer) =>
  path.install("claude", { at: ".local/share/claude/versions/2.1.283", output: "2.1.283 (Claude Code)", answers: { doctor } });

const withTools = async (path: FakeToolPath, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment({ ...options, managedTools: { readPath: async () => path.path(), ...options.managedTools } });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

const detail = (client: WireClient): Promise<ManagedToolDetail> => client.request("tools.detail", { tool: "claude" });

posix("tools.detail", () => {
  it("runs claude doctor where the row found claude, and answers the fields it printed and its warnings beside the row", async () => {
    const path = fakePath();
    const claude = nativeClaude(path, { stdout: NATIVE_DOCTOR });
    const { client } = await withTools(path);

    const answer = await detail(client);
    expect(answer.tool).toBe("claude");
    expect(answer.row).toMatchObject({ tool: "claude", path: claude.onPath, realpath: claude.file, version: "2.1.283", method: "native" });
    expect(answer.doctor).toEqual({
      outcome: "read",
      method: "native",
      fields: [
        { name: "Running", value: "native (2.1.283)" },
        { name: "Commit", value: "4631ccd7cfe4" },
        { name: "Platform", value: "linux-x64" },
        { name: "Path", value: "/home/david/.local/share/claude/versions/2.1.283" },
        { name: "Config install method", value: "unknown" },
        { name: "Search", value: "OK (bundled)" },
        { name: "Auto-updates", value: "enabled" },
        { name: "Auto-update channel", value: "latest" },
        { name: "Last update attempt", value: "none recorded" },
        { name: "Managed settings (remote)", value: "not fetched — requires an Enterprise or Team subscription" },
        { name: "Organization policy", value: "not applicable to Pro and Max accounts" },
      ],
      warnings: [{ issue: "Running native installation but config install method is 'unknown'", fix: "Run claude install to update configuration" }],
    });
    expect(claude.calls()).toEqual([["--version"], ["doctor"]]);
  });

  it("answers the method the registry detected beside the one doctor reports, so a difference shows", async () => {
    const path = fakePath();
    nativeClaude(path, { stdout: MISREPORTING_DOCTOR });
    const { client } = await withTools(path);

    const answer = await detail(client);
    expect(answer.row.method).toBe("native");
    expect(answer.doctor).toMatchObject({ outcome: "read", method: "npm", warnings: [] });
  });

  it("reads doctor's words in the registry's: npm-local as npm, a package manager's by its name, deb as apt and rpm as dnf, and none for words it has no method for", async () => {
    const reported = async (running: string, manager?: string) => {
      const path = fakePath();
      const lines = NATIVE_DOCTOR.replace("Running: native (2.1.283)", `Running: ${running} (2.1.283)${manager === undefined ? "" : `\nPackage manager: ${manager}`}`);
      nativeClaude(path, { stdout: lines });
      const { client } = await withTools(path);
      const { doctor } = await detail(client);
      return doctor.outcome === "read" ? doctor.method : doctor.outcome;
    };
    expect(await reported("npm-local")).toBe("npm");
    expect(await reported("package-manager", "homebrew")).toBe("homebrew");
    expect(await reported("package-manager", "deb")).toBe("apt");
    expect(await reported("package-manager", "rpm")).toBe("dnf");
    expect(await reported("package-manager", "pacman")).toBeNull();
    expect(await reported("unknown")).toBe("unknown");
    expect(await reported("development")).toBeNull();
  });

  it("runs doctor only when asked: neither the start's probe nor a refreshed list runs it", async () => {
    const path = fakePath();
    const claude = nativeClaude(path, { stdout: NATIVE_DOCTOR });
    const { t, client } = await withTools(path);
    await client.request("tools.list", {});
    t.clock.advance(15 * 60_000);
    await client.request("tools.list", { refresh: true });
    expect(claude.calls()).toEqual([["--version"], ["--version"]]);

    await detail(client);
    await detail(client);
    expect(claude.calls().filter(([first]) => first === "doctor")).toHaveLength(2);
  });

  it("answers not-installed when no claude is on the PATH, running nothing", async () => {
    const { client } = await withTools(fakePath());
    const answer = await detail(client);
    expect(answer.row).toMatchObject({ tool: "claude", status: "not-installed" });
    expect(answer.doctor).toEqual({ outcome: "not-installed" });
  });

  it("answers failed, saying why, for a doctor that exits with an error or prints no summary", async () => {
    const failing = fakePath();
    nativeClaude(failing, { stderr: "error: unknown command 'doctor'", exitCode: 1 });
    expect((await detail((await withTools(failing)).client)).doctor).toEqual({ outcome: "failed", reason: "claude doctor exited with code 1: error: unknown command 'doctor'." });

    const silent = fakePath();
    nativeClaude(silent, { stdout: "Claude Code doctor" });
    expect((await detail((await withTools(silent)).client)).doctor).toEqual({ outcome: "failed", reason: "claude doctor printed no summary to read." });
  });

  it("gives up on a doctor that has not answered within thirty seconds on the environment's clock", async () => {
    const path = fakePath();
    const claude = nativeClaude(path, { hang: true });
    const { t, client } = await withTools(path);
    const answer = detail(client);
    await vi.waitFor(() => expect(claude.calls()).toContainEqual(["doctor"]), { timeout: WAIT_MS });
    t.clock.advance(30_000);
    expect((await answer).doctor).toEqual({ outcome: "failed", reason: "claude doctor failed: no answer within 30 s." });
  });

  it("keeps nothing it printed that the scrub registry holds: a value the environment registered is redacted", async () => {
    const path = fakePath();
    const held = "a-value-the-environment-holds";
    nativeClaude(path, { stdout: `${NATIVE_DOCTOR.replace("Platform: linux-x64", `Platform: linux-x64 ${held}`)}` });
    const { t, client } = await withTools(path);
    t.scrub.register(held, { owner: "test:secret" });
    const answer = await detail(client);
    expect(JSON.stringify(answer)).not.toContain(held);
    expect(answer.doctor).toMatchObject({ fields: expect.arrayContaining([{ name: "Platform", value: "linux-x64 [redacted]" }]) });
  });

  it("is a read method: a client session with the read scope alone may call it", async () => {
    const path = fakePath();
    nativeClaude(path, { stdout: NATIVE_DOCTOR });
    const { t } = await withTools(path);
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect((await detail(reader)).doctor).toMatchObject({ outcome: "read", method: "native" });
  });
});
