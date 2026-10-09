import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { SCOPES, type EnvironmentBinding } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Add a device on Your machines (setup-copy.md §5.5; ADR 0025; #577, #1847):
 * Part 1 asks who a code for this computer is for and makes it, with the
 * scopes and ceiling explicit, a choice above this client's own access dim
 * with why, and, while this computer is reachable only from itself, the
 * warning above the button and a code that says it works only here; Part 2
 * is the pairing form of §4.2, a link pasted or a QR scanned making the
 * computer a card offering Set up this machine, each refusal in §4.2's words
 * with the raw failure in Details; Part 3 installs agent-harness on another
 * computer from this computer's release; and Set up's "Set up another
 * computer" opens it. Driven through the harness over two scripted
 * environments: `desk`, this computer's, and `laptop`, unpaired until a test
 * pairs it.
 */

const NO_SESSION = "No session is open. Choose one from the sidebar.";

/** The window with `desk` ready and `laptop` as `given` scripts it (preset unpaired), no session open. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: RenderOptions = {}) => {
  const app = await renderApp(
    {
      environments: [
        { name: "desk", reach: "local", ...given.desk },
        { name: "laptop", reach: "unpaired", ...given.laptop },
      ],
    },
    options,
  );
  await screen.findByText(NO_SESSION);
  return app;
};

/** Opens Settings on Your machines, as a person does: Mod+, then its row on the rail. */
const openMachines = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  const settings = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Your machines" }));
  return within(settings).getByRole("region", { name: "Your machines" });
};

/** Add a device, on Your machines. */
const addADevice = async (app: RenderedApp) => within(await openMachines(app)).getByRole("region", { name: "Add a device" });

/** Pastes `link` into the pairing form and sends it. */
const pasteLink = async (app: RenderedApp, place: HTMLElement, link: string) => {
  const form = within(place).getByRole("form", { name: "Pair by link" });
  act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
  await app.user.paste(link);
  await app.user.click(within(form).getByRole("button", { name: "Pair" }));
};

/** The environment the full checklist checks, as its picker shows it. */
const pickedIn = (region: HTMLElement) => within(within(region).getByRole("combobox", { name: /^(Environment|Setting up)$/ })).getByRole("option", { selected: true }).textContent;

/** A computer bound to loopback alone: no tailnet address and no LAN address. */
const LOOPBACK_ALONE: { readonly binding: EnvironmentBinding } = { binding: { tailnet: null, tailnetFound: null, tailscaleInstalled: false, lan: null, lanAddresses: [] } };

