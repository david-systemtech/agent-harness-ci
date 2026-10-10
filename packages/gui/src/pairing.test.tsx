import { act, screen, waitFor, within } from "@testing-library/react";
import { CredentialAccessUnansweredError, LOCAL_PLACEHOLDER_ID, pairingDeepLink } from "@agent-harness/client-runtime";
import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Pairing the window (setup-copy.md §4.2; docs/specs/gui.md, "The local
 * environment, pairing and updates"): a pasted link, an `agent-harness://`
 * deep link or an address and code, through `connections.add`; each typed
 * failure an alert in the runtime's plain words, the raw failure in Details;
 * a revoked or expired connection paired again in place; a blocked
 * connection showing its action. Driven through the harness over the
 * scripted environments.
 */

const OFF = { presentation: { runLocalEnvironment: false } } as const;

/** The window with nothing paired and "Run agent-harness on this computer" off: it opens on pairing. */
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

/** Opens the fold Type an address and code instead in `place`, and its form. */
const byCode = async (app: RenderedApp, place: HTMLElement) => {
  act(() => within(place).getByRole("button", { name: "Type an address and code instead" }).focus());
  await app.user.keyboard("{Enter}");
  return within(place).getByRole("form", { name: "Pair by address and code" });
};

/** The pairing form's refusal in `place`, once it is said: an alert, its line first. */
const refusalIn = (place: HTMLElement) =>
  waitFor(() => {
    const refusal = place.querySelector<HTMLElement>("[data-pairing-refusal]");
    expect(refusal?.getAttribute("role")).toBe("alert");
    return refusal as HTMLElement;
  });

/** A refusal's line, without the hidden "Error: " a screen reader reads first. */
const lineOf = (refusal: HTMLElement) => refusal.querySelector("[data-pairing-line]")?.textContent?.replace(/^Error: /, "");

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
    const { app, pane } = await onPairing();
    const form = await byCode(app, pane);
    expect(within(form).getByLabelText("Address").tagName).toBe("INPUT");
    expect(within(form).getByLabelText("Pairing code").tagName).toBe("INPUT");
    for (const field of within(form).getAllByRole("textbox")) expect(field.getAttribute("placeholder")).toBeNull();
    const action = within(form).getByRole("button", { name: "Pair" });
    expect(action.querySelector("svg")).not.toBeNull();
    act(() => action.focus());
    expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Pair · Enter");
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

  it.each([
    ["fresh-item", "Stored credentials in a fresh protected item."],
    ["retained-item", "Stored credentials using the existing protected item."],
  ] as const)("says the %s storage path in the pairing result", async (storage, message) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    app.shell.answer("secrets.set", async () => storage);
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    await pasteLink(app, dialog, app.environment("laptop").wire.link);
    expect(await within(dialog).findByText(`Connected to laptop. ${message}`)).toBeDefined();
  });

  it("pairs from an address and a code, typed in the sidebar's pairing dialog", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    const form = await byCode(app, dialog);
    await typeInto(app, within(form).getByRole("textbox", { name: "Address" }), app.environment("laptop").wire.origin);
    await typeInto(app, within(form).getByRole("textbox", { name: "Pairing code" }), "k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    expect(await within(dialog).findByText("Connected to laptop.")).toBeDefined();
    expect(within(dialog).getByText("Paste the pairing link from the other computer.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("offers Set up on the computer once connected from the dialog, which closes it and opens Set up there", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired", capabilities: ["setup"] }] });
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    await pasteLink(app, dialog, app.environment("laptop").wire.link);
    await app.user.click(await within(dialog).findByRole("button", { name: "Set up laptop" }));
    const checklist = await screen.findByRole("region", { name: "Set up" });
    expect(within(within(checklist).getByRole("combobox", { name: /^(Environment|Setting up)$/ })).getByRole("option", { selected: true }).textContent).toBe("laptop");
    expect(screen.queryByRole("dialog", { name: "Connect to another computer" })).toBeNull();
  });

  it("says where macOS's Keychain prompt waits while pairing, and once it went unanswered offers Try again with the same code", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    let unanswered!: (error: Error) => void;
    app.shell.answer("secrets.protection", () => new Promise((_resolve, reject) => { unanswered = reject; }));
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    const form = await byCode(app, dialog);
    await typeInto(app, within(form).getByRole("textbox", { name: "Address" }), app.environment("laptop").wire.origin);
    await typeInto(app, within(form).getByRole("textbox", { name: "Pairing code" }), "k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["secrets.protection"]));

    await act(async () => app.shell.changeSecretAccess("waiting"));
    expect(within(dialog).getByText("Pairing…")).toBeDefined();
    await act(async () => app.clock.advance(500));
    expect(within(dialog).getByRole("status").textContent).toBe("Your Mac is asking to use agent-harness's saved key. Find the Mac's dialog and choose Always Allow.");

    // The rejection as Electron's IPC hands it to a renderer that does not unwrap it: the form says its own words regardless.
    await act(async () => {
      unanswered(new Error(`Error invoking remote method 'shell:secrets.protection': Error: ${new CredentialAccessUnansweredError(30).message}`));
      app.shell.changeSecretAccess("denied");
    });
    const status = await refusalIn(dialog);
    expect(lineOf(status)).toBe("Your Mac's question was not answered, so pairing stopped. Choose Always Allow, then Try again.");

    app.shell.answer("secrets.protection", async () => "os");
    await act(async () => app.shell.changeSecretAccess(null));
    await app.user.click(within(status).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Connected to laptop.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("asks for a new code, not Try again, when the Keychain prompt went unanswered after the code was spent", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    app.shell.answer("secrets.set", () => Promise.reject(new Error(new CredentialAccessUnansweredError(30).message)));
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    const form = await byCode(app, dialog);
    await typeInto(app, within(form).getByRole("textbox", { name: "Address" }), app.environment("laptop").wire.origin);
    await typeInto(app, within(form).getByRole("textbox", { name: "Pairing code" }), "k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));

    const status = await refusalIn(dialog);
    expect(lineOf(status)).toBe("Your Mac's question was not answered, so pairing stopped. Choose Always Allow, then make a new code: this one was used.");
    expect(within(status).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("pairs from an agent-harness:// deep link the desktop is handed", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    await within(sidebar()).findByRole("heading", { name: "desk" });
    app.shell.openDeepLink(pairingDeepLink(app.environment("laptop").wire.link));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    expect(await within(dialog).findByText("Connected to laptop.")).toBeDefined();
    expect(within(sidebar()).getByRole("heading", { name: "laptop", hidden: true })).toBeDefined();
  });

  it("leaves a deep link that carries no pairing link alone", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await within(sidebar()).findByRole("heading", { name: "desk" });
    app.shell.openDeepLink("agent-harness://open/desk/1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  const failures: readonly (readonly [string, Partial<ScriptedEnvironment>, { readonly protocolVersion?: number }, RegExp, RegExp])[] = [
    ["expired-code", { pairing: "expired-code" }, {}, /^This code has run out\. Make a new code on the other computer\.$/, /pairing_expired/],
    ["used-code", { pairing: "used-code" }, {}, /^This code was already used\. Make a new code on the other computer\.$/, /pairing_used/],
    ["invalid-code", { pairing: "invalid-code" }, {}, /^The other computer does not know this code\. Check it, or make a new one\.$/, /pairing_invalid/],
    ["unreachable", { discovery: "nothing" }, {}, /^Nothing answered at laptop\.test:\d+\. Check that the other computer is on and that both are connected to Tailscale\.$/, /Nothing answered at http:/],
    ["unsupported-client", { protocolVersion: PROTOCOL_VERSION + 1 }, {}, /^This app and laptop run versions that cannot talk\. Update this app, then pair again\.$/, /update this client/],
    ["protocol-mismatch", {}, { protocolVersion: PROTOCOL_VERSION + 1 }, /^This app and laptop run versions that cannot talk\. Update laptop, then pair again\.$/, /update the environment/],
    ["not-ready", { discovery: "starting" }, {}, /^The other computer is still starting\. Try again in a moment\.$/, /laptop is starting/],
    ["different-environment", { hello: { environmentId: "0199aa00-0000-7000-8000-0000000000ff" } }, {}, /^That address reaches a different computer than the one that made the code\. Make a new code and try again\.$/, /not the one its address named/],
  ];

  it.each(failures)("says the %s failure as an alert in plain words, the raw failure in Details, and pairs nothing", async (_reason, laptop, options, words, raw) => {
    const { app, pane } = await onPairing(laptop, options);
    await pasteLink(app, pane, app.environment("laptop").wire.link);
    const alert = await refusalIn(pane);
    expect(lineOf(alert)).toMatch(words);
    await app.user.click(within(alert).getByRole("button", { name: "Details" }));
    expect(alert.querySelector("pre")?.textContent).toMatch(raw);
    expect(app.runtime.connections.list.read().map((record) => record.environmentId)).toEqual([LOCAL_PLACEHOLDER_ID]);
  });

  it("says a link that is not a pairing link, sending nothing", async () => {
    const { app, pane, laptop } = await onPairing();
    await pasteLink(app, pane, `${laptop.wire.origin}/pair`);
    expect(await within(pane).findByText("That is not a pairing link. A pairing link ends with /pair# and a code.")).toBeDefined();
    expect(laptop.wire.discoveries()).toBe(0);
  });

  it("offers to connect a computer connected already again in place, and does on Connect again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair with an environment…" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to another computer" });
    await pasteLink(app, dialog, app.environment("laptop").wire.link);
    expect(await within(dialog).findByText("laptop is already connected. Connect again?")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Connect again" }));
    expect(await within(dialog).findByText("Connected to laptop.")).toBeDefined();
    expect(app.runtime.connections.list.read().filter((record) => record.kind === "paired")).toHaveLength(1);
  });
});

describe("a blocked connection", () => {
  it.each(["revoked", "expired"] as const)("shows %s with Pair again, which pairs it again in place", async (reason) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    const laptop = app.environment("laptop");
    await within(sidebar()).findByRole("heading", { name: "laptop" });
    laptop.bye(reason);
    const line = reason === "revoked" ? "This app's access to laptop was taken away. Pair again." : "This app's access to laptop has run out. Pair again.";
    expect(await within(sidebar()).findByText(line)).toBeDefined();

    await app.user.click(within(sidebar()).getByRole("button", { name: "Pair again" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair laptop again" });
    await pasteLink(app, dialog, laptop.wire.link);
    expect(await within(dialog).findByText("Connected to laptop.")).toBeDefined();
    await waitFor(() => expect(within(sidebar()).queryByText(line)).toBeNull());
    expect(app.runtime.connections.list.read().find((record) => record.environmentId === laptop.environmentId)).toMatchObject({ phase: "ready", blocked: null });
  });

  it("says a newer environment's action: update this client", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    await within(sidebar()).findByRole("heading", { name: "laptop" });
    app.environment("laptop").bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await within(sidebar()).findByText("laptop runs a newer agent-harness than this app. Update this app.")).toBeDefined();
  });

  it("says an older environment's action: update it to this client's version, when it can update itself", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await within(sidebar()).findByText("desk runs an older agent-harness than this app. Update desk.")).toBeDefined();
  });
});
