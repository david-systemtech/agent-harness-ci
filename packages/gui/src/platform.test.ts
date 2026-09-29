import { createRuntime } from "@agent-harness/client-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { browserNetwork, browserPlatform, systemClock } from "./platform/browser-platform.js";

/**
 * The bundle's platform (docs/specs/gui.md, "The desktop platform"): what the
 * runtime needs from the window, from what every browser has.
 */
describe("the bundle's platform", () => {
  it("follows the browser's online and offline events", () => {
    const network = browserNetwork(window);
    const seen: boolean[] = [];
    network.subscribe((state) => seen.push(state.online));
    const online = vi.spyOn(window.navigator, "onLine", "get");

    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(network.read()).toMatchObject({ online: false });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);
    online.mockRestore();
  });

  it("is in the foreground while the page is visible", () => {
    const network = browserNetwork(window);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(network.read()).toMatchObject({ foreground: false });
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(network.read()).toMatchObject({ foreground: true });
    visibility.mockRestore();
  });

  it("runs a timer on the system clock, and cancels one", async () => {
    const clock = systemClock();
    const ran: string[] = [];
    clock.setTimeout(() => ran.push("due"), 0).cancel();
    await new Promise<void>((resolve) => clock.setTimeout(() => (ran.push("ran"), resolve()), 1));
    expect(ran).toEqual(["ran"]);
  });

  it("is a browser tab's, with its version, keeping documents as JSON in memory", async () => {
    const platform = browserPlatform(window, "0.5.0");
    expect(platform.client).toEqual({ kind: "web", label: "Browser tab", version: "0.5.0" });
    await platform.documents.set("presentation", { format: 1 });
    expect(await platform.documents.get("presentation")).toEqual({ format: 1 });
    await expect(platform.documents.set("x", { cut: BigInt(1) })).rejects.toThrow();
  });

  it("has no shell, so this computer's gh is absent with its reason in a browser tab (#320)", () => {
    const platform = browserPlatform(window, "0.5.0");
    expect(platform.shell).toBeUndefined();
    const runtime = createRuntime(platform);
    onTestFinished(() => runtime.close());
    expect(runtime.capability("any", "shell.gh")).toEqual({
      status: "absent",
      reason: "no-shell",
      message: "This client cannot read the gh signed in on this computer: its shell has no shell.gh.",
    });
  });
});