describe("Add a device, Part 2: connect this app to another computer", () => {
  /** Part 2 of Add a device. */
  const partTwo = async (app: RenderedApp) => within(await addADevice(app)).getByRole("region", { name: "Connect this app to another computer" });

  it("pairs from a pasted link, and the computer becomes a card offering Set up this machine, which opens the checklist there on its first step needing attention", async () => {
    const app = await opened({
      laptop: {
        capabilities: ["setup"],
        setup: { permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] } },
      },
    });
    const pane = await openMachines(app);
    expect(within(pane).queryByRole("region", { name: "laptop" })).toBeNull();

    const part = within(within(pane).getByRole("region", { name: "Add a device" })).getByRole("region", { name: "Connect this app to another computer" });
    await pasteLink(app, part, app.environment("laptop").wire.link);
    const laptop = await within(pane).findByRole("region", { name: "laptop" });
    expect(within(part).getByRole("status").textContent).toBe("Connected to laptop.");
    expect(within(laptop).getByText("Paired with laptop: set it up now?")).toBeDefined();
    // Only the card the exchange made offers it.
    expect(within(within(pane).getByRole("region", { name: "desk" })).queryByRole("button", { name: "Set up this machine" })).toBeNull();

    await app.user.click(within(laptop).getByRole("button", { name: "Set up this machine" }));
    const checklist = await screen.findByRole("region", { name: "Set up" });
    expect(pickedIn(checklist)).toBe("laptop");
    const steps = within(checklist).getByRole("navigation", { name: "Set up steps" });
    await waitFor(() => expect(within(steps).getByRole("button", { current: "step" }).getAttribute("aria-label")).toBe("Permissions"));
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  });

  it("leaves the card, with no offer, on Not now", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    await pasteLink(app, within(pane).getByRole("region", { name: "Add a device" }), app.environment("laptop").wire.link);
    const laptop = await within(pane).findByRole("region", { name: "laptop" });
    await app.user.click(within(laptop).getByRole("button", { name: "Not now" }));
    expect(within(laptop).queryByRole("button", { name: "Set up this machine" })).toBeNull();
    expect(within(pane).getByRole("region", { name: "laptop" })).toBe(laptop);
  });

  it("says where a pairing link comes from under its field, with no example value in it", async () => {
    const app = await opened();
    const field = within(await partTwo(app)).getByRole("textbox", { name: "Pairing link" });
    expect(field.getAttribute("placeholder")).toBeNull();
    expect(field.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(field.getAttribute("aria-describedby") as string)?.textContent).toBe(
      "To get one, open Set up on that computer and choose Add a device. On a server, run agent-harness pair.",
    );
  });

  it("says nothing answered at the host, as an alert with what to check, never fetch failed in the line, and keeps the raw failure in Details", async () => {
    const app = await opened({ laptop: { discovery: "nothing" } });
    const part = await partTwo(app);
    const link = app.environment("laptop").wire.link;
    await pasteLink(app, part, link);
    const alert = await within(part).findByRole("alert");
    const host = new URL(link).host;
    const line = `Nothing answered at ${host}. Check that the other computer is on and that both are connected to Tailscale.`;
    // The line, read with a hidden "Error: " first; what the platform said ("fetch failed") and the URL are not in it.
    expect(within(alert).getByText("Error:").className).toContain("sr-only");
    expect(alert.textContent).toBe(`Error: ${line}Details`);
    await app.user.click(within(alert).getByRole("button", { name: "Details" }));
    expect(within(alert).getByText(new RegExp(`Nothing answered at http://${host.replace(/\./g, "\\.")}`), { selector: "pre" })).toBeDefined();
    // What the person pasted stays (setup-copy.md §1 rule 17).
    expect((within(part).getByRole("textbox", { name: "Pairing link" }) as HTMLInputElement).value).toBe(link);
  });

  it("says a link for this computer is for this computer, which this app is connected to already", async () => {
    const app = await opened();
    const part = await partTwo(app);
    await pasteLink(app, part, app.environment("desk").wire.link);
    expect(within(await within(part).findByRole("alert")).getByText("That link is for this computer. This app is already connected to it.")).toBeDefined();
  });

  it("pairs from an address and code typed in the fold Type an address and code instead", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    const part = within(within(pane).getByRole("region", { name: "Add a device" })).getByRole("region", { name: "Connect this app to another computer" });
    expect(within(part).queryByRole("form", { name: "Pair by address and code" })).toBeNull();
    await app.user.click(within(part).getByRole("button", { name: "Type an address and code instead" }));
    const form = within(part).getByRole("form", { name: "Pair by address and code" });
    act(() => within(form).getByRole("textbox", { name: "Address" }).focus());
    await app.user.keyboard(app.environment("laptop").wire.origin);
    act(() => within(form).getByRole("textbox", { name: "Pairing code" }).focus());
    await app.user.keyboard("k7q2m xh4rt");
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    expect(await within(pane).findByRole("region", { name: "laptop" })).toBeDefined();
  });

  it("offers Scan a QR code where the shell gives the window a camera, pairing with the link it reads", async () => {
    const shell = fakeShell();
    const app = await opened({}, { shell });
    shell.answer("camera.scanQr", async () => app.environment("laptop").wire.link);
    const pane = await openMachines(app);
    await app.user.click(within(within(pane).getByRole("region", { name: "Add a device" })).getByRole("button", { name: "Scan a QR code" }));
    expect(await within(pane).findByRole("region", { name: "laptop" })).toBeDefined();
    expect(shell.calls.filter(([member]) => member === "camera.scanQr")).toHaveLength(1);
  });

  it("says why there is no Scan a QR code where the shell gives the window no camera", async () => {
    const app = await opened({}, { shell: Object.assign(fakeShell(), { camera: undefined }) });
    const add = await addADevice(app);
    expect(within(add).queryByRole("button", { name: "Scan a QR code" })).toBeNull();
    expect(within(add).getByText("This app cannot scan a QR code here. Paste the link instead.")).toBeDefined();
  });

  it("is where Set up's Set up another computer opens, its link's field taking the focus", async () => {
    const app = await opened();
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Set up another computer" }));
    const add = within(within(settings).getByRole("region", { name: "Your machines" })).getByRole("region", { name: "Add a device" });
    expect(document.activeElement).toBe(within(add).getByRole("textbox", { name: "Pairing link" }));
  });
});

