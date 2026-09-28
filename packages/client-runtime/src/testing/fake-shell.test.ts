import { describe, expect, it } from "vitest";
import { createRuntime } from "../runtime.js";
import { SHELL_MEMBERS, hasShellMember } from "../shell.js";
import { fakeShell, inMemoryPlatform } from "./in-memory-platform.js";

/**
 * The recording fake shell (docs/specs/gui.md, "Testing Decisions"): every
 * member the desktop implements, each call recorded with its arguments, each
 * answer what the test scripts, and the two things only the desktop's side
 * starts, a deep link opened and a notification clicked, fired on demand.
 */

const BOUNDS = { x: 0, y: 40, width: 800, height: 600 };

describe("the recording fake shell", () => {
  it("implements every member a renderer may ask about", () => {
    const shell = fakeShell();
    for (const member of SHELL_MEMBERS) expect(hasShellMember(shell, member), member).toBe(true);
  });

  it("records each call with every argument, oldest first", async () => {
    const shell = fakeShell();
    shell.webView.attach("view-1", BOUNDS);
    await shell.notifications.show({ title: "Run ended", body: "desk", tag: "agent-harness://open/desk/1" });
    await shell.service.start();
    shell.window.setBackgroundColour("#101014");
    await shell.network.allow(["http://desk.test:7433", "http://127.0.0.1:7433"]);

    expect(shell.calls).toEqual([
      ["webView.attach", "view-1", BOUNDS],
      ["notifications.show", { title: "Run ended", body: "desk", tag: "agent-harness://open/desk/1" }],
      ["service.start"],
      ["window.setBackgroundColour", "#101014"],
      ["network.allow", ["http://desk.test:7433", "http://127.0.0.1:7433"]],
    ]);
  });

  it("answers something plain until the test scripts an answer, then the scripted one, still recording the call", async () => {
    const shell = fakeShell();
    expect(await shell.service.status()).toEqual({ installed: true, running: true, ready: true });
    expect(await shell.clipboard.readImage()).toBeUndefined();
    await expect(shell.http("http://desk.test:7433/.well-known/agent-harness/environment")).rejects.toThrow("fetch failed");

    shell.answer("service.status", async () => ({ installed: false, running: false, ready: false }));
    shell.answer("clipboard.readImage", async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }));
    shell.answer("http", async (url) => ({ status: 200, json: async () => ({ asked: url }) }));
    shell.answer("system", async () => ({ platform: "darwin", architecture: "arm64", hostname: "laptop", user: "david" }));

    expect(await shell.service.status()).toEqual({ installed: false, running: false, ready: false });
    expect(await shell.clipboard.readImage()).toEqual({ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" });
    expect(await (await shell.http("http://desk.test:7433/api/pair", { method: "POST" })).json()).toEqual({ asked: "http://desk.test:7433/api/pair" });
    expect(await shell.system()).toEqual({ platform: "darwin", architecture: "arm64", hostname: "laptop", user: "david" });
    expect(shell.calls.filter(([member]) => member === "service.status")).toHaveLength(2);
    expect(shell.calls).toContainEqual(["http", "http://desk.test:7433/api/pair", { method: "POST" }]);
  });

  it("hands each preview its own URL on the preview scheme", async () => {
    const shell = fakeShell();
    const page = await shell.preview.grant({ bytes: new Uint8Array([60, 104, 49, 62]), mediaType: "text/html" });
    const image = await shell.preview.grant({ bytes: new Uint8Array([60, 115, 118, 103]), mediaType: "image/svg+xml" });
    expect(page).toMatch(/^agent-harness-preview:/);
    expect(image).toMatch(/^agent-harness-preview:/);
    expect(image).not.toBe(page);
  });

  it("keeps secrets as a keychain does", async () => {
    const shell = fakeShell();
    await shell.secrets.set("0199aa00-0000-7000-8000-000000000001", "token-for-tests");
    expect(await shell.secrets.get("0199aa00-0000-7000-8000-000000000001")).toBe("token-for-tests");
    await shell.secrets.delete("0199aa00-0000-7000-8000-000000000001");
    expect(await shell.secrets.get("0199aa00-0000-7000-8000-000000000001")).toBeUndefined();
  });

  it("opens a deep link on demand to every listener onOpen holds, and to none that has unsubscribed", () => {
    const shell = fakeShell();
    const first: string[] = [];
    const second: string[] = [];
    const stop = shell.deepLinks.onOpen((url) => first.push(url));
    shell.deepLinks.onOpen((url) => second.push(url));

    shell.openDeepLink("agent-harness://pair?code=K7Q2MXH4RT");
    stop();
    shell.openDeepLink("agent-harness://open/desk/1");

    expect(first).toEqual(["agent-harness://pair?code=K7Q2MXH4RT"]);
    expect(second).toEqual(["agent-harness://pair?code=K7Q2MXH4RT", "agent-harness://open/desk/1"]);
  });

  it("clicks a notification it showed on demand, handing its tag to onActivate's listeners", async () => {
    const shell = fakeShell();
    const activated: string[] = [];
    const stop = shell.notifications.onActivate((tag) => activated.push(tag));
    await shell.notifications.show({ title: "Waiting for you", body: "Fix the rail", tag: "open desk 1" });

    shell.activateNotification("open desk 1");
    expect(activated).toEqual(["open desk 1"]);
    stop();
    shell.activateNotification("open desk 1");
    expect(activated).toEqual(["open desk 1"]);
  });

  it("refuses to click a notification it never showed with that tag", async () => {
    const shell = fakeShell();
    await shell.notifications.show({ title: "Run ended", body: "desk" });
    expect(() => shell.activateNotification("open desk 1")).toThrow("open desk 1");
  });

  it("is the shell the in-memory platform takes: a runtime on it has every member, and a call through the platform lands in the record", async () => {
    const shell = fakeShell();
    const platform = inMemoryPlatform({ kind: "desktop", shell });
    const runtime = createRuntime(platform);
    for (const member of SHELL_MEMBERS) expect(runtime.capability("any", member), member).toEqual({ status: "present" });

    platform.shell?.window?.setTitle("agent-harness: needs you");
    expect(shell.calls).toEqual([["window.setTitle", "agent-harness: needs you"]]);
    await runtime.close();
  });
});
