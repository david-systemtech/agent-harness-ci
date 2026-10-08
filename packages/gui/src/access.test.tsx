import { act, screen, waitFor, within } from "@testing-library/react";
import { clockTime } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Access row, `environments.access` (docs/specs/gui.md, "Settings";
 * the env spec's pairing and access; the permissions spec's ceilings;
 * ADR 0006, ADR 0027; #417): the client sessions that reach an environment
 * with their ceilings and revocation, program pairings beside them, and the
 * access log newest first. Driven through the harness over two scripted
 * environments: `desk`, this machine's, and `laptop`, paired.
 */

/** Two client sessions besides this client's own, and a program's. */
const OTHERS: ScriptedEnvironment["clientSessions"] = [
  { label: "laptop window", kind: "desktop", ceiling: "acceptEdits", lastSeenAt: "2025-03-01T12:00:00.000Z" },
  { label: "milo@laptop:pts/1", kind: "tui", scopes: ["read", "sessions:write"], ceiling: "plan", lastSeenAt: null },
  { label: "hermes", kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" },
];

/** The window with its two environments ready and no session open, each as `given` scripts it. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}) => {
  const app = await renderApp({
    environments: [
      { name: "desk", reach: "local", clientSessions: OTHERS, ...given.desk },
      { name: "laptop", reach: "paired", ...given.laptop },
    ],
  });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** A row's pane, by its label. */
const pane = (label: string) => within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: label });

/** Opens Settings on Access with Mod+, and the rail, as a person does, the picker on `environment` when it is given. */
const openAccess = async (app: RenderedApp, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Access" }));
  if (environment !== undefined) await app.user.selectOptions(within(pane("Access")).getByRole("combobox", { name: "Environment" }), environment);
  return pane("Access");
};

/** A part of the pane, by its heading. */
const part = (region: HTMLElement, name: string) => within(region).getByRole("region", { name });

/** A part of the pane once the client sessions are read, by its heading. */
const partRead = (region: HTMLElement, name: string) => within(region).findByRole("region", { name });

