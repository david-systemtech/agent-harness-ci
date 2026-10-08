import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import { TOOL_TERMINAL_KEPT_MS } from "@agent-harness/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * About's Managed tools (docs/specs/gui.md, "Settings: the rail, the rows
 * and the addresses"; key-managers spec, "Managed tools"; ADR 0026; #426):
 * the picked environment's `tools.list` rows, asked with `refresh` when
 * About opens and following `tools.updated`, each with its status and one
 * action; Verify; claude's detail beside what `claude doctor` reports;
 * Install and Update in a tool terminal drawn in About, where a `sudo`
 * password is typed; the one-run-at-a-time refusal; a Copy row's command;
 * the row after a run; and the tool terminal going once the environment has
 * closed it, thirty minutes on its clock after the command exited (#864).
 * Driven through the harness over the scripted environment's `tools.*`
 * answers and its tool terminal, in jsdom.
 */

/** The flag the section reads. */
const FLAGGED = ["managedTools"] as const;

/** Rows as a probe might find them, one of each status. */
const ROWS: NonNullable<NonNullable<ScriptedEnvironment["keyManagers"]>["tools"]> = [
  {
    tool: "claude",
    path: "/home/milo/.local/bin/claude",
    realpath: "/home/milo/.local/share/claude/versions/2.1.283",
    version: "2.1.283",
    latest: "2.1.285",
    minimum: null,
    method: "native",
    status: "update-available",
    action: "update",
  },
  { tool: "bao", path: null, realpath: null, version: null, latest: null, minimum: "2.1.1", method: null, status: "not-installed", action: "install" },
  { tool: "vault", version: "1.13.2", latest: "1.18.0", minimum: "1.14.0", method: "manual", status: "below-minimum", action: "copy", command: null },
  {
    tool: "doppler",
    path: "/home/milo/.local/share/mise/shims/doppler",
    version: "3.80.0",
    latest: "3.80.0",
    minimum: "3.76.0",
    method: "mise",
    status: "current",
    action: "copy",
    command: "doppler update",
  },
  { tool: "op", version: "2.30.0", latest: null, minimum: "2.18.0", method: "unknown", status: "method-unknown", action: "copy", command: "brew install --cask 1password-cli" },
  { tool: "gh", version: "2.63.2", latest: "2.63.2", minimum: "2.40.0", method: "homebrew", status: "current", action: "update" },
];

/** The window over `desk`, this machine's environment, offering managed tools with `ROWS`, as `desk` scripts it besides. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: [...FLAGGED], keyManagers: { tools: ROWS }, ...desk }] });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Opens Settings on About, as a person does: Mod+, then its row on the rail. */
const openAbout = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  const settings = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "About" }));
  return within(settings).getByRole("region", { name: "About" });
};

/** About's Managed tools. */
const section = () => within(screen.getByRole("region", { name: "About" })).getByRole("region", { name: "Managed tools" });

/** A tool's row, by its label, once it is drawn. */
const row = (label: string) => within(section()).findByRole("region", { name: label });

/** What a row says of its tool, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** A tool terminal drawn in the section, by what it runs: "Installing OpenBao CLI". */
const toolTerminal = (name: string) => within(section()).findByRole("region", { name });

/** The rows xterm.js draws in a tool terminal, each trimmed of its trailing blanks, the blank rows after the last dropped. */
const screenOf = (terminal: HTMLElement) => {
  const drawn = [...terminal.querySelectorAll(".xterm-rows > div")].map((line) => (line.textContent ?? "").replace(/\u00a0/g, " ").trimEnd());
  while (drawn.length > 0 && drawn.at(-1) === "") drawn.pop();
  return drawn;
};

/** Types `keys` into a tool terminal, as a person does once the focus is in it. */
const typeInto = async (app: RenderedApp, terminal: HTMLElement, keys: string) => {
  act(() => (terminal.querySelector("textarea") as HTMLTextAreaElement).focus());
  await app.user.keyboard(keys);
};