describe("Add a device, Part 3: install agent-harness on another computer", () => {
  /** Part 3 of Add a device. */
  const partThree = async (app: RenderedApp) => within(await addADevice(app)).getByRole("region", { name: "Install agent-harness on another computer" });

  it("numbers the steps, shows a copyable line per system from this computer's release, with its channel and the name typed, and the container's in Using Docker or Podman?, with How to set up the updater", async () => {
    const app = await opened({ desk: { settings: { "updates.channel": "beta" } } });
    const install = await partThree(app);
    const line = (platform: string) => within(within(install).getByRole("region", { name: platform })).getByText(/./, { selector: "pre" }).textContent;
    const release = "https://git.example.test/david/agent-harness/releases/download/v0.0.0-fake";
    const tokenToCurl = `printf 'header = "Authorization: token %s"\\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL`;

    expect(await within(install).findByRole("region", { name: "Mac or Linux" })).toBeDefined();
    expect(within(install).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      "1. On the other computer, open a terminal.",
      "2. Copy the line for its system and paste it.",
      "3. When it finishes, it shows a pairing link. Paste it in Part 2.",
    ]);
    // A private release's lines read a token, which every line needs.
    expect(within(install).getByText(/^This release is private\./).textContent).toBe("This release is private. Before you paste a line, set AGENT_HARNESS_TOKEN to a token that can read it.");
    expect(line("Mac or Linux")).toBe(`${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta`);
    act(() => within(install).getByRole("textbox", { name: "Name for the new computer (optional)" }).focus());
    await app.user.keyboard("Build box");
    expect(line("Mac or Linux")).toBe(`${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta --name 'Build box'`);
    expect(line("Windows (PowerShell)")).toBe(
      `& ([scriptblock]::Create((('header = "Authorization: token ' + $env:AGENT_HARNESS_TOKEN + '"') | curl.exe -K - -fsSL ${release}/install.ps1) -join "\`n")) -Channel beta -Name 'Build box'`,
    );
    await app.user.click(within(within(install).getByRole("region", { name: "Mac or Linux" })).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", `${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta --name 'Build box'`]);

    expect(within(install).queryByRole("region", { name: "Docker or Podman" })).toBeNull();
    await app.user.click(within(install).getByRole("button", { name: "Using Docker or Podman?" }));
    expect(within(install).getAllByRole("listitem").slice(3).map((step) => step.textContent)).toEqual([
      "1. Make a folder for it and open a terminal there.",
      "2. Copy this line and paste it.",
      "3. The pairing link appears in the container's log.",
      "4. To keep it up to date, set up the host updater.",
    ]);
    expect(line("Docker or Podman")).toBe(
      [
        `${tokenToCurl} -o compose.yaml ${release}/compose.yaml`,
        `${tokenToCurl} -o host-updater.sh ${release}/host-updater.sh`,
        "chmod +x host-updater.sh",
        "docker login git.example.test",
        "AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME='Build box' docker compose up -d",
        "docker compose logs environment",
      ].join("\n"),
    );
    await app.user.click(within(install).getByRole("button", { name: "How to set up the updater" }));
    expect(app.shell.calls).toContainEqual(["openExternal", "https://git.example.test/david/agent-harness/src/tag/v0.0.0-fake/docs/host-updater.md"]);
  });

  it("offers a public release's lines with no token line", async () => {
    const app = await opened({ desk: { updates: { status: { version: "0.1.1", releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" } } } } });
    const install = await partThree(app);
    await within(install).findByRole("region", { name: "Mac or Linux" });
    expect(install.textContent).not.toMatch(/AGENT_HARNESS_TOKEN|private|Authorization|docker login/);
    await app.user.click(within(within(install).getByRole("region", { name: "Windows (PowerShell)" })).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", '& ([scriptblock]::Create((curl.exe -fsSL https://github.com/owner/name/releases/download/v0.1.1/install.ps1) -join "`n")) -Channel stable']);
  });
});

describe("Add a device, Part 1: connect a phone or computer to this one", () => {
  /** Part 1 of Add a device, on `desk` as `desk` scripts it. */
  const partOne = async (desk: Partial<ScriptedEnvironment> = {}) => {
    const app = await opened({ desk });
    const part = within(await addADevice(app)).getByRole("region", { name: "Connect a phone or computer to this one" });
    return { app, part, desk: app.environment("desk") };
  };

  /** The code made, as shown. */
  const made = async (part: HTMLElement) => within(await within(part).findByRole("group", { name: "Pairing code" }));

  it("asks Who is it for? with Me pre-selected, each choice a note in words, Custom under More options, and no scope or mode id anywhere", async () => {
    const { part } = await partOne();
    const who = within(part).getByRole("radiogroup", { name: "Who is it for?" });
    expect(within(who).getAllByRole("radio").map((radio) => [radio.getAttribute("aria-label"), radio.getAttribute("aria-checked"), document.getElementById(radio.getAttribute("aria-describedby") as string)?.textContent])).toEqual([
      ["Me", "true", "Your own phone or computer. It can do everything you can do here."],
      ["A phone with limited access", "false", "It can chat with agents and answer their questions. It cannot open terminals or change settings. Agents on it edit files but ask before anything else."],
      ["A program or bot", "false", "A tool such as a bot. It can start and follow sessions but not change settings."],
    ]);
    expect(within(part).queryByRole("radio", { name: "Custom" })).toBeNull();
    expect(part.textContent).not.toMatch(/sessions:write|runs:drive|acceptEdits|bypassPermissions|Ceiling|scope/);
  });

  it("makes Me's code with every scope and bypassPermissions explicit, and reads §5.5: how to use it, the QR, the link to copy, the address and code to type, and its minutes", async () => {
    const { app, part, desk } = await partOne();
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    const code = await made(part);
    expect(desk.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
    expect(code.getByText("On the new device, open agent-harness and choose Connect to another computer. Scan this code or paste the link.")).toBeDefined();
    expect(code.getByRole("img", { name: "QR code of the pairing link" })).toBeDefined();
    const link = within(code.getByRole("region", { name: "Pairing link" })).getByText(/\/pair#/, { selector: "pre" }).textContent;
    expect(link).toMatch(/^http:\/\/.+\/pair#K7Q2MXH4R/);
    expect(code.queryByRole("region", { name: "Code" })).toBeNull();
    await app.user.click(code.getByRole("button", { name: "Type it instead" }));
    expect(within(code.getByRole("region", { name: "Address" })).getByText(/./, { selector: "pre" }).textContent).toBe(new URL(link ?? "").host);
    expect(within(code.getByRole("region", { name: "Code" })).getByText(/./, { selector: "pre" }).textContent).toMatch(/^K7Q2M-XH4R.$/);
    expect(code.getByRole("timer").textContent).toBe("This code works once, for 10 minutes. 10 min left.");
    act(() => app.clock.advance(60_000));
    expect(code.getByRole("timer").textContent).toBe("This code works once, for 10 minutes. 9 min left.");
  });

  it.each([
    "https://desk.tail1234.ts.net",
    "https://desk.tail1234.ts.net:8443",
    "https://[2001:db8::7]",
  ])("keeps HTTPS in the address shown and copied for a code from %s", async (origin) => {
    const { app, part, desk } = await partOne();
    desk.wire.answer("access.pairings.create", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: {
      pairingId: "0199dd00-0000-7000-8000-000000000001",
      code: "K7Q2MXH4RT",
      link: `${origin}/pair#K7Q2MXH4RT`,
      expiresAt: new Date(app.clock.now().getTime() + 10 * 60_000).toISOString(),
      scopes: [...SCOPES],
      ceiling: "bypassPermissions",
    } } }));
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    const code = await made(part);
    await app.user.click(code.getByRole("button", { name: "Type it instead" }));
    const address = within(code.getByRole("region", { name: "Address" })).getByText(/./, { selector: "pre" }).textContent ?? "";
    expect(address).toBe(origin);
    await app.user.click(code.getByRole("button", { name: "Copy address" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", address]);
  });

  it("says a code ran out once its ten minutes are over, and offers Make a new code", async () => {
    const { app, part, desk } = await partOne();
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    await made(part);
    act(() => app.clock.advance(10 * 60_000));
    expect(within(part).queryByRole("group", { name: "Pairing code" })).toBeNull();
    expect(within(part).getByText("This code has run out.")).toBeDefined();
    await app.user.click(within(part).getByRole("button", { name: "Make a new code" }));
    await made(part);
    expect(desk.requests("access.pairings.create")).toHaveLength(2);
  });

  it("asks a program or bot how much its agents may do without asking, in the four plain choices, preset Edit files, ask for the rest", async () => {
    const { app, part, desk } = await partOne();
    await app.user.click(within(part).getByRole("radio", { name: "A program or bot" }));
    const freedom = within(part).getByRole("radiogroup", { name: "How much may its agents do without asking?" });
    expect(within(freedom).getAllByRole("radio").map((radio) => [radio.getAttribute("aria-label"), radio.getAttribute("aria-checked")])).toEqual([
      ["Ask before any change", "false"],
      ["Edit files, ask for the rest", "true"],
      ["Let Claude decide", "false"],
      ["Never ask", "false"],
    ]);
    await app.user.click(within(freedom).getByRole("radio", { name: "Ask before any change" }));
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    await made(part);
    expect(desk.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "plan" });
  });

  it("makes a Custom one under More options with what it can do ticked and the choice made, and none with nothing ticked, saying why beside the button", async () => {
    const { app, part, desk } = await partOne();
    await app.user.click(within(part).getByRole("button", { name: "More options" }));
    await app.user.click(within(part).getByRole("radio", { name: "Custom" }));
    const can = within(part).getByRole("group", { name: "What it can do" });
    expect(within(can).getAllByRole("checkbox").map((tick) => [tick.getAttribute("aria-label"), tick.getAttribute("aria-checked")])).toEqual([
      ["See sessions", "true"],
      ["Start and organise sessions", "false"],
      ["Run agents and answer their questions", "false"],
      ["Use terminals, files and changes", "false"],
      ["Change settings and sign in accounts", "false"],
    ]);
    await app.user.click(within(can).getByRole("checkbox", { name: "See sessions" }));
    expect(within(part).getByText("Tick at least one thing it can do.")).toBeDefined();
    expect(within(part).getByRole("button", { name: "Make a pairing code" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(can).getByRole("checkbox", { name: "Use terminals, files and changes" }));
    await app.user.click(within(can).getByRole("checkbox", { name: "See sessions" }));
    await app.user.click(within(part).getByRole("radio", { name: "Let Claude decide" }));
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    await made(part);
    expect(desk.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "terminal"], ceiling: "auto" });
  });

  it("dims Me, saying this app cannot give more, where this client's own ceiling is acceptEdits, presetting the phone, and each choice above its own", async () => {
    const { app, part, desk } = await partOne({ hello: { ceiling: "acceptEdits" } });
    const me = within(part).getByRole("radio", { name: "Me" }) as HTMLButtonElement;
    await waitFor(() => expect(me.disabled).toBe(true));
    expect(document.getElementById(me.getAttribute("aria-describedby") as string)?.textContent).toContain("This app itself has limited access, so it cannot give more.");
    expect(within(part).getByRole("radio", { name: "A phone with limited access" }).getAttribute("aria-checked")).toBe("true");
    await app.user.click(within(part).getByRole("radio", { name: "A program or bot" }));
    const freedom = within(part).getByRole("radiogroup", { name: "How much may its agents do without asking?" });
    expect(within(freedom).getAllByRole("radio").map((radio) => [radio.getAttribute("aria-label"), (radio as HTMLButtonElement).disabled])).toEqual([
      ["Ask before any change", false],
      ["Edit files, ask for the rest", false],
      ["Let Claude decide", true],
      ["Never ask", true],
    ]);
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    await made(part);
    expect(desk.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });
  });

  it("warns above the button while this computer is reachable only from itself, and a code made anyway says it only works here, with no QR for another device", async () => {
    const { app, part } = await partOne({ status: LOOPBACK_ALONE });
    const warning = await within(part).findByText("Other devices cannot reach this computer yet, so they cannot use a code made now. Set up Tailscale first.");
    const button = within(part).getByRole("button", { name: "Make a pairing code" });
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await app.user.click(button);
    const code = await made(part);
    expect(code.getByText("This code only works on this computer.")).toBeDefined();
    expect(code.queryByText(/^On the new device/)).toBeNull();
    expect(code.queryByRole("img", { name: "QR code of the pairing link" })).toBeNull();
  });

  it("says nothing about reaching this computer while it binds a tailnet address", async () => {
    const { part } = await partOne({ status: { binding: { ...LOOPBACK_ALONE.binding, tailnet: { address: "100.64.0.7", name: "desk.tail1234.ts.net" } } } });
    await within(part).findByRole("button", { name: "Make a pairing code" });
    expect(within(part).queryByText(/Other devices cannot reach this computer yet/)).toBeNull();
  });

  it("says nothing about reaching this computer while a proxy serves it at an HTTPS origin, on loopback alone, which its codes' links carry", async () => {
    const { app, part } = await partOne({ status: { binding: { ...LOOPBACK_ALONE.binding, webOrigin: "https://desk.tail1234.ts.net" } } });
    await app.user.click(await within(part).findByRole("button", { name: "Make a pairing code" }));
    const code = await made(part);
    expect(within(code.getByRole("region", { name: "Pairing link" })).getByText(/\/pair#/, { selector: "pre" }).textContent).toMatch(/^https:\/\/desk\.tail1234\.ts\.net\/pair#/);
    expect(code.getByRole("img", { name: "QR code of the pairing link" })).toBeDefined();
    expect(code.queryByText("This code only works on this computer.")).toBeNull();
    expect(within(part).queryByText(/Other devices cannot reach this computer yet/)).toBeNull();
  });
});
