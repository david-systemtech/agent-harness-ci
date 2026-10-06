import { act, screen, waitFor, within } from "@testing-library/react";
import { CredentialAccessUnansweredError, LOCAL_PLACEHOLDER_ID, pairingDeepLink } from "@agent-harness/client-runtime";
import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Pairing the window (docs/specs/gui.md, "The local environment, pairing and
 * updates"): a pasted link, an `agent-harness://` deep link or an address
 * and code, through `connections.add`; each typed failure in one line, in
 * the runtime's words; a revoked or expired connection paired again in
 * place; a blocked connection showing its action. Driven through the
 * harness over the scripted environments.
 */

const OFF = { presentation: { runLocalEnvironment: false } } as const;

/** The window with nothing paired and "Run an environment on this machine" off: it opens on pairing. */
const onPairing = async (laptop: Partial<ScriptedEnvironment> = {}, options: { readonly protocolVersion?: number } = {}) => {
  const app = await renderApp({ environments: [{ name: "laptop", reach: "unpaired", ...laptop }] }, { ...OFF, ...options });
  const pane = await screen.findByRole("region", { name: "Pair with an environment" });
  return { app, pane, laptop: app.environment("laptop") };
};

/**
 * Types `text` into `field`, focused first rather than clicked: jsdom lays nothing out, so a click lands on the
 * sidebar's divider, which takes the focus.
 */
const typeInto = async (app: RenderedApp, field: HTMLElement, text: string) => {
  act(() => field.focus());
  await app.user.keyboard(text);
};

/** Pastes `link` into the pairing form in `place` and sends it. */
const pasteLink = async (app: RenderedApp, place: HTMLElement, link: string) => {
  const form = within(place).getByRole("form", { name: "Pair by link" });
  act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
  await app.user.paste(link);
  await app.user.click(within(form).getByRole("button", { name: "Pair" }));
};

/** The sidebar, read whether or not a dialog over the window hides it from the accessibility tree. */
const sidebar = () => screen.getByRole("navigation", { name: "Sessions", hidden: true });

describe("pairing", () => {
  it("labels pairing fields above their actions and gives actions icons and key hints", async () => {
    const { app } = await onPairing();
    const form = screen.getByRole("form", { name: "Pair by address and code" });
    expect(within(form).getByLabelText("Address").tagName).toBe("INPUT");
    expect(within(form).getByLabelText("Pairing code").tagName).toBe("INPUT");
    const action = within(form).getByRole("button", { name: "Pair with the code" });
    expect(action.querySelector("svg")).not.toBeNull();
    act(() => action.focus());
    expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Pair with the code · Enter");
    await app.user.keyboard("{Escape}");
  });

  it("pairs from a pasted link, and the window goes on to the environment", async () => {
    const { app, pane, laptop } = await onPairing();
    await pasteLink(app, pane, laptop.wire.link);
    expect(await within(sidebar()).findByRole("heading", { name: "laptop" })).toBeDefined();
    expect(await within(screen.getByRole("main")).findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(app.runtime.connections.list.read().find((record) => record.environmentId === laptop.environmentId)).toMatchObject({ kind: "paired", phase: "ready" });
    // The desktop's lockdown was told the address before the socket to it opened.
    expect(app.shell.calls).toContainEqual(["network.allow", expect.arrayContaining([laptop.wire.origin])]);
  });

  it("pairs from an address and a code, typed in the sidebar's pairing dialog", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair with an environment" });
    const form = within(dialog).getByRole("form", { name: "Pair by address and code" });
    await typeInto(app, within(form).getByRole("textbox", { name: "Address" }), app.environment("laptop").wire.origin);
    await typeInto(app, within(form).getByRole("textbox", { name: "Pairing code" }), "k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair with the code" }));
    expect(await within(dialog).findByText("Paired with laptop.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("says where macOS's Keychain prompt waits while pairing, and once it went unanswered offers Try again with the same code", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    let unanswered!: (error: Error) => void;
    app.shell.answer("secrets.protection", () => new Promise((_resolve, reject) => { unanswered = reject; }));
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair with an environment" });
    const form = within(dialog).getByRole("form", { name: "Pair by address and code" });
    await typeInto(app, within(form).getByRole("textbox", { name: "Address" }), app.environment("laptop").wire.origin);
    await typeInto(app, within(form).getByRole("textbox", { name: "Pairing code" }), "k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair with the code" }));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["secrets.protection"]));

    await act(async () => app.shell.changeSecretAccess("waiting"));
    expect(within(dialog).getByText("Pairing…")).toBeDefined();
    await act(async () => app.clock.advance(500));
    expect(within(dialog).getByRole("status").textContent).toBe(
      "macOS is asking to let agent-harness use its saved key. Look for the system dialog and choose Always Allow (it may ask for your Mac password).",
    );

    // The rejection as Electron's IPC hands it to a renderer that does not unwrap it: the form says its own words regardless.
    await act(async () => {
      unanswered(new Error(`Error invoking remote method 'shell:secrets.protection': Error: ${new CredentialAccessUnansweredError(30).message}`));
      app.shell.changeSecretAccess("denied");
    });
    const status = within(dialog).getByRole("status");
    expect(status.textContent).toContain(
      "Not paired: macOS asked to let agent-harness use its saved key and had no answer. Look for the system dialog and choose Always Allow (it may ask for your Mac password), then Try again.",
    );
    expect(status.textContent).not.toMatch(/Error invoking remote method|shell:secrets/);

    app.shell.answer("secrets.protection", async () => "os");
    await act(async () => app.shell.changeSecretAccess(null));
    await app.user.click(within(status).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Paired with laptop.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("pairs from an agent-harness:// deep link the desktop is handed", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    await within(sidebar()).findByRole("heading", { name: "desk" });
    app.shell.openDeepLink(pairingDeepLink(app.environment("laptop").wire.link));
    const dialog = await screen.findByRole("dialog", { name: "Pair with an environment" });
    expect(await within(dialog).findByText("Paired with laptop.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("leaves a deep link that carries no pairing link alone", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await within(sidebar()).findByRole("heading", { name: "desk" });
    app.shell.openDeepLink("agent-harness://open/desk/1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  const failures: readonly (readonly [string, Partial<ScriptedEnvironment>, { readonly protocolVersion?: number }, RegExp])[] = [
    ["expired-code", { pairing: "expired-code" }, {}, /^Not paired: The pairing code has expired/],
    ["used-code", { pairing: "used-code" }, {}, /^Not paired: The pairing code has been used already/],
    ["invalid-code", { pairing: "invalid-code" }, {}, /^Not paired: The environment issued no such pairing code/],
    ["unreachable", { discovery: "nothing" }, {}, /^Not paired: Nothing answered at /],
    ["unsupported-client", { protocolVersion: PROTOCOL_VERSION + 1 }, {}, /^Not paired: .*: update this client\.$/],
    ["protocol-mismatch", {}, { protocolVersion: PROTOCOL_VERSION + 1 }, /^Not paired: .*: update the environment\.$/],
    ["not-ready", { discovery: "starting" }, {}, /^Not paired: laptop is starting; try again once it is ready\.$/],
    ["different-environment", { hello: { environmentId: "0199aa00-0000-7000-8000-0000000000ff" } }, {}, /^Not paired: .* not the one its address named\.$/],
  ];

  it.each(failures)("says the %s failure in one line, and pairs nothing", async (_reason, laptop, options, words) => {
    const { app, pane } = await onPairing(laptop, options);
    await pasteLink(app, pane, app.environment("laptop").wire.link);
    const status = await within(pane).findByRole("status");
    await waitFor(() => expect(status.textContent).toMatch(/^Not paired: /));
    expect(status.textContent).toMatch(words);
    expect(status.textContent).not.toContain("\n");
    expect(app.runtime.connections.list.read().map((record) => record.environmentId)).toEqual([LOCAL_PLACEHOLDER_ID]);
  });

  it("says a link that is not a pairing link in one line, sending nothing", async () => {
    const { app, pane, laptop } = await onPairing();
    await pasteLink(app, pane, `${laptop.wire.origin}/pair`);
    expect(await within(pane).findByText("Not paired: That is not a pairing link: it looks like http://<address>/pair#<code>.")).toBeDefined();
    expect(laptop.wire.discoveries()).toBe(0);
  });

  it("offers to pair an environment paired already again in place, and does on Pair again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair with an environment" });
    await pasteLink(app, dialog, app.environment("laptop").wire.link);
    expect(await within(dialog).findByText("laptop is paired already. Pair it again in place?")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Pair again" }));
    expect(await within(dialog).findByText("Paired with laptop.")).toBeDefined();
    expect(app.runtime.connections.list.read().filter((record) => record.kind === "paired")).toHaveLength(1);
  });
});

describe("a blocked connection", () => {
  it.each(["revoked", "expired"] as const)("shows %s with Pair again, which pairs it again in place", async (reason) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    const laptop = app.environment("laptop");
    await within(sidebar()).findByRole("heading", { name: "laptop" });
    laptop.bye(reason);
    const line = reason === "revoked" ? "This client's access to laptop was revoked: pair it again." : "This client's access to laptop expired: pair it again.";
    expect(await within(sidebar()).findByText(line)).toBeDefined();

    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair again" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair laptop again" });
    await pasteLink(app, dialog, laptop.wire.link);
    expect(await within(dialog).findByText("Paired with laptop.")).toBeDefined();
    await waitFor(() => expect(within(sidebar()).queryByText(line)).toBeNull());
    expect(app.runtime.connections.list.read().find((record) => record.environmentId === laptop.environmentId)).toMatchObject({ phase: "ready", blocked: null });
  });

  it("says a newer environment's action: update this client", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    await within(sidebar()).findByRole("heading", { name: "laptop" });
    app.environment("laptop").bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await within(sidebar()).findByText("laptop is newer than this client: update this client.")).toBeDefined();
  });

  it("says an older environment's action: update it to this client's version, when it can update itself", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await within(sidebar()).findByText("desk is older than this client: update desk to this client's version.")).toBeDefined();
  });
});
