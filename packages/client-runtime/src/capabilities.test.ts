import { randomUUID } from "node:crypto";
import { CAPABILITY_FLAG_LIST, type MethodName } from "@agent-harness/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { useHarness } from "../test/harness.js";
import { METHOD_FLAGS, type CapabilityName } from "./capabilities.js";
import type { Shell } from "./shell.js";
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
    // A desktop can lack a member too: the line says what this client's shell is missing, not that only a desktop can.
    expect(desktop.capability(t.env.id, "shell.dialogs")).toMatchObject({ message: expect.stringContaining("its shell has no shell.dialogs") });
    expect(desktop.capability(t.env.id, "shell.dialogs")).toMatchObject({ message: expect.not.stringContaining("desktop") });
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
  it("is a type: every name is a flag on the contracts' flag list, a registered method, or a shell.* member", () => {
    expectTypeOf<CapabilityName>().toExtend<(typeof CAPABILITY_FLAG_LIST)[number] | MethodName | `shell.${string}`>();
    // A flag gating a method is a flag on the list, and the method a registered one.
    expectTypeOf(METHOD_FLAGS).toExtend<Partial<Record<MethodName, (typeof CAPABILITY_FLAG_LIST)[number]>>>();
    // @ts-expect-error: a flag missing from the list is not a capability name.
    const unlisted: CapabilityName = "no-such-flag";
    expect(unlisted).toBe("no-such-flag");
  });
});
