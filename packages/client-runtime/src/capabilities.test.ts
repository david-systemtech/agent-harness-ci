import { randomUUID } from "node:crypto";
import { CAPABILITY_FLAG_LIST, type MethodName } from "@agent-harness/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { useHarness } from "../test/harness.js";
import { METHOD_FLAGS, answerCapability, type CapabilityName } from "./capabilities.js";
import { BLOCKED_REASONS, type BlockedReason, type ConnectionRecord } from "./connections/records.js";
import type { ConnectionAction } from "./connections/state-machine.js";
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

describe("the desktop's added shell members as capabilities", () => {
  /** A shell with every member of `shell` but `member`'s own. */
  const without = (shell: Shell, member: string): Shell => {
    const [top, inner] = member.split(".").slice(1) as [keyof Shell, string | undefined];
    const kept = Object.fromEntries(Object.entries(shell).filter(([key]) => key !== top)) as Shell;
    if (inner === undefined) return kept;
    return { ...kept, [top]: Object.fromEntries(Object.entries(shell[top] as object).filter(([key]) => key !== inner)) };
  };

  it.each(["shell.http", "shell.network", "shell.system", "shell.preview", "shell.notifications.onActivate", "shell.gh", "shell.update", "shell.installer.bundledServer"] as const)(
    "answers %s present when the shell has it, and absent with reason no-shell when it lacks it or there is no shell",
    (name) => {
      const shell = fakeShell();
      const whole = harness.runtime(inMemoryPlatform({ kind: "desktop", shell }));
      const lacking = harness.runtime(inMemoryPlatform({ kind: "desktop", shell: without(shell, name) }));
      const bare = harness.runtime(inMemoryPlatform());

      expect(whole.capability("any", name)).toEqual({ status: "present" });
      expect(lacking.capability("any", name)).toEqual(absent("no-shell"));
      expect(lacking.capability("any", name)).toMatchObject({ message: expect.stringContaining(`its shell has no ${name}`) });
      expect(bare.capability("any", name)).toEqual(absent("no-shell"));
    },
  );

  it("keeps a notification's other member when one is missing: show without onActivate, and onActivate without show", () => {
    const shell = fakeShell();
    const showOnly = harness.runtime(inMemoryPlatform({ kind: "desktop", shell: without(shell, "shell.notifications.onActivate") }));
    const activateOnly = harness.runtime(inMemoryPlatform({ kind: "desktop", shell: without(shell, "shell.notifications.show") }));

    expect(showOnly.capability("any", "shell.notifications.show")).toEqual({ status: "present" });
    expect(activateOnly.capability("any", "shell.notifications.show")).toEqual(absent("no-shell"));
    expect(activateOnly.capability("any", "shell.notifications.onActivate")).toEqual({ status: "present" });
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

describe("a blocked environment's capability line (#1772)", () => {
  /** A connection to `desk` blocked for `reason`, with the action the state machine offers for it. */
  const blocked = (reason: BlockedReason, action: ConnectionAction | null, kind: "local" | "paired" = "paired"): ConnectionRecord =>
    ({ environmentId: "env-desk", kind, enabled: true, phase: "blocked", blocked: reason, action, scopes: [], descriptor: { name: "desk", capabilities: [] } }) as unknown as ConnectionRecord;

  const lines: Record<BlockedReason, readonly [ConnectionAction | null, string]> = {
    "protocol-mismatch": ["update-environment", "desk is older than this client: update desk to this client's version."],
    "unsupported-client": ["update-client", "desk is newer than this client: update this client."],
    revoked: ["re-pair", "This client's access to desk was revoked: pair it again."],
    expired: ["re-pair", "This client's access to desk expired: pair it again."],
    "credential-unavailable": ["re-pair", "Stored credentials for desk could not be read: pair it again."],
    "different-environment": [null, "The address kept for desk now reaches another environment."],
  };

  it.each(BLOCKED_REASONS)("says %s as a sentence with what to do, never its id", (reason) => {
    const [action, line] = lines[reason];
    const answer = answerCapability("terminals.open", blocked(reason, action), undefined);
    expect(answer).toEqual({ status: "absent", reason: "unreachable", message: line });
    // A one-word id is also a word of its sentence ("was revoked"); its raw form is the parenthesised code.
    expect(answer.status === "absent" && answer.message).not.toContain(reason.includes("-") ? reason : `(${reason})`);
  });

  it("says a protocol mismatch the environment cannot update itself from as such, and a local block as one to try again", () => {
    expect(answerCapability("runs.start", blocked("protocol-mismatch", null), undefined)).toMatchObject({ message: "desk is older than this client, and cannot update itself from here." });
    expect(answerCapability("runs.start", blocked("revoked", null, "local"), undefined)).toMatchObject({ message: "This client's access to desk was revoked: try again." });
  });
});
