import { randomUUID } from "node:crypto";
import { CAPABILITY_FLAG_LIST, isMethodName } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useHarness } from "../test/harness.js";
import { CAPABILITY_NAMES, FLAG_CAPABILITIES, METHOD_FLAGS } from "./capabilities.js";
import { SHELL_MEMBERS, type Shell } from "./shell.js";
import { fakeShell, inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

const absent = (reason: string) => ({ status: "absent", reason, message: expect.stringMatching(/\S/) });

describe("capability answers", () => {
  it("answers present for a method the client session's scopes allow", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link });

    expect(runtime.capability(t.env.id, "sessions.list")).toEqual({ status: "present" });
  });

  it("answers absent with reason unsupported for a flag the environment did not offer", async () => {
    const t = await harness.environment({ name: "desk" });
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    expect(runtime.capability(t.env.id, "self-update")).toEqual(absent("unsupported"));
    expect(runtime.capability(t.env.id, "self-update")).toMatchObject({ message: expect.stringContaining("desk") });
  });

  it("answers absent with reason scope for a method the client session's scopes do not allow", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing({ scopes: ["read"] })).link });

    expect(runtime.capability(t.env.id, "access.pairings.create")).toEqual(absent("scope"));
    expect(runtime.capability(t.env.id, "access.pairings.create")).toMatchObject({ message: expect.stringContaining("admin") });
  });

  it("answers absent with reason no-shell for a shell member the platform does not provide", async () => {
    const t = await harness.environment();
    const bare = harness.runtime(inMemoryPlatform());
    const { dialogs, ...withoutDialogs } = fakeShell();
    expect(dialogs).toBeDefined();
    const partial: Shell = { ...withoutDialogs, notifications: {} };
    const desktop = harness.runtime(inMemoryPlatform({ kind: "desktop", shell: partial }));
    for (const runtime of [bare, desktop]) await runtime.start();

    expect(bare.capability(t.env.id, "shell.dialogs")).toEqual(absent("no-shell"));
    expect(desktop.capability(t.env.id, "shell.dialogs")).toEqual(absent("no-shell"));
    expect(desktop.capability(t.env.id, "shell.notifications.show")).toEqual(absent("no-shell"));
    expect(desktop.capability(t.env.id, "shell.window")).toEqual({ status: "present" });
  });

  it("answers absent with reason unreachable when the environment cannot be reached, is disabled, or is not saved", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    await runtime.connections.setEnabled(t.env.id, false);
    expect(runtime.capability(t.env.id, "sessions.list")).toEqual(absent("unreachable"));

    await runtime.connections.setEnabled(t.env.id, true);
    await t.close();
    await runtime.connections.retryNow(t.env.id);
    expect(runtime.capability(t.env.id, "sessions.list")).toEqual(absent("unreachable"));

    expect(runtime.capability(randomUUID(), "sessions.list")).toEqual(absent("unreachable"));
  });

  it("answers absent with reason not-ready while the connection is being made", async () => {
    const t = await harness.environment();
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    const retrying = runtime.connections.retryNow(t.env.id);
    expect(runtime.capability(t.env.id, "sessions.list")).toEqual(absent("not-ready"));
    await retrying;
    expect(runtime.capability(t.env.id, "sessions.list")).toEqual({ status: "present" });
  });
});

describe("the capability names a client may ask for (contract)", () => {
  it("are every flag on the flag list, every registered method and every shell member, and nothing else", () => {
    for (const name of CAPABILITY_NAMES) {
      expect(
        (CAPABILITY_FLAG_LIST as readonly string[]).includes(name) || isMethodName(name) || (SHELL_MEMBERS as readonly string[]).includes(name),
        name,
      ).toBe(true);
    }
  });

  it("name only flags on the flag list, whether asked for directly or gating a method", () => {
    for (const flag of [...FLAG_CAPABILITIES, ...Object.values(METHOD_FLAGS)]) {
      expect(CAPABILITY_FLAG_LIST).toContain(flag);
    }
    for (const method of Object.keys(METHOD_FLAGS)) expect(isMethodName(method), method).toBe(true);
  });
});
