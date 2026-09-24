import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * First launch (docs/specs/tui.md, "First launch: local detection, service
 * down, pairing"): the local environment through the bootstrap grant with no
 * prompt; a stopped service offered a start on one key, then `starting`
 * until `ready`; "install and start it" when no service is installed; the
 * pairing prompt when there is no grant and nothing paired.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});
const launch = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};

const OFFER = "The environment on this machine is not running. Start it? y/n";
const DESK = "0199aa00-0000-7000-8000-00000000d35c";

/** The rows of the frame holding `text`. */
const rowsWith = (frame: string, text: string) => frame.split("\n").filter((row) => row.includes(text));

describe("first launch through the grant", () => {
  it("exchanges the grant for a tui local client session and shows the header and the rail, asking nothing", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local" }] } });
    await app.waitFor("● desk ready");
    const frame = app.frame();
    expect(rowsWith(frame, "agent-harness")[0]).toContain("● desk ready");
    expect(rowsWith(frame, "desk").length).toBeGreaterThanOrEqual(2);
    expect(frame).toContain("no sessions");
    expect(frame).not.toContain("Pair this terminal");
    expect(frame).not.toContain("y/n");
    expect(app.runtime().connections.list.read()).toMatchObject([{ kind: "local", phase: "ready" }]);
    expect(app.environment("desk").server.received()).toContainEqual(expect.objectContaining({ type: "auth", clientKind: "tui" }));
  });

  it("shows the workspace in the header", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local" }] }, flags: { workspace: "~/code/brandsolidate" } });
    expect(app.frame().split("\n")[0]).toContain("~/code/brandsolidate");
  });
});

describe("service down", () => {
  it("offers to start it on one line above the composer when the grant file is there and discovery is silent", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] } });
    await app.waitFor(OFFER);
    const rows = app.frame().split("\n");
    const offer = rows.findIndex((row) => row.includes(OFFER));
    expect(rows[offer + 1]).toContain("›");
    expect(rowsWith(app.frame(), "y/n")).toHaveLength(1);
  });

  it("runs the service start verb on y, then shows starting until ready", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] } });
    await app.waitFor(OFFER);
    await app.press("y");
    expect(app.service.calls).toEqual(["start"]);
    expect(app.frame()).toContain("starting");
    expect(app.frame()).not.toContain(OFFER);
    await app.advance(3000);
    expect(app.frame()).toContain("starting");
    app.environment("desk").discovery("ready");
    await app.waitFor("● desk ready");
    expect(app.frame()).not.toContain("starting");
    expect(app.runtime().connections.list.read()).toMatchObject([{ kind: "local", phase: "ready" }]);
  });

  it("does the same for a local environment it knew, which the runtime lists while its service is down", async () => {
    const first = await launch({ script: { environments: [{ name: "desk", reach: "local", environmentId: DESK }] } });
    await first.waitFor("● desk ready");
    await first.unmount();
    apps = [];

    const app = await launch({
      script: { environments: [{ name: "desk", reach: "local", environmentId: DESK, discovery: "nothing" }] },
      platform: first.platform,
    });
    await app.waitFor(OFFER);
    expect(app.frame()).toContain("service down");
    await app.press("y");
    expect(app.service.calls).toEqual(["start"]);
    await app.waitFor("● desk starting");
    app.environment("desk").discovery("ready");
    await app.waitFor("● desk ready");
  });

  it("offers to install and start it when no service is installed", async () => {
    const app = await launch({
      script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] },
      service: { installed: false },
    });
    await app.waitFor("The environment on this machine is not running. Install and start it? y/n");
    await app.press("y");
    expect(app.service.calls).toEqual(["install", "start"]);
    app.environment("desk").discovery("ready");
    await app.waitFor("● desk ready");
  });

  it("says why when the start fails, and offers again", async () => {
    const app = await launch({
      script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] },
      service: { start: { ok: false, message: "Could not run systemctl: no user manager." } },
    });
    await app.waitFor(OFFER);
    await app.press("y");
    await app.waitFor("Could not run systemctl: no user manager.");
    expect(app.frame()).toContain(OFFER);
  });

  it("leaves it stopped on n", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] } });
    await app.waitFor(OFFER);
    await app.press("n");
    expect(app.service.calls).toEqual([]);
    expect(app.frame()).not.toContain(OFFER);
    expect(app.frame()).toContain("agent-harness service start");
  });

  it("takes y and n as text once something is typed", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] } });
    await app.waitFor(OFFER);
    await app.type("/pa");
    await app.press("y");
    expect(app.service.calls).toEqual([]);
    expect(app.frame()).toContain("› /pay");
  });
});

describe("nothing local and nothing paired", () => {
  it("is the pairing prompt, with no offer when no service is installed", async () => {
    const app = await launch({ script: { environments: [] }, service: { installed: false } });
    await app.waitFor("Pair this terminal with an environment.");
    expect(app.frame()).toContain("/pair <link>");
    expect(app.frame()).toContain("/pair <address> <code>");
    expect(app.frame()).not.toContain("y/n");
    expect(app.frame().split("\n")[0]).toContain("no environment");
  });

  it("is the pairing prompt with the start offer when a service is installed but stopped", async () => {
    const app = await launch({ script: { environments: [] }, service: { installed: true } });
    await app.waitFor("Pair this terminal with an environment.");
    await app.waitFor(OFFER);
  });

  it("quits on Ctrl+C", async () => {
    const app = await launch({ script: { environments: [] }, service: { installed: false } });
    await app.press(KEY.ctrlC);
    expect(app.frame()).toBeDefined();
  });
});
