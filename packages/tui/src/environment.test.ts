import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";
import { applyAction } from "./commands/environment.js";

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
/** A client session row as `access.sessions.list` answers it. */
const clientSessionRow = {
  kind: "desktop",
  createdAt: "2026-09-24T00:00:00.000Z",
  lastSeenAt: "2026-09-24T00:00:00.000Z",
  expiresAt: "2026-10-24T00:00:00.000Z",
  revokedAt: null,
  scopes: [...SCOPES],
  ceiling: Ceiling.parse("bypassPermissions"),
  local: false,
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

  it("sets the primary from the connections the runtime lists when it is chosen, not from a list an earlier frame drew", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    const runtime = app.runtime();
    const laptop = runtime.projections.environments.read().find((v) => v.name === "laptop");
    if (!laptop) throw new Error("no laptop");
    expect(await applyAction(runtime, laptop, "primary")).toBe("laptop is the primary environment.");
    expect(runtime.projections.environments.read().map((v) => [v.name, v.primary])).toEqual([
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

  it("gives a question the card asks the keys until it is answered: Esc declines it, and the card stays", async () => {
    const app = await twoEnvironments();
    await openActions(app, 1);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Remove laptop?");
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("Remove laptop?");
    expect(app.frame()).toContain("Set primary");
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
    expect(rowWith(app.frame(), "milo@desk:pts/3")).toContain("(this terminal)");
    expect(app.environment("laptop").requests("access.sessions.list")).toHaveLength(1);
    await app.press(KEY.enter);
    await app.waitFor("Revoke David's MacBook on laptop? y/n");
    await app.press("y");
    await app.waitFor("Revoked David's MacBook on laptop.");
    const [listed] = app.environment("laptop").requests("access.sessions.list");
    expect(listed).toBeDefined();
    expect(app.environment("laptop").requests("access.sessions.revoke")).toMatchObject([{ params: { clientSessionId: "0199cc00-0000-7000-8000-000000000001" } }]);
    // The card lists again, without the revoked row; this terminal's own stays.
    await app.waitUntil(() => app.environment("laptop").requests("access.sessions.list").length === 2, "the client sessions listed again");
    await app.waitFor(/milo@desk:pts\/3\s+tui/);
    expect(app.frame()).not.toMatch(/David's MacBook\s+desktop/);
  });

  it.each([
    { reach: "paired", index: 1, down: 3, line: "Revoked this client. Pair again to reconnect." },
    { reach: "local", index: 0, down: 2, line: "Revoked this client. Try again to reconnect." },
  ] as const)("counts its own revoked close before the reply as success on a $reach connection", async ({ index, down, line }) => {
    const app = await twoEnvironments({ clientSessions: [] });
    await app.waitFor("● desk ready");
    await openActions(app, index);
    for (let i = 0; i < down; i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("(this terminal)");
    await app.press(KEY.enter, "y");
    await app.waitFor(line);
    expect(app.frame()).toContain("blocked: revoked");
    expect(app.frame()).not.toContain("Cannot revoke");
    expect(app.frame()).not.toContain("Cannot list");
  });

  it("also gives the own-session reconnect line when the accepted receipt arrives", async () => {
    const app = await twoEnvironments({ clientSessions: [] });
    await app.waitFor("● desk ready");
    app.environment("laptop").wire.answer("access.sessions.revoke", () => ({
      result: { receipt: { status: "accepted", sequence: 7, changed: true }, result: { revokedAt: "2026-10-09T00:00:00.000Z" } },
    }));
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("(this terminal)");
    await app.press(KEY.enter, "y");
    await app.waitFor("Revoked this client. Pair again to reconnect.");
    expect(app.frame()).not.toContain("Client sessions on laptop");
  });

  it.each(["drop", "draining"] as const)("keeps a %s before the own-session reply as a failure", async (close) => {
    const app = await twoEnvironments({ clientSessions: [] });
    await app.waitFor("● desk ready");
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.wire.answer("access.sessions.revoke", () => {
      if (close === "drop") laptop.server.drop();
      else laptop.server.bye("draining");
      return undefined;
    });
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("(this terminal)");
    await app.press(KEY.enter, "y");
    await app.waitFor(`Cannot revoke milo@desk:pts/3 on laptop: The socket closed (${close === "drop" ? "1006" : "draining"}) before the environment answered.`);
    expect(app.frame()).not.toContain("Revoked this client");
  });

  it("keeps a revoked close during another session's revoke as a failure", async () => {
    const app = await twoEnvironments({ clientSessions: [{ label: "Other terminal", kind: "tui" }] });
    await app.waitFor("● desk ready");
    const laptop = app.environment("laptop");
    laptop.wire.answer("access.sessions.revoke", () => {
      laptop.server.bye("revoked");
      return undefined;
    });
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Other terminal");
    await app.press(KEY.enter, "y");
    await app.waitFor("Cannot revoke Other terminal on laptop: The socket closed (revoked) before the environment answered.");
    expect(app.frame()).not.toContain("Revoked this client");
  });

  it("keeps a refused own-session revoke's current failure line", async () => {
    const app = await twoEnvironments({ clientSessions: [] });
    await app.waitFor("● desk ready");
    app.environment("laptop").wire.answer("access.sessions.revoke", () => ({ error: { code: "unavailable", message: "The access tables are rebuilding.", data: {} } }));
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("(this terminal)");
    await app.press(KEY.enter, "y");
    await app.waitFor("Cannot revoke milo@desk:pts/3 on laptop: The access tables are rebuilding.");
    expect(app.frame()).not.toContain("Revoked this client");
  });

  it("keeps a rejected own-session revoke's current receipt line", async () => {
    const app = await twoEnvironments({ clientSessions: [], receipts: { "access.sessions.revoke": { rejected: "not_found", message: "No such client session." } } });
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("(this terminal)");
    await app.press(KEY.enter, "y");
    await app.waitFor("Revoking milo@desk:pts/3 on laptop was rejected: No such client session.");
    expect(app.frame()).not.toContain("Revoked this client");
  });

  it("draws only the latest listing when an earlier one answers after it", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    const pending: ((answer: FakeAnswer) => void)[] = [];
    const laptop = app.environment("laptop");
    laptop.wire.answer("access.sessions.list", () => new Promise<FakeAnswer>((resolve) => pending.push(resolve)));
    const row = (label: string) => ({ ...clientSessionRow, id: `0199cc00-0000-7000-8000-00000000000${pending.length}`, label });
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Listing…");
    await app.press(KEY.esc, KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitUntil(() => pending.length === 2, "a second listing");
    pending[1]?.({ result: { sessions: [row("Newer listing")] } });
    await app.waitFor("Newer listing");
    pending[0]?.({ result: { sessions: [row("Older listing")] } });
    await app.tick(3);
    expect(app.frame()).toContain("Newer listing");
    expect(app.frame()).not.toContain("Older listing");
  });

  it("goes back to the list of environments when the one whose client sessions are open is removed", async () => {
    const app = await twoEnvironments();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("David's MacBook");
    await app.runtime().connections.remove(app.environment("laptop").environmentId);
    await app.waitFor("Environments");
    expect(app.frame()).not.toContain("Client sessions on laptop");
    expect(app.frame()).toMatch(/› desk\s+local/);
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

  it("says why when the environment refuses to list its client sessions", async () => {
    const app = await twoEnvironments({ receipts: { "access.sessions.list": { rejected: "unavailable", message: "The access tables are rebuilding." } } });
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Cannot list the client sessions on laptop: The access tables are rebuilding.");
  });

  it("answers absent with the reason when the client session lacks admin", async () => {
    const app = await twoEnvironments({ scopes: SCOPES.filter((s) => s !== "admin") });
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Cannot list the client sessions on laptop: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    expect(app.environment("laptop").requests("access.sessions.list")).toHaveLength(0);
  });
});

/**
 * The environment's name, icon and colour from the terminal UI (#327;
 * workspace-picker spec, "Name, icon and colour"): `/environment rename`,
 * `icon` and `colour`, each a direct `admin` request through the runtime to
 * the header's environment or the one chosen on the card.
 */
describe("/environment rename, icon and colour", () => {
  const withSessions = (extra: Record<string, unknown> = {}) =>
    launch({
      script: {
        environments: [
          { name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }], ...extra },
          { name: "laptop", reach: "paired", sessions: [{ title: "Train tidy" }] },
        ],
      },
    });

  it("renames the header's environment with environment.rename and says the new name, which the rail, the header and the status line then draw", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await app.waitFor("DE · Fix the rail");
    await run(app, "/environment rename Tower  box");
    await app.waitFor("desk is now called Tower box.");
    expect(app.environment("desk").requests("environment.rename")).toMatchObject([{ params: { name: "Tower  box" } }]);
    expect(app.environment("laptop").requests("environment.rename")).toHaveLength(0);
    await app.waitFor("TB · Fix the rail");
    expect(rowWith(app.frame(), "agent-harness")).toContain("● Tower box ready");
    expect(app.frame()).toContain("TB Tower box · no session open");
  });

  it("says a name already held, and the refusal's reason when the environment rejects it", async () => {
    const app = await withSessions({ receipts: { "environment.rename": { rejected: "invalid_params", message: "That name is taken by a machine you use." } } });
    await app.waitFor("● desk ready");
    await run(app, "/environment rename tower");
    await app.waitFor("Renaming desk was rejected: That name is taken by a machine you use.");
    expect(rowWith(app.frame(), "agent-harness")).toContain("● desk ready");

    const other = await withSessions();
    await other.waitFor("● desk ready");
    await run(other, "/environment rename desk");
    await other.waitFor("desk is already called desk.");
  });

  it("refuses a name the environment would not take before sending it", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await run(app, `/environment rename ${"x".repeat(41)}`);
    await app.waitFor("A name is 1 to 40 characters, with no control characters; nothing was sent.");
    expect(app.environment("desk").requests("environment.rename")).toHaveLength(0);
  });

  it("renames the environment chosen on the card, the name typed into its picker", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await openActions(app, 1);
    for (const action of ["Rename", "Icon", "Colour"]) expect(app.frame()).toContain(action);
    await app.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Rename laptop");
    await app.type("Train box");
    await app.waitFor("Rename to Train box");
    await app.press(KEY.enter);
    await app.waitFor("laptop is now called Train box.");
    expect(app.environment("laptop").requests("environment.rename")).toMatchObject([{ params: { name: "Train box" } }]);
    expect(app.environment("desk").requests("environment.rename")).toHaveLength(0);
    await app.waitFor("TB · Train tidy");
  });

  it("sets the icon and the colour typed, and offers the ten icons and the twelve colours bare", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await run(app, "/environment icon server");
    await app.waitFor("desk's icon is now server.");
    expect(app.environment("desk").requests("environment.setIcon")).toMatchObject([{ params: { icon: "server" } }]);

    await run(app, "/environment colour teal");
    await app.waitFor("desk's colour is now teal.");
    expect(app.environment("desk").requests("environment.setColour")).toMatchObject([{ params: { colour: "teal" } }]);

    await run(app, "/environment icon");
    await app.waitFor("Icon for desk");
    for (const icon of ["laptop", "desktop", "server", "nas", "cloud", "container", "board", "home", "office", "lab"]) expect(app.frame()).toMatch(new RegExp(`│ (› | {2})${icon}\\b`));
    expect(rowWith(app.frame(), "› server")).toContain("now");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("desk's icon is now nas.");
    expect(app.environment("desk").requests("environment.setIcon")).toMatchObject([{ params: { icon: "server" } }, { params: { icon: "nas" } }]);

    await run(app, "/environment colour");
    await app.waitFor("Colour for desk");
    for (const colour of ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"]) expect(app.frame()).toContain(colour);
    expect(rowWith(app.frame(), "› teal")).toContain("now");
    await app.press(KEY.esc);
    expect(app.environment("desk").requests("environment.setColour")).toHaveLength(1);
  });

  it("says which icons and colours there are for one it does not know, sending nothing", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await run(app, "/environment colour magenta");
    await app.waitFor("There is no colour magenta: red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, violet or pink.");
    await run(app, "/environment icon toaster");
    await app.waitFor("There is no icon toaster: laptop, desktop, server, nas, cloud, container, board, home, office or lab.");
    await run(app, "/environment paint it");
    await app.waitFor("Usage: /environment, /environment rename <name>, /environment icon [icon] or /environment colour [colour].");
    expect(app.environment("desk").requests().filter((r) => r.method.startsWith("environment.set"))).toHaveLength(0);
  });

  it("answers the three with the capability's line without admin, sending nothing and opening no picker", async () => {
    const app = await withSessions({ scopes: SCOPES.filter((s) => s !== "admin") });
    await app.waitFor("● desk ready");
    const refusal = "This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.";
    await run(app, "/environment rename Tower");
    await app.waitFor(`Cannot rename desk: ${refusal}`);
    await run(app, "/environment icon");
    await app.waitFor(`Cannot set the icon of desk: ${refusal}`);
    expect(app.frame()).not.toContain("Icon for desk");
    await run(app, "/environment colour teal");
    await app.waitFor(`Cannot set the colour of desk: ${refusal}`);
    const desk = app.environment("desk");
    expect([...desk.requests("environment.rename"), ...desk.requests("environment.setIcon"), ...desk.requests("environment.setColour")]).toHaveLength(0);
  });

  it("redraws the rail, the status line and the open card for a rename another client makes, without a notice", async () => {
    const app = await withSessions();
    await app.waitFor("● desk ready");
    await app.waitFor("DE · Fix the rail");
    await run(app, "/environment");
    await app.waitFor("Environments");
    const notices = app.runtime().projections.notices.read().length;
    app.environment("desk").setLook({ name: "tower" });
    await app.waitFor(/› tower\s+local\s+ready/);
    await app.waitFor("TO · Fix the rail");
    expect(app.frame()).toContain("TO tower · no session open");
    expect(rowWith(app.frame(), "agent-harness")).toContain("● tower ready");
    expect(app.runtime().projections.notices.read()).toHaveLength(notices);
    expect(app.frame()).not.toContain("renamed");
  });
});