/** The client sessions a list shows, each by its label. */
const labels = async (region: HTMLElement, list: string) =>
  within(await within(region).findByRole("list", { name: list }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

/** A client session's item in a part, by its label. */
const item = (region: HTMLElement, label: string) => within(region).getByRole("listitem", { name: label });

describe("the client sessions", () => {
  it("lists each with its kind, label, scopes, ceiling, when it paired and when it was last seen, this client's own marked, and programs beside them", async () => {
    const app = await opened();
    const access = await openAccess(app);

    const sessions = part(access, "Client sessions");
    expect(await labels(sessions, "Client sessions")).toEqual(["laptop window", "milo@laptop:pts/1", "milo@desk:pts/3"]);
    expect(within(item(sessions, "laptop window")).getByText(/^Desktop window · every scope · paired \d\d:\d\d · last seen 1 Mar 2025 \d\d:\d\d$/)).toBeDefined();
    expect(within(item(sessions, "milo@laptop:pts/1")).getByText(/^Terminal UI · read, sessions:write · paired \d\d:\d\d · never seen$/)).toBeDefined();
    expect(within(item(sessions, "milo@desk:pts/3")).getByText(/^Terminal UI · every scope · paired \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(within(item(sessions, "milo@desk:pts/3")).getByText("This client")).toBeDefined();
    expect(within(item(sessions, "laptop window")).queryByText("This client")).toBeNull();
    expect((within(item(sessions, "laptop window")).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement).value).toBe("acceptEdits");
    expect((within(item(sessions, "milo@laptop:pts/1")).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement).value).toBe("plan");

    const programs = part(access, "Program pairings");
    expect(await labels(programs, "Programs")).toEqual(["hermes"]);
    expect(within(item(programs, "hermes")).getByText(/^Program · read, sessions:write, runs:drive · paired \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(app.environment("desk").requests("access.sessions.list")[0]?.params).toEqual({ live: true });
  });
});

describe("web clients", () => {
  /** Two phones and a tab: one paired before labels were built from the browser, two after. */
  const WEB: ScriptedEnvironment["clientSessions"] = [
    { label: "Browser tab", kind: "web", createdAt: "2025-03-01T12:00:00.000Z" },
    { label: "Chrome on Android (Home Screen)", kind: "web", createdAt: "2025-03-02T09:30:00.000Z" },
    { label: "Chrome on Android (tab)", kind: "web", lastSeenAt: null },
  ];

  it("are each named by the label they paired with, an older one keeping its stored label, and say when they paired", async () => {
    const app = await opened({ desk: { clientSessions: WEB } });
    const sessions = part(await openAccess(app), "Client sessions");

    expect(await labels(sessions, "Client sessions")).toEqual(["Browser tab", "Chrome on Android (Home Screen)", "Chrome on Android (tab)", "milo@desk:pts/3"]);
    expect(within(item(sessions, "Browser tab")).getByText(/^Browser · every scope · paired 1 Mar 2025 \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(within(item(sessions, "Chrome on Android (Home Screen)")).getByText(/^Browser · every scope · paired 2 Mar 2025 \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(within(item(sessions, "Chrome on Android (tab)")).getByText(/^Browser · every scope · paired \d\d:\d\d · never seen$/)).toBeDefined();
  });

  it("are confirmed by their label and when they paired before one is revoked, this client's own still marked", async () => {
    const app = await opened({ desk: { clientSessions: WEB } });
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");

    await app.user.click(within(item(sessions, "Chrome on Android (Home Screen)")).getByRole("button", { name: "Revoke…" }));
    const asked = await screen.findByRole("dialog", { name: "Revoke Chrome on Android (Home Screen) on desk?" });
    expect(within(asked).getByText(/^Browser · every scope · paired 2 Mar 2025 \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(within(asked).queryByText("This client")).toBeNull();
    await app.user.click(within(asked).getByRole("button", { name: "Cancel" }));

    await app.user.click(within(item(sessions, "milo@desk:pts/3")).getByRole("button", { name: "Revoke…" }));
    const own = await screen.findByRole("dialog", { name: "Revoke milo@desk:pts/3 on desk?" });
    expect(within(own).getByText(/^Terminal UI · every scope · paired \d\d:\d\d · last seen \d\d:\d\d$/)).toBeDefined();
    expect(within(own).getByText("This client")).toBeDefined();
  });
});

describe("a ceiling", () => {
  it("is changed through access.sessions.setCeiling and read again, while this client's own is shown and never sent", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");

    await app.user.selectOptions(within(item(sessions, "laptop window")).getByRole("combobox", { name: "Ceiling" }), "plan");
    expect(await within(pane("Access")).findByText("Changed laptop window's ceiling from acceptEdits to plan: its next run takes it.")).toBeDefined();
    expect(desk.requests("access.sessions.setCeiling").map((request) => request.params)).toEqual([
      expect.objectContaining({ clientSessionId: desk.clientSessions()[0]?.id, ceiling: "plan" }),
    ]);
    expect(desk.clientSessions().find((session) => session.label === "laptop window")?.ceiling).toBe("plan");
    await waitFor(() => expect((within(item(sessions, "laptop window")).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement).value).toBe("plan"));

    const own = within(item(sessions, "milo@desk:pts/3")).getByRole("combobox", { name: "Ceiling" });
    expect(own.hasAttribute("disabled")).toBe(true);
    expect(own.getAttribute("aria-describedby")).not.toBeNull();
    expect(within(item(sessions, "milo@desk:pts/3")).getByText("A client session cannot change its own ceiling; another admin session can.")).toBeDefined();
  });

  it("says why the environment refused a change in one line", async () => {
    const app = await opened({ desk: { receipts: { "access.sessions.setCeiling": { rejected: "forbidden", message: "Raising a client session to bypassPermissions is above this client session's own ceiling, auto." } } } });
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");
    await app.user.selectOptions(within(item(sessions, "milo@laptop:pts/1")).getByRole("combobox", { name: "Ceiling" }), "bypassPermissions");
    expect(await within(pane("Access")).findByText("Not changed: Raising a client session to bypassPermissions is above this client session's own ceiling, auto.")).toBeDefined();
    expect((within(item(sessions, "milo@laptop:pts/1")).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement).value).toBe("plan");
  });
});

describe("revoking", () => {
  it("asks once, revokes through access.sessions.revoke and lists the client sessions again without it", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");

    const revoke = within(item(sessions, "laptop window")).getByRole("button", { name: "Revoke…" });
    expect(revoke.querySelector("svg")).not.toBeNull();
    expect(revoke.title).toContain("Enter or Space");
    await app.user.click(within(item(sessions, "laptop window")).getByRole("button", { name: "Revoke…" }));
    const asked = await screen.findByRole("dialog", { name: "Revoke laptop window on desk?" });
    expect(within(asked).getByText("Its sockets close and its token is refused from then on; the client has to pair again to reach it.")).toBeDefined();
    expect(within(asked).queryByText(/this client's own session/)).toBeNull();
    expect(desk.requests("access.sessions.revoke")).toEqual([]);
    await app.user.click(within(asked).getByRole("button", { name: "Revoke" }));

    expect(await within(pane("Access")).findByText("Revoked laptop window: its token is refused from now on.")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Revoke laptop window on desk?" })).toBeNull();
    expect(desk.requests("access.sessions.revoke").map((request) => request.params)).toEqual([expect.objectContaining({ clientSessionId: desk.clientSessions()[0]?.id })]);
    expect(desk.clientSessions()[0]?.revokedAt).not.toBeNull();
    await waitFor(() => expect(within(sessions).queryByRole("listitem", { name: "laptop window" })).toBeNull());
  });

  it("warns once more before revoking this client's own, and a program's is revoked beside them", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const access = await openAccess(app);
    const sessions = part(access, "Client sessions");
    await labels(sessions, "Client sessions");

    await app.user.click(within(item(sessions, "milo@desk:pts/3")).getByRole("button", { name: "Revoke…" }));
    const asked = await screen.findByRole("dialog", { name: "Revoke milo@desk:pts/3 on desk?" });
    expect(within(asked).getByText("This is this client's own session: this window loses desk as soon as it is revoked, until it pairs with desk again.")).toBeDefined();
    await app.user.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Revoke milo@desk:pts/3 on desk?" })).toBeNull();
    expect(desk.requests("access.sessions.revoke")).toEqual([]);

    const programs = part(access, "Program pairings");
    await app.user.click(within(item(programs, "hermes")).getByRole("button", { name: "Revoke…" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Revoke hermes on desk?" })).getByRole("button", { name: "Revoke" }));
    expect(await within(pane("Access")).findByText("Revoked hermes: its token is refused from now on.")).toBeDefined();
    expect(await within(programs).findByText("No program is paired.")).toBeDefined();
  });
});

describe("a program pairing", () => {
  it("is made with the scopes and ceiling ticked through access.pairings.create, its code shown once, until it expires", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const programs = part(await openAccess(app), "Program pairings");
    const form = await within(programs).findByRole("group", { name: "Pair a program" });
    const scopes = () =>
      within(within(form).getByRole("group", { name: "Scopes" }))
        .getAllByRole("checkbox")
        .map((box) => [box.getAttribute("aria-label") ?? (box as HTMLInputElement).labels?.[0]?.textContent, box.getAttribute("aria-checked") === "true"]);
    // A program's preset (ADR 0025): read, sessions:write and runs:drive, up to acceptEdits.
    expect(scopes()).toEqual([
      ["read", true],
      ["sessions:write", true],
      ["runs:drive", true],
      ["terminal", false],
      ["admin", false],
    ]);
    expect((within(form).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement).value).toBe("acceptEdits");

    await app.user.click(within(form).getByRole("checkbox", { name: "runs:drive" }));
    await app.user.selectOptions(within(form).getByRole("combobox", { name: "Ceiling" }), "plan");
    const expiry = clockTime(new Date(app.clock.now().getTime() + 10 * 60_000).toISOString());
    await app.user.click(within(form).getByRole("button", { name: "Make a program's pairing code" }));

    expect(await within(form).findByText("K7Q2M-XH4RV")).toBeDefined();
    expect(within(form).getByText("Grants read and sessions:write, up to plan.")).toBeDefined();
    expect(within(form).getByText(`Expires at ${expiry}, for one use.`)).toBeDefined();
    expect(desk.requests("access.pairings.create").map((request) => request.params)).toEqual([expect.objectContaining({ scopes: ["read", "sessions:write"], ceiling: "plan" })]);

    // Shown once: gone once the pane is left, and gone at its expiry.
    await openAccess(app, "laptop");
    await openAccess(app, "desk");
    expect(within(pane("Access")).queryByText("K7Q2M-XH4RV")).toBeNull();
    const again = await within(part(pane("Access"), "Program pairings")).findByRole("group", { name: "Pair a program" });
    await app.user.click(within(again).getByRole("button", { name: "Make a program's pairing code" }));
    expect(await within(again).findByText("K7Q2M-XH4RW")).toBeDefined();
    act(() => app.clock.advance(10 * 60_000));
    expect(within(again).queryByText("K7Q2M-XH4RW")).toBeNull();
    expect(within(again).getByText(/^This code expired at \d\d:\d\d: make another\.$/)).toBeDefined();
  });

  it("is not made with no scope ticked", async () => {
    const app = await opened();
    const form = await within(part(await openAccess(app), "Program pairings")).findByRole("group", { name: "Pair a program" });
    for (const scope of ["read", "sessions:write", "runs:drive"]) await app.user.click(within(form).getByRole("checkbox", { name: scope }));
    expect(within(form).getByRole("button", { name: "Make a program's pairing code" }).hasAttribute("disabled")).toBe(true);
    expect(within(form).getByText("Tick at least one scope.")).toBeDefined();
  });
});

/** The laptop window's socket opening 45 times, a minute apart from 08:00 on 1 March 2025, each from its own address. */
const OPENINGS: ScriptedEnvironment["accessLog"] = Array.from({ length: 45 }, (_, index) => ({
  type: "socket.opened",
  payload: { clientSessionId: "0199cc00-0000-7000-8000-000000000001", socketId: `socket-${index + 1}`, remoteAddress: `100.64.0.${index + 1}` },
  occurredAt: new Date(Date.UTC(2025, 2, 1, 8, index)).toISOString(),
}));

describe("the access log", () => {
  it("reads access.log.list newest first, twenty to a page, each event in one line", async () => {
    const app = await opened({ desk: { accessLog: OPENINGS } });
    const log = await partRead(await openAccess(app), "Access log");
    const lines = async () =>
      within(await within(log).findByRole("list", { name: "Access log events" }))
        .getAllByRole("listitem")
        .map((event) => event.textContent);

    const first = await lines();
    expect(first).toHaveLength(20);
    expect(first[0]).toMatch(/^1 Mar 2025 \d\d:\d\d laptop window connected from 100\.64\.0\.45\.$/);
    expect(first[19]).toMatch(/ laptop window connected from 100\.64\.0\.26\.$/);
    expect(within(log).getByText("1 to 20 of 45, newest first")).toBeDefined();
    expect(within(log).getByRole("button", { name: "Newer" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(log).getByRole("button", { name: "Older" }));
    expect((await lines())[0]).toMatch(/ from 100\.64\.0\.25\.$/);
    expect(within(log).getByText("21 to 40 of 45, newest first")).toBeDefined();
    await app.user.click(within(log).getByRole("button", { name: "Older" }));
    expect((await lines()).map((line) => line?.replace(/^.* from /, ""))).toEqual(["100.64.0.5.", "100.64.0.4.", "100.64.0.3.", "100.64.0.2.", "100.64.0.1."]);
    expect(within(log).getByText("41 to 45 of 45, newest first")).toBeDefined();
    expect(within(log).getByRole("button", { name: "Older" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(log).getByRole("button", { name: "Newer" }));
    expect(within(log).getByText("21 to 40 of 45, newest first")).toBeDefined();
    expect(app.environment("desk").requests("access.log.list").map((request) => request.params)).toEqual([{ limit: 1000 }]);
  });

  it("reads it again after a verb, what the verb did newest", async () => {
    const app = await opened();
    const access = await openAccess(app);
    const log = await partRead(access, "Access log");
    expect(await within(log).findByText("The access log holds nothing yet.")).toBeDefined();

    const sessions = part(access, "Client sessions");
    await app.user.selectOptions(within(item(sessions, "laptop window")).getByRole("combobox", { name: "Ceiling" }), "auto");
    const newest = async () => within(await within(log).findByRole("list", { name: "Access log events" })).getAllByRole("listitem")[0]?.textContent;
    await waitFor(async () => expect(await newest()).toMatch(/ laptop window's ceiling went from acceptEdits to auto\.$/));

    const programs = part(access, "Program pairings");
    await app.user.click(within(programs).getByRole("button", { name: "Make a program's pairing code" }));
    await within(programs).findByText("K7Q2M-XH4RV");
    await app.user.click(within(log).getByRole("button", { name: "Read again" }));
    await waitFor(async () => expect(await newest()).toMatch(/ A pairing code was made\. Grants read, sessions:write and runs:drive, up to acceptEdits\.$/));
  });
});

describe("read-only", () => {
  it("says the capability's line once without admin, which every part of it needs", async () => {
    const app = await opened({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] } });
    const access = await openAccess(app, "laptop");
    expect(await within(access).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(access).queryByRole("region", { name: "Client sessions" })).toBeNull();
    expect(within(access).queryByRole("region", { name: "Access log" })).toBeNull();
    expect(app.environment("laptop").requests("access.sessions.list")).toEqual([]);
  });

  it("shows what this window last read, read-only, while the environment cannot be reached", async () => {
    const app = await opened({ laptop: { clientSessions: [{ label: "phone", kind: "web" }] } });
    const access = await openAccess(app, "laptop");
    const sessions = await partRead(access, "Client sessions");
    await labels(sessions, "Client sessions");

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(access).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    expect(await labels(sessions, "Client sessions")).toEqual(["phone", "milo@desk:pts/3"]);
    expect(within(item(sessions, "phone")).getByRole("combobox", { name: "Ceiling" }).hasAttribute("disabled")).toBe(true);
    expect(within(item(sessions, "phone")).getByRole("button", { name: "Revoke…" }).hasAttribute("disabled")).toBe(true);
    expect(within(await partRead(access, "Program pairings")).getByRole("button", { name: "Make a program's pairing code" }).hasAttribute("disabled")).toBe(true);
  });
});


describe("changing access", () => {
  it("offers full access, restricted phone and custom grants, applies and undoes a change without pairing again", async () => {
    const app = await opened();
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");
    expect(within(item(sessions, "milo@desk:pts/3")).getByRole("button", { name: "Change access" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(item(sessions, "milo@laptop:pts/1")).getByRole("button", { name: "Change access" }));
    const dialog = await screen.findByRole("dialog", { name: "Change access for milo@laptop:pts/1" });
    await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Access preset" }), "own-client");
    await app.user.click(within(dialog).getByRole("button", { name: "Save access" }));
    expect(await within(pane("Access")).findByText(/Changed milo@laptop:pts\/1's access/)).toBeDefined();
    expect(app.environment("desk").requests("access.sessions.setAccess")[0]?.params).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"], ceiling: "bypassPermissions" });
    await app.user.click(within(item(sessions, "milo@laptop:pts/1")).getByRole("button", { name: "Change access" }));
    await app.user.selectOptions(within(await screen.findByRole("dialog", { name: "Change access for milo@laptop:pts/1" })).getByRole("combobox", { name: "Access preset" }), "phone");
    await app.user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(app.environment("desk").clientSessions().find((s) => s.label === "milo@laptop:pts/1")).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" }));
    expect(app.environment("desk").requests("access.pairings.create")).toHaveLength(0);
  });
});


describe("access editor bounds", () => {
  it("limits custom grants to the editor's authority, cancels without saving and preserves a refused edit", async () => {
    const app = await opened({ desk: { scopes: ["read", "admin"], hello: { ceiling: "acceptEdits" }, receipts: { "access.sessions.setAccess": { rejected: "conflict", message: "The client has been revoked." } } } });
    const sessions = part(await openAccess(app), "Client sessions");
    await labels(sessions, "Client sessions");
    await app.user.click(within(item(sessions, "milo@laptop:pts/1")).getByRole("button", { name: "Change access" }));
    const dialog = await screen.findByRole("dialog", { name: "Change access for milo@laptop:pts/1" });
    expect((within(dialog).getByRole("option", { name: "Full access" }) as HTMLOptionElement).disabled).toBe(true);
    expect((within(dialog).getByRole("option", { name: "Restricted phone" }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(dialog).getByRole("checkbox", { name: "terminal" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(app.environment("desk").requests("access.sessions.setAccess")).toHaveLength(0);
    await app.user.click(within(item(sessions, "milo@laptop:pts/1")).getByRole("button", { name: "Change access" }));
    const custom = await screen.findByRole("dialog", { name: "Change access for milo@laptop:pts/1" });
    await app.user.click(within(custom).getByRole("checkbox", { name: "read" }));
    await app.user.click(within(custom).getByRole("checkbox", { name: "sessions:write" }));
    await app.user.click(within(custom).getByRole("checkbox", { name: "admin" }));
    await app.user.selectOptions(within(custom).getByRole("combobox", { name: "Run ceiling" }), "acceptEdits");
    await app.user.click(within(custom).getByRole("button", { name: "Save access" }));
    expect((await within(custom).findByRole("alert")).textContent).toBe("Not changed: The client has been revoked.");
    expect(app.environment("desk").requests("access.sessions.setAccess")[0]?.params).toMatchObject({ scopes: ["admin"], ceiling: "acceptEdits" });
  });
});