/** bao installed by apt, as the probe after its install finds it. */
const BAO_INSTALLED = { path: "/usr/bin/bao", realpath: "/usr/bin/bao", version: "2.4.1", latest: "2.4.1", method: "apt", status: "current", action: "update" } as const;

/** bao's install by its apt repository under sudo, asking the password. */
const BAO_RUN = { method: "apt", command: "sudo apt-get install openbao", password: "password-for-tests", output: "Setting up openbao (2.4.1) ...\r\n", after: BAO_INSTALLED } as const;

/** The buttons a row offers, by name. */
const buttons = (region: HTMLElement) => within(region).queryAllByRole("button").map((button) => button.textContent);

/** Lets the answers in flight arrive and be acted on: one turn of the event loop. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** gh's Update run to its end in a tool terminal drawn in About, its command exiting 0 as the window's clock starts: the terminal's id, and how often it was subscribed. */
const updatedGh = async (app: RenderedApp) => {
  await openAbout(app);
  await app.user.click(within(await row("GitHub CLI")).getByRole("button", { name: "Update" }));
  const terminal = await toolTerminal("Updating GitHub CLI");
  expect(await within(terminal).findByText("· exit 0")).toBeDefined();
  expect(app.clock.now().toISOString()).toBe(MANUAL_CLOCK_START);
  const desk = app.environment("desk");
  const id = String(desk.requests("tools.run")[0]?.params["id"]);
  return { terminal, id, asked: () => desk.requests("terminals.subscribe").filter((request) => request.params["id"] === id).length };
};

/** Whether the section still draws gh's Update. */
const ghDrawn = () => within(section()).queryByRole("region", { name: "Updating GitHub CLI" }) !== null;

it("draws tool actions with icons and keeps their accessible names", async () => {
  const app = await opened();
  await openAbout(app);
  const tool = await row("OpenBao CLI");
  const install = within(tool).getByRole("button", { name: /Install/ });
  expect(install.querySelector("svg")).not.toBeNull();
  expect(tool.getAttribute("data-managed-tool")).toBe("bao");
});

