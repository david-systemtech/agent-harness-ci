import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Add a machine and the pairing presets on Your machines (ADR 0025; the Set
 * up spec, "Your machines"; #577): a link pasted or a QR scanned makes the
 * machine a card offering Set up this machine; Install on another machine's
 * lines from this machine's release; each card's code minted by preset with
 * the scopes and ceiling explicit, a preset above this client's own ceiling
 * dim; and Set up's "Set up another machine" opening Add a machine. Driven
 * through the harness over two scripted environments: `desk`, this
 * machine's, and `laptop`, unpaired until a test pairs it.
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

/** Pastes `link` into Add a machine's pairing form and sends it. */
const pasteLink = async (app: RenderedApp, add: HTMLElement, link: string) => {
  const form = within(add).getByRole("form", { name: "Pair by link" });
  act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
  await app.user.paste(link);
  await app.user.click(within(form).getByRole("button", { name: "Pair" }));
};

/** The environment the full checklist checks, as its picker shows it. */
const pickedIn = (region: HTMLElement) => within(within(region).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent;

describe("Add a machine", () => {
  it("pairs from a pasted link, and the machine becomes a card offering Set up this machine, which opens the checklist there on its first step needing attention", async () => {
    const app = await opened({
      laptop: {
        capabilities: ["setup"],
        setup: { permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] } },
      },
    });
    const pane = await openMachines(app);
    expect(within(pane).queryByRole("region", { name: "laptop" })).toBeNull();

    await pasteLink(app, within(pane).getByRole("region", { name: "Add a machine" }), app.environment("laptop").wire.link);
    const laptop = await within(pane).findByRole("region", { name: "laptop" });
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
    await pasteLink(app, within(pane).getByRole("region", { name: "Add a machine" }), app.environment("laptop").wire.link);
    const laptop = await within(pane).findByRole("region", { name: "laptop" });
    await app.user.click(within(laptop).getByRole("button", { name: "Not now" }));
    expect(within(laptop).queryByRole("button", { name: "Set up this machine" })).toBeNull();
    expect(within(pane).getByRole("region", { name: "laptop" })).toBe(laptop);
  });

  it("offers Scan a QR where the shell gives the window a camera, pairing with the link it reads", async () => {
    const shell = fakeShell();
    const app = await opened({}, { shell });
    shell.answer("camera.scanQr", async () => app.environment("laptop").wire.link);
    const pane = await openMachines(app);
    await app.user.click(within(within(pane).getByRole("region", { name: "Add a machine" })).getByRole("button", { name: "Scan a QR" }));
    expect(await within(pane).findByRole("region", { name: "laptop" })).toBeDefined();
    expect(shell.calls.filter(([member]) => member === "camera.scanQr")).toHaveLength(1);
  });

  it("says why there is no Scan a QR where the shell gives the window no camera", async () => {
    const app = await opened({}, { shell: Object.assign(fakeShell(), { camera: undefined }) });
    const add = within(await openMachines(app)).getByRole("region", { name: "Add a machine" });
    expect(within(add).queryByRole("button", { name: "Scan a QR" })).toBeNull();
    expect(within(add).getByText("Scan a QR: This app cannot scan a QR code here. Paste the link instead.")).toBeDefined();
  });

  it("shows a copyable install line per platform from this machine's release, with its channel and the name typed, and the container's compose snippet, with them too, and the updater's documentation", async () => {
    const app = await opened({ desk: { settings: { "updates.channel": "beta" } } });
    const install = within(within(await openMachines(app)).getByRole("region", { name: "Add a machine" })).getByRole("region", { name: "Install on another machine" });
    const line = (platform: string) => within(within(install).getByRole("region", { name: platform })).getByText(/./, { selector: "pre" }).textContent;
    const release = "https://git.example.test/david/agent-harness/releases/download/v0.0.0-fake";
    const tokenToCurl = `printf 'header = "Authorization: token %s"\\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL`;

    expect(await within(install).findByRole("region", { name: "macOS and Linux" })).toBeDefined();
    expect(line("macOS and Linux")).toBe(`${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta`);
    act(() => within(install).getByRole("textbox", { name: "Name (optional)" }).focus());
    await app.user.keyboard("Build box");
    expect(line("macOS and Linux")).toBe(`${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta --name 'Build box'`);
    expect(line("Windows (PowerShell)")).toBe(
      `& ([scriptblock]::Create((('header = "Authorization: token ' + $env:AGENT_HARNESS_TOKEN + '"') | curl.exe -K - -fsSL ${release}/install.ps1) -join "\`n")) -Channel beta -Name 'Build box'`,
    );
    await app.user.click(within(within(install).getByRole("region", { name: "macOS and Linux" })).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", `${tokenToCurl} ${release}/install.sh | sh -s -- --channel beta --name 'Build box'`]);

    const container = "A container (Docker or Podman), from the folder to keep its compose file in";
    expect(line(container)).toBe(
      [
        `${tokenToCurl} -o compose.yaml ${release}/compose.yaml`,
        `${tokenToCurl} -o host-updater.sh ${release}/host-updater.sh`,
        "chmod +x host-updater.sh",
        "docker login git.example.test",
        "AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME='Build box' docker compose up -d",
        "docker compose logs environment",
      ].join("\n"),
    );
    expect(within(install).getByText(/^Until a client first pairs with it, the container prints its pairing link, QR and code to its log at each start/)).toBeDefined();
    expect(within(install).getByText(/Its first start takes the channel and the name from the line that starts it; a later start keeps them, and its card changes either once paired\./)).toBeDefined();
    await app.user.click(within(install).getByRole("button", { name: "The host-side updater's documentation" }));
    expect(app.shell.calls).toContainEqual(["openExternal", "https://git.example.test/david/agent-harness/src/tag/v0.0.0-fake/docs/host-updater.md"]);
  });

  it("offers anonymous public install commands and explains how to schedule the downloaded host-side updater", async () => {
    const app = await opened({ desk: { updates: { status: { version: "0.1.1", releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" } } } } });
    const install = within(within(await openMachines(app)).getByRole("region", { name: "Add a machine" })).getByRole("region", { name: "Install on another machine" });
    await within(install).findByRole("region", { name: "macOS and Linux" });
    expect(install.textContent).not.toMatch(/AGENT_HARNESS_TOKEN|Forgejo token|Authorization|docker login/);
    expect(within(install).getByText(/Public releases download without credentials/)).toBeDefined();
    expect(within(install).getByText(/schedule host-updater.sh on the host every five minutes/)).toBeDefined();
    await app.user.click(within(within(install).getByRole("region", { name: "Windows (PowerShell)" })).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", '& ([scriptblock]::Create((curl.exe -fsSL https://github.com/owner/name/releases/download/v0.1.1/install.ps1) -join "`n")) -Channel stable']);
  });

  it("is where Set up's Set up another machine opens, its link's field taking the focus", async () => {
    const app = await opened();
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Set up another machine" }));
    const add = within(within(settings).getByRole("region", { name: "Your machines" })).getByRole("region", { name: "Add a machine" });
    expect(document.activeElement).toBe(within(add).getByRole("textbox", { name: "Pairing link" }));
  });
});

describe("a pairing code by preset", () => {
  /** Opens the paired `laptop`'s Pair another client, as `laptop` scripts it. */
  const pairingOn = async (laptop: Partial<ScriptedEnvironment> = {}) => {
    const app = await opened({ laptop: { reach: "paired", ...laptop } });
    const pane = await openMachines(app);
    return { app, part: within(within(pane).getByRole("region", { name: "laptop" })).getByRole("region", { name: "Pair another client" }), laptop: app.environment("laptop") };
  };

  /** What the code minted grants and how long it has, as shown beside it. */
  const minted = async (part: HTMLElement) => within(await within(part).findByRole("group", { name: "Pairing code" }));

  it("mints my own client's, preset, with every scope and bypassPermissions explicit, and shows what it grants beside it with its countdown", async () => {
    const { app, part, laptop } = await pairingOn();
    expect(within(part).getByRole("radio", { name: "My own client — everything for my own devices (phone included)" }).getAttribute("aria-checked")).toBe("true");
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    const code = await minted(part);
    expect(laptop.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
    expect(code.getByText("Grants every scope, up to bypassPermissions.")).toBeDefined();
    expect(code.getByRole("timer").textContent).toBe("10m 0s left");
    act(() => app.clock.advance(1000));
    expect(code.getByRole("timer").textContent).toBe("9m 59s left");
  });

  it("mints a program's with read, sessions:write and runs:drive and the ceiling picked, preset acceptEdits", async () => {
    const { app, part, laptop } = await pairingOn();
    await app.user.click(within(part).getByRole("radio", { name: "A program" }));
    const ceiling = within(part).getByRole("combobox", { name: "Ceiling" }) as HTMLSelectElement;
    expect(ceiling.value).toBe("acceptEdits");
    expect(within(part).queryByRole("group", { name: "Scopes" })).toBeNull();
    await app.user.selectOptions(ceiling, "plan");
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    expect((await minted(part)).getByText("Grants read, sessions:write and runs:drive, up to plan.")).toBeDefined();
    expect(laptop.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "plan" });
  });

  it("mints a custom one with the scopes ticked and the ceiling picked, and none with no scope ticked", async () => {
    const { app, part, laptop } = await pairingOn();
    await app.user.click(within(part).getByRole("radio", { name: "Custom" }));
    const scopes = within(part).getByRole("group", { name: "Scopes" });
    expect(within(scopes).getByRole("checkbox", { name: "read" }).getAttribute("aria-checked")).toBe("true");
    await app.user.click(within(scopes).getByRole("checkbox", { name: "read" }));
    expect(within(part).getByText("A pairing code grants at least one scope.")).toBeDefined();
    expect(within(part).getByRole("button", { name: "Make a pairing code" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(scopes).getByRole("checkbox", { name: "terminal" }));
    await app.user.click(within(scopes).getByRole("checkbox", { name: "read" }));
    await app.user.selectOptions(within(part).getByRole("combobox", { name: "Ceiling" }), "auto");
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    expect((await minted(part)).getByText("Grants read and terminal, up to auto.")).toBeDefined();
    expect(laptop.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "terminal"], ceiling: "auto" });
  });

  it("dims my own client, with why, where this client's own ceiling is acceptEdits, presetting a program's, and each ceiling above its own", async () => {
    const { app, part, laptop } = await pairingOn({ hello: { ceiling: "acceptEdits" } });
    const own = within(part).getByRole("radio", { name: "My own client — everything for my own devices (phone included)" }) as HTMLInputElement;
    await waitFor(() => expect(own.disabled).toBe(true));
    expect(within(part).getByText("Above this client's own ceiling on laptop, acceptEdits: a pairing code grants at most its minter's.")).toBeDefined();
    expect(within(part).getByRole("radio", { name: "A program" }).getAttribute("aria-checked")).toBe("true");
    const offered = within(within(part).getByRole("combobox", { name: "Ceiling" })).getAllByRole("option") as HTMLOptionElement[];
    expect(offered.map((option) => [option.value, option.disabled])).toEqual([
      ["plan", false],
      ["acceptEdits", false],
      ["auto", true],
      ["bypassPermissions", true],
    ]);
    await app.user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
    await minted(part);
    expect(laptop.requests("access.pairings.create").at(-1)?.params).toMatchObject({ scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" });
  });
});
