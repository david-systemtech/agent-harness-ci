import { SCOPES } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * `/environment` (docs/specs/tui.md, "First launch"): the saved connections
 * with phase, version and "unreachable since", and per connection enable,
 * disable, remove, set primary and its client sessions, every one a runtime
 * or `access.*` call.
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
const run = async (app: RenderedApp, command: string) => {
  await app.type(command);
  await app.press(KEY.enter);
};
const rowWith = (frame: string, text: string) => frame.split("\n").find((row) => row.includes(text)) ?? "";

const twoEnvironments = (extra: Record<string, unknown> = {}) =>
  launch({
    script: {
      environments: [
        { name: "desk", reach: "local" },
        { name: "laptop", reach: "paired", clientSessions: [{ label: "David's MacBook", kind: "desktop" }], ...extra },
      ],
    },
  });

/** Opens `/environment` and the actions of the `index`th connection. */
const openActions = async (app: RenderedApp, index: number) => {
  await run(app, "/environment");
  for (let i = 0; i < index; i++) await app.press(KEY.down);
  await app.press(KEY.enter);
};

describe("/environment", () => {
  it("lists every connection with its kind, phase, version and primary mark", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await run(app, "/environment");
    await app.waitFor("Environments");
    expect(rowWith(app.frame(), "› desk")).toMatch(/desk\s+local\s+ready\s+0\.0\.0-fake\s+primary/);
    expect(rowWith(app.frame(), "  laptop")).toMatch(/laptop\s+paired\s+ready\s+0\.0\.0-fake/);
  });

  it("shows since when a connection has not been reached", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await run(app, "/environment");
    await app.waitFor(/laptop\s+paired\s+reconnecting\s+0\.0\.0-fake\s*\n.*│\s+unreachable since \d\d:\d\d/);
  });

  it("moves with the arrows and k and j, and closes on Esc", async () => {
    const app = await twoEnvironments();
    await run(app, "/environment");
    await app.press("j");
    expect(rowWith(app.frame(), "›")).toContain("laptop");
    await app.press("k");
    expect(rowWith(app.frame(), "›")).toContain("desk");
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("Environments");
  });

  it("offers disable, remove, set primary and client sessions, and disables and enables", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.waitFor("Client sessions");
    for (const action of ["Disable", "Remove", "Set primary", "Client sessions"]) expect(app.frame()).toContain(action);
    await app.press(KEY.enter);
    await app.waitFor("laptop is disabled");
    expect(app.runtime().projections.environments.read().find((v) => v.name === "laptop")).toMatchObject({ enabled: false, phase: "disabled" });
    await app.waitFor("Enable");
    await app.press(KEY.enter);
    await app.waitFor("laptop is enabled.");
    await app.waitUntil(() => app.runtime().projections.environments.read().find((v) => v.name === "laptop")?.phase === "ready", "laptop ready again");
  });

  it("sets the primary environment", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("laptop is the primary environment.");
    expect(app.runtime().projections.environments.read().map((v) => [v.name, v.primary])).toEqual([
      ["laptop", true],
      ["desk", false],
    ]);
  });

  it("removes a connection once confirmed, revoking its client session there", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Remove laptop? Its client session there is revoked and its saved connection forgotten. y/n");
    await app.press("y");
    await app.waitFor("Removed laptop; its client session there is revoked.");
    expect(app.runtime().projections.environments.read().map((v) => v.name)).toEqual(["desk"]);
  });

  it("keeps a connection when the removal is declined", async () => {
    const app = await twoEnvironments();
    await openActions(app, 1);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Remove laptop?");
    await app.press("n");
    expect(app.runtime().projections.environments.read().map((v) => v.name)).toEqual(["desk", "laptop"]);
  });

  it("says why the local environment cannot be removed", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 0);
    await app.press(KEY.down, KEY.enter);
    await app.press("y");
    await app.waitFor("disable it instead");
  });

  it("lists the client sessions, marks this terminal's, and revokes one once confirmed", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Client sessions on laptop");
    await app.waitFor("David's MacBook");
    expect(rowWith(app.frame(), "seth@desk:pts/3")).toContain("(this terminal)");
    expect(app.environment("laptop").requests("access.sessions.list")).toHaveLength(1);
    await app.press(KEY.enter);
    await app.waitFor("Revoke David's MacBook on laptop? y/n");
    await app.press("y");
    await app.waitFor("Revoked David's MacBook on laptop.");
    expect(app.environment("laptop").requests("access.sessions.revoke")).toMatchObject([{ params: { clientSessionId: expect.any(String) } }]);
    await app.tick(3);
    expect(app.frame()).not.toContain("David's MacBook  ");
  });

  it("says a rejected revoke as the receipt gives it", async () => {
    const app = await twoEnvironments({ receipts: { "access.sessions.revoke": { rejected: "not_found", message: "No such client session." } } });
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("David's MacBook");
    await app.press(KEY.enter, "y");
    await app.waitFor("Revoking David's MacBook on laptop was rejected: No such client session.");
  });

  it("answers absent with the reason when the client session lacks admin", async () => {
    const app = await twoEnvironments({ scopes: SCOPES.filter((s) => s !== "admin") });
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Cannot list the client sessions on laptop: This client was paired with laptop without the admin scope.");
    expect(app.environment("laptop").requests("access.sessions.list")).toHaveLength(0);
  });
});
