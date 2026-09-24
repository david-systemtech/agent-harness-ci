import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { derived, writable } from "./observable.js";
import { SHELL_MEMBERS, hasShellMember, type Shell } from "./shell.js";
import { fakeShell, inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

describe("the package", () => {
  it("depends on contracts alone at run time", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["dependencies"]).toEqual({ "@agent-harness/contracts": "workspace:*" });
    expect(manifest["peerDependencies"]).toBeUndefined();
    expect(manifest["optionalDependencies"]).toBeUndefined();
  });
});

describe("observables", () => {
  it("read the current value and tell subscribers of each change, until they unsubscribe", () => {
    const value = writable(1);
    const seen: number[] = [];
    const stop = value.subscribe((v) => seen.push(v));
    value.set(2);
    value.set(2);
    value.update((v) => v + 1);
    stop();
    value.set(4);
    expect(value.read()).toBe(4);
    expect(seen).toEqual([2, 3]);
  });

  it("derive from others and keep one reference between changes", () => {
    const a = writable(1);
    const b = writable("x");
    const both = derived([a, b], (n, s) => ({ n, s }));
    const first = both.read();
    expect(both.read()).toBe(first);
    a.set(2);
    expect(both.read()).toEqual({ n: 2, s: "x" });
  });

  it("derive lazily: follow their sources only while they have subscribers", () => {
    let following = 0;
    const base = writable(1);
    const counted = {
      read: base.read,
      subscribe(listener: (value: number) => void) {
        following++;
        const stop = base.subscribe(listener);
        return () => {
          following--;
          stop();
        };
      },
    };
    const doubled = derived([counted], (n) => n * 2);
    expect(doubled.read()).toBe(2);
    expect(following).toBe(0);
    const seen: number[] = [];
    const stop = doubled.subscribe((v) => seen.push(v));
    base.set(2);
    expect(following).toBe(1);
    stop();
    expect(following).toBe(0);
    expect(seen).toEqual([4]);
  });

  it("derive again after a compute that threw, never keeping the stale value", () => {
    const source = writable(1);
    let fail = false;
    const doubled = derived([source], (n) => {
      if (fail) {
        fail = false;
        throw new Error("compute failed once");
      }
      return n * 2;
    });
    expect(doubled.read()).toBe(2);
    fail = true;
    source.set(2);
    expect(() => doubled.read()).toThrow("compute failed once");
    expect(doubled.read()).toBe(4);
  });

  it("tell every listener even when one throws, then throw what was thrown", () => {
    const value = writable(1);
    const seen: number[] = [];
    value.subscribe(() => {
      throw new Error("a renderer's bug");
    });
    value.subscribe((v) => seen.push(v));
    expect(() => value.set(2)).toThrow("a renderer's bug");
    expect(seen).toEqual([2]);
  });
});

describe("the in-memory platform", () => {
  it("has a clock that stands still until advanced, running timers as it passes them", () => {
    const clock = manualClock("2026-09-24T00:00:00.000Z");
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 200);
    clock.setTimeout(() => fired.push("a"), 100);
    clock.setTimeout(() => fired.push("never"), 300).cancel();
    clock.advance(250);
    expect(fired).toEqual(["a", "b"]);
    expect(clock.now().toISOString()).toBe("2026-09-24T00:00:00.250Z");
  });

  it("has a network signal the test toggles", () => {
    const { network } = inMemoryPlatform();
    const seen: unknown[] = [];
    network.subscribe((state) => seen.push(state));
    expect(network.read()).toEqual({ online: true, foreground: true });
    network.setOnline(false);
    network.setForeground(false);
    expect(seen).toEqual([
      { online: false, foreground: true },
      { online: false, foreground: false },
    ]);
  });

  it("stores documents as JSON and secrets apart from them", async () => {
    const { documents, secrets } = inMemoryPlatform();
    const value = { list: [1, 2] };
    await documents.set("k", value);
    value.list.push(3);
    expect(await documents.get("k")).toEqual({ list: [1, 2] });
    expect(await documents.get("missing")).toBeUndefined();
    await secrets.set("env", "s3cret");
    expect(await secrets.get("env")).toBe("s3cret");
    expect(JSON.stringify(documents.entries())).not.toContain("s3cret");
    await secrets.delete("env");
    expect(await secrets.get("env")).toBeUndefined();
  });

  it("ships a fake shell with every member, recording what it is asked", async () => {
    const shell = fakeShell();
    for (const member of SHELL_MEMBERS) expect(hasShellMember(shell, member), member).toBe(true);
    await shell.notifications?.show?.({ title: "Run ended", body: "desk" });
    expect(shell.calls).toEqual([["notifications.show", { title: "Run ended", body: "desk" }]]);
  });
});

describe("the shell interface", () => {
  it("has optional members only", () => {
    const none: Shell = {};
    expect(hasShellMember(none, "shell.window")).toBe(false);
    expectTypeOf<keyof Shell>().toEqualTypeOf<
      | "dialogs"
      | "window"
      | "notifications"
      | "tray"
      | "deepLinks"
      | "webView"
      | "installer"
      | "update"
      | "service"
      | "clipboard"
      | "openExternal"
      | "localGrant"
      | "secrets"
    >();
    expect(hasShellMember({}, "shell.dialogs")).toBe(false);
    expect(hasShellMember(undefined, "shell.dialogs")).toBe(false);
  });
});