describe("About's Managed tools", () => {
  it("lists the picked environment's rows with each one's version, install method, minimum, latest, status and one action; claude reads claude in your terminal and is never required", async () => {
    const app = await opened();
    await openAbout(app);

    const claude = await row("claude in your terminal");
    expect(facts(claude)).toEqual({
      Version: "2.1.283",
      "Install method": "Its native installer",
      Minimum: "None",
      Latest: "2.1.285",
      Status: "Update available",
      Required: "Never: it is for your own use.",
    });
    expect(buttons(claude)).toEqual(["Update", "Details"]);

    const bao = await row("OpenBao CLI");
    expect(facts(bao)).toEqual({ Minimum: "2.1.1", Status: "Not installed", Required: "While a key manager of OpenBao or Vault injects into runs." });
    expect(buttons(bao)).toEqual(["Install", "Verify"]);

    expect(facts(await row("Vault CLI"))).toMatchObject({ Version: "1.13.2", "Install method": "By hand", Minimum: "1.14.0", Latest: "1.18.0", Status: "Below minimum" });
    expect(facts(await row("Doppler CLI"))).toMatchObject({ "Install method": "mise", Status: "Current" });
    expect(facts(await row("1Password CLI"))).toMatchObject({ "Install method": "Not known", Latest: "Not known yet", Status: "Method unknown" });
    const gh = await row("GitHub CLI");
    expect(facts(gh)).toMatchObject({ Version: "2.63.2", "Install method": "Homebrew", Status: "Current", Required: "While a forge account reads its token from this environment's gh." });
    expect(buttons(gh)).toEqual(["Update", "Verify"]);
  });

  it("asks tools.list with refresh when About opens, and follows tools.updated", async () => {
    const app = await opened();
    await openAbout(app);
    const gh = await row("GitHub CLI");
    const desk = app.environment("desk");
    expect(desk.requests("tools.list").map((request) => request.params)).toContainEqual({ refresh: true });

    desk.changeTool("gh", { latest: "2.65.0", status: "update-available" });
    await waitFor(() => expect(facts(gh)).toMatchObject({ Latest: "2.65.0", Status: "Update available" }));
  });

  it("runs Verify as tools.verify and says passed or failed with its one-line reason", async () => {
    const app = await opened({
      managedTools: {
        verifications: {
          gh: { outcome: "passed", reason: "gh is signed in to github.com as milo." },
          vault: { outcome: "failed", reason: "OpenBao at https://bao.home.test:8200 is sealed." },
        },
      },
    });
    await openAbout(app);
    const gh = await row("GitHub CLI");
    await app.user.click(within(gh).getByRole("button", { name: "Verify" }));
    expect(await within(gh).findByText("Verified: gh is signed in to github.com as milo.")).toBeDefined();

    const vault = await row("Vault CLI");
    await app.user.click(within(vault).getByRole("button", { name: "Verify" }));
    expect(await within(vault).findByText("Verify failed: OpenBao at https://bao.home.test:8200 is sealed.")).toBeDefined();
    expect(app.environment("desk").requests("tools.verify").map((request) => request.params)).toEqual([{ tool: "gh" }, { tool: "vault" }]);
  });

  it("opens claude's detail: the install method detected beside the one claude doctor reports, and what doctor warns of", async () => {
    const app = await opened({
      managedTools: {
        doctor: {
          outcome: "read",
          method: "npm",
          fields: [{ name: "Running", value: "npm-global (2.1.283)" }],
          warnings: [{ issue: "Running native installation but config install method is 'npm'", fix: "Run claude install to update configuration" }],
        },
      },
    });
    await openAbout(app);
    const claude = await row("claude in your terminal");
    await app.user.click(within(claude).getByRole("button", { name: "Details" }));
    const doctor = await within(claude).findByRole("region", { name: "What claude doctor says" });
    expect(facts(doctor)).toEqual({ "Detected install method": "Its native installer", "claude doctor reports": "npm" });
    expect(within(doctor).getByRole("listitem").textContent).toBe("Running native installation but config install method is 'npm' Fix: Run claude install to update configuration");
    expect(app.environment("desk").requests("tools.detail").map((request) => request.params)).toEqual([{ tool: "claude" }]);
  });

  it("installs through tools.run in a tool terminal drawn in About, where the sudo password is typed, then shows the new probe and the verification; Close closes it", async () => {
    const app = await opened({
      managedTools: { runs: { bao: BAO_RUN }, verifications: { bao: { outcome: "passed", reason: "bao looked up its run token at https://bao.home.test:8200: policies default, reader." } } },
    });
    await openAbout(app);
    const bao = await row("OpenBao CLI");
    await app.user.click(within(bao).getByRole("button", { name: "Install" }));

    const terminal = await toolTerminal("Installing OpenBao CLI");
    expect(within(terminal).getByText("sudo apt-get install openbao")).toBeDefined();
    await waitFor(() => expect(screenOf(terminal)).toEqual(["$ sudo apt-get install openbao", "[sudo] password for milo:"]));
    const desk = app.environment("desk");
    const [run] = desk.requests("tools.run");
    expect(run?.params).toEqual({ commandId: expect.any(String), tool: "bao", action: "install", id: expect.any(String) });
    const id = String(run?.params["id"]);
    expect(desk.terminal(id)).toMatchObject({ owner: "managed-tools", sessionId: null });

    await typeInto(app, terminal, "password-for-tests{Enter}");
    await waitFor(() => expect(desk.terminal(id).writes.join("")).toBe("password-for-tests\r"));
    await waitFor(() => expect(screenOf(terminal)).toContain("Setting up openbao (2.4.1) ..."));
    expect(await within(terminal).findByText("· exit 0")).toBeDefined();
    await waitFor(() => expect(facts(bao)).toMatchObject({ Version: "2.4.1", "Install method": "apt", Status: "Current" }));
    expect(await within(bao).findByText("The install of bao finished. Verified: bao looked up its run token at https://bao.home.test:8200: policies default, reader.")).toBeDefined();
    expect(buttons(bao)).toEqual(["Update", "Verify"]);

    await app.user.click(within(terminal).getByRole("button", { name: "Close" }));
    expect(within(section()).queryByRole("region", { name: "Installing OpenBao CLI" })).toBeNull();
    expect(desk.requests("terminals.close").map((request) => request.params["id"])).toEqual([id]);
  });

  it("refuses a run while another is in progress, tool_run_in_progress in one line, and draws the run under way again when About opens anew, until its Close", async () => {
    const app = await opened({ managedTools: { runs: { bao: BAO_RUN } } });
    await openAbout(app);
    await app.user.click(within(await row("OpenBao CLI")).getByRole("button", { name: "Install" }));
    await toolTerminal("Installing OpenBao CLI");

    const gh = await row("GitHub CLI");
    await app.user.click(within(gh).getByRole("button", { name: "Update" }));
    expect(await within(gh).findByRole("status")).toHaveProperty("textContent", "Not run: A bao install is running on this environment; package managers lock, so one tool run runs at a time.");
    const desk = app.environment("desk");
    expect(desk.requests("tools.run").map((request) => request.params["tool"])).toEqual(["bao", "gh"]);
    const id = String(desk.requests("tools.run")[0]?.params["id"]);
    const subscribed = () => desk.requests("terminals.subscribe").filter((request) => request.params["id"] === id).length;

    // Settings closed and opened again: the run's terminal is drawn again, still asking for the password.
    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    await openAbout(app);
    const again = await toolTerminal("Installing OpenBao CLI");
    await waitFor(() => expect(screenOf(again)).toEqual(["$ sudo apt-get install openbao", "[sudo] password for milo:"]));
    const before = subscribed();

    // The section drawn anew while the run is under way (a probe's tools.updated) keeps the one pane, the focus still in it.
    act(() => (again.querySelector("textarea") as HTMLTextAreaElement).focus());
    const ghAgain = await row("GitHub CLI");
    desk.changeTool("gh", { latest: "2.65.0", status: "update-available" });
    await waitFor(() => expect(facts(ghAgain)).toMatchObject({ Latest: "2.65.0" }));
    expect(subscribed()).toBe(before);
    expect(again.contains(document.activeElement)).toBe(true);
    expect(screenOf(again)).toEqual(["$ sudo apt-get install openbao", "[sudo] password for milo:"]);

    // Its run finished, the pane stays, saying how it ended, until its Close closes the terminal.
    await typeInto(app, again, "password-for-tests{Enter}");
    expect(await within(await row("OpenBao CLI")).findByText(/^The install of bao finished\./)).toBeDefined();
    expect(await within(await toolTerminal("Installing OpenBao CLI")).findByText("· exit 0")).toBeDefined();
    await app.user.click(within(await toolTerminal("Installing OpenBao CLI")).getByRole("button", { name: "Close" }));
    expect(within(section()).queryByRole("region", { name: "Installing OpenBao CLI" })).toBeNull();
    expect(desk.requests("terminals.close").map((request) => request.params["id"])).toEqual([id]);
  });

  it("goes when the environment closes the tool terminal", async () => {
    const app = await opened({ managedTools: { runs: { gh: { exitCode: null } } } });
    await openAbout(app);
    await app.user.click(within(await row("GitHub CLI")).getByRole("button", { name: "Update" }));
    const terminal = await toolTerminal("Updating GitHub CLI");
    expect(within(terminal).getByText("brew upgrade gh")).toBeDefined();
    const desk = app.environment("desk");
    const id = String(desk.requests("tools.run")[0]?.params["id"]);

    desk.closeTerminal(id);
    await waitFor(() => expect(within(section()).queryByRole("region", { name: "Updating GitHub CLI" })).toBeNull());
    expect(await within(await row("GitHub CLI")).findByText("The update of gh was closed before it finished.")).toBeDefined();
  });

  it("goes once the environment has closed a finished run's terminal, thirty minutes on its clock after the command exited, asking after it then and not before", async () => {
    const app = await opened();
    const { id, asked } = await updatedGh(app);
    const desk = app.environment("desk");
    expect(asked()).toBe(1);

    // A moment short of the thirty minutes the environment keeps it: kept there, and the pane stays, asking nothing.
    await act(async () => app.clock.advance(TOOL_TERMINAL_KEPT_MS - 1));
    await settle();
    expect(desk.terminal(id).closed).toBe(false);
    expect(ghDrawn()).toBe(true);
    expect(asked()).toBe(1);

    // At them the environment closes it, telling no one: the pane asks after it, finds it gone, and goes, closing nothing.
    await act(async () => app.clock.advance(1));
    expect(desk.terminal(id).closed).toBe(true);
    await waitFor(() => expect(ghDrawn()).toBe(false));
    expect(asked()).toBe(2);
    expect(desk.requests("terminals.close")).toEqual([]);
    expect(within(await row("GitHub CLI")).getByText(/^The update of gh finished\./)).toBeDefined();
  });

  it("reckons the thirty minutes from the exit's time on the environment's clock as the window reckons it, and asks again while the environment still holds the terminal", async () => {
    // The window reckons the environment's clock ninety seconds ahead of where it is (its hello's time), as a hello slow to arrive can leave it.
    const ahead = 90_000;
    const app = await opened({ hello: { serverTime: new Date(Date.parse(MANUAL_CLOCK_START) + ahead).toISOString() } });
    const { id, asked } = await updatedGh(app);
    const desk = app.environment("desk");

    // Thirty minutes after the exit by that reckoning, ninety seconds early: asked after, and still held, so the pane stays.
    await act(async () => app.clock.advance(TOOL_TERMINAL_KEPT_MS - ahead));
    await settle();
    expect(asked()).toBe(2);
    expect(desk.terminal(id).closed).toBe(false);
    expect(ghDrawn()).toBe(true);

    // Asked again a minute after that answer on the environment's clock, thirty seconds early still: held, and the pane stays.
    await act(async () => app.clock.advance(60_000));
    await settle();
    expect(asked()).toBe(3);
    expect(desk.terminal(id).closed).toBe(false);
    expect(ghDrawn()).toBe(true);

    // The environment closes it at its own thirty minutes; asked again a minute later, it is gone, and the pane goes.
    await act(async () => app.clock.advance(60_000));
    expect(desk.terminal(id).closed).toBe(true);
    await waitFor(() => expect(ghDrawn()).toBe(false));
    expect(asked()).toBe(4);
    expect(desk.requests("terminals.close")).toEqual([]);
  });

  it("goes at its Close saying nothing of the not_found that close is answered, when the environment closed the finished run's terminal unseen", async () => {
    const app = await opened();
    const { terminal, id } = await updatedGh(app);
    const desk = app.environment("desk");

    // Closed on the environment after its command exited, as another client's Close does: the pane's subscription ended with the exit, so it is not told.
    desk.closeTerminal(id);
    await settle();
    expect(ghDrawn()).toBe(true);

    await app.user.click(within(terminal).getByRole("button", { name: "Close" }));
    expect(ghDrawn()).toBe(false);
    await waitFor(() => expect(desk.requests("terminals.close").map((request) => request.params["id"])).toEqual([id]));
    await settle();
    expect(screen.queryByText(/not_found|No terminal|is open on this environment/)).toBeNull();
    expect(within(await row("GitHub CLI")).getByText(/^The update of gh finished\./)).toBeDefined();
  });

  it("copies a Copy-only row's command through the shell's clipboard, offering no run", async () => {
    const app = await opened();
    await openAbout(app);
    const doppler = await row("Doppler CLI");
    expect(buttons(doppler)).toEqual(["Verify", "Copy"]);
    const command = within(doppler).getByRole("region", { name: "The vendor's command, to run yourself on desk" });
    expect(within(command).getByText("doppler update")).toBeDefined();
    await app.user.click(within(command).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls.filter(([member]) => member === "clipboard.writeText")).toEqual([["clipboard.writeText", "doppler update"]]);
    expect(within(await row("Vault CLI")).getByText("The harness has no command for the Vault CLI here: update it the way it was installed.")).toBeDefined();
    expect(app.environment("desk").requests("tools.run")).toEqual([]);
  });

  it("offers the vendor's command to copy when a run is refused tool_not_runnable", async () => {
    const app = await opened({
      managedTools: { runs: { bao: { refused: { message: "No way to install bao is available on this environment: run the vendor's command yourself.", command: "brew install openbao" } } } },
    });
    await openAbout(app);
    const bao = await row("OpenBao CLI");
    await app.user.click(within(bao).getByRole("button", { name: "Install" }));
    expect(await within(bao).findByText("Not run: No way to install bao is available on this environment: run the vendor's command yourself.")).toBeDefined();
    expect(within(within(bao).getByRole("region", { name: "The vendor's command, to run yourself on desk" })).getByText("brew install openbao")).toBeDefined();
  });

  it("is absent with its reason where the environment does not offer managedTools, asking nothing", async () => {
    const app = await opened({ capabilities: [] });
    await openAbout(app);
    expect(within(section()).getByText("desk runs an older agent-harness without this. Update expect(within(section()).getByText("desk to use it.")).toBeDefined();
    expect(within(section()).queryAllByRole("region")).toEqual([]);
    expect(app.environment("desk").requests("tools.list")).toEqual([]);
  });

  it("dims Install, Update and Verify without admin, About saying the capability's line once, and still copies and opens claude's detail", async () => {
    const app = await opened({ scopes: ["read", "sessions:write", "runs:drive", "terminal"] });
    const about = await openAbout(app);
    expect(await within(about).findByText("Read-only: This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(about).getAllByText(/^Read-only:/)).toHaveLength(1);
    for (const [label, name] of [
      ["OpenBao CLI", "Install"],
      ["OpenBao CLI", "Verify"],
      ["GitHub CLI", "Update"],
      ["claude in your terminal", "Update"],
    ] as const) {
      expect(within(await row(label)).getByRole("button", { name }).hasAttribute("disabled"), `${label}: ${name}`).toBe(true);
    }
    expect(within(await row("Doppler CLI")).getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(false);
    const claude = await row("claude in your terminal");
    await app.user.click(within(claude).getByRole("button", { name: "Details" }));
    expect(await within(claude).findByRole("region", { name: "What claude doctor says" })).toBeDefined();
  });

  it("is where the Key manager step's Install of a tool this build does not know goes: About opens with its Managed tools taking the focus", async () => {
    const app = await opened({
      setup: {
        "key-manager": {
          state: "needs-attention",
          reason: "A tool this build does not know needs installing.",
          failing: ["key-manager.cli"],
          actions: ["install"],
          targets: [{ action: "install", kind: "tool", id: "future-tool", label: "future-tool" }],
        },
      },
    });
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Open the full checklist" }));
    const checklist = screen.getByRole("region", { name: "Set up" });
    await app.user.click(within(within(checklist).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }));
    await app.user.click(within(within(checklist).getByRole("region", { name: "Key manager" })).getByRole("button", { name: "Install: future-tool" }));

    await waitFor(() => expect(document.activeElement).toBe(section()));
    expect(await row("OpenBao CLI")).toBeDefined();
  });

  it("is not where Mod+, goes when it reopens About after an opening at Managed tools: the focus stays out of the section", async () => {
    const app = await opened({
      setup: {
        "key-manager": {
          state: "needs-attention",
          reason: "A tool this build does not know needs installing.",
          failing: ["key-manager.cli"],
          actions: ["install"],
          targets: [{ action: "install", kind: "tool", id: "future-tool", label: "future-tool" }],
        },
      },
    });
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Open the full checklist" }));
    const checklist = screen.getByRole("region", { name: "Set up" });
    await app.user.click(within(within(checklist).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }));
    await app.user.click(within(within(checklist).getByRole("region", { name: "Key manager" })).getByRole("button", { name: "Install: future-tool" }));
    await waitFor(() => expect(document.activeElement).toBe(section()));

    await app.user.keyboard("{Control>},{/Control}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Settings" })).toBeNull());
    await app.user.keyboard("{Control>},{/Control}");
    expect(await row("OpenBao CLI")).toBeDefined();
    await settle();

    expect(document.activeElement).not.toBe(section());
  });
});
