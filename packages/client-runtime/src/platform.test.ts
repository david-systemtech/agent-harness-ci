import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { derived, dynamic, writable } from "./observable.js";
import {
  hasShellMember,
  type Shell,
  type ShellDeepLinks,
  type ShellInstaller,
  type ShellNotification,
  type ShellNotifications,
  type ShellStagedBuild,
  type ShellUpdate,
} from "./shell.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

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

  it("notifies a derived value when an earlier source listener already read its new value", () => {
    const source = writable(1);
    const doubled = derived([source], (n) => n * 2);
    const stopReader = source.subscribe(() => doubled.read());
    const seen: number[] = [];
    const stop = doubled.subscribe((value) => seen.push(value));
    source.set(2);
    expect(seen).toEqual([4]);
    stop();
    stopReader();
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

  it("follow nothing when a compute throws as the first subscriber arrives, derived or dynamic", () => {
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
    let fail = true;
    const compute = () => {
      if (fail) throw new Error("not computable yet");
      return counted.read() * 2;
    };
    for (const view of [derived([counted], compute), dynamic(() => [counted], compute)]) {
      fail = true;
      expect(() => view.subscribe(() => undefined)).toThrow("not computable yet");
      expect(following).toBe(0);
      fail = false;
      const stop = view.subscribe(() => undefined);
      expect(following).toBe(1);
      stop();
      expect(following).toBe(0);
    }
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

  it("never moves the clock back when a timer's callback advances it past the outer advance", () => {
    const clock = manualClock("2026-09-24T00:00:00.000Z");
    const fired: string[] = [];
    clock.setTimeout(() => {
      clock.advance(1000);
      // Due at 1.1 s, past the outer advance's horizon of 0.5 s but not past where the clock now stands.
      clock.setTimeout(() => fired.push(clock.now().toISOString()), 0);
    }, 100);
    clock.setTimeout(() => fired.push(clock.now().toISOString()), 400);
    clock.advance(500);
    expect(fired).toEqual(["2026-09-24T00:00:00.400Z", "2026-09-24T00:00:01.100Z"]);
    expect(clock.now().toISOString()).toBe("2026-09-24T00:00:01.100Z");
    expect(clock.pending()).toBe(0);
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
      | "credentialAccess"
      | "secrets"
      | "preview"
      | "http"
      | "network"
      | "system"
      | "gh"
      | "camera"
    >();
    expect(hasShellMember({}, "shell.dialogs")).toBe(false);
    expect(hasShellMember(undefined, "shell.dialogs")).toBe(false);
  });

  it("has the desktop's updater answer what it runs and apply a staged build, and its installer the server it carries: no check or install of its own (#354)", () => {
    expectTypeOf<keyof ShellUpdate>().toEqualTypeOf<"current" | "apply">();
    expectTypeOf<Parameters<ShellUpdate["apply"]>>().toEqualTypeOf<[staged: ShellStagedBuild, when: "now" | "quit"]>();
    expectTypeOf<Awaited<ReturnType<ShellUpdate["current"]>>["format"]>().toEqualTypeOf<string | null>();
    expectTypeOf<keyof ShellInstaller>().toEqualTypeOf<"bundledServer" | "reserveSpace">();
    expectTypeOf<Awaited<ReturnType<ShellInstaller["bundledServer"]>>>().toEqualTypeOf<{ readonly version: string; readonly path: string; readonly refusal?: { readonly reason: "disk"; readonly message: string } } | null>();
  });

  it("carries strings where a session might have passed: a notification's tag, handed back on a click, and a deep link", () => {
    expectTypeOf<ShellNotification["tag"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Parameters<NonNullable<ShellNotifications["onActivate"]>>[0]>().toEqualTypeOf<(tag: string) => void>();
    expectTypeOf<Parameters<NonNullable<ShellDeepLinks["onOpen"]>>[0]>().toEqualTypeOf<(url: string) => void>();
    expect(hasShellMember({ notifications: { show: async () => undefined } }, "shell.notifications.onActivate")).toBe(false);
  });
});
