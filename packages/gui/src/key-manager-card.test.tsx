import { act, screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import type { KeyManagerStatusKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { certificateOf, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Key manager card in Set up (setup-copy.md §5.7; the Set up
 * specification, "5. Key manager"; key-managers spec, "The Key manager
 * step"; ADR 0028; #590, #1851): the question "Which one do you use?" with
 * "I do not use one" chosen, each provider's form in §5.7's words, OpenBao's
 * mount, token role and certificate under More options; what Connect says,
 * a refusal in plain words with its Details and a provider this computer
 * cannot connect to marked for the visit; each connection's health in one
 * line with one button, its switch showing what Settings › Key managers
 * shows, its policy ticks and CLI row under More options; Move saved tokens
 * only while agent-harness keeps some; and the card read-only without
 * `admin`. Driven through the harness's full checklist over the scripted
 * environment's key-manager and tools answers, in jsdom.
 */

/** The flags an environment with key managers offers: `keyManagers`, and `managedTools` for the CLI rows' Install and Update. */
const FLAGGED = ["keyManagers", "managedTools"] as const;

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The Key manager step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Key manager" });

/** The question the card asks. */
const question = () => within(step()).findByRole("radiogroup", { name: "Which one do you use?" });

/** The full checklist on its first launch over `desk`, this machine's environment, as `desk` scripts it, showing the Key manager step. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}): Promise<RenderedApp> => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: [...FLAGGED], ...desk }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }));
  return app;
};

/** Chooses a key manager in the question, and answers its form. */
const choose = async (app: RenderedApp, name: string) => {
  await app.user.click(within(await question()).getByRole("radio", { name }));
  return within(step()).getByRole("form", { name: /^Connect / });
};

/** Opens the More options fold inside `region`, if it is shut: it stays open for the step while the window lives. */
const moreOptions = async (app: RenderedApp, region: HTMLElement) => {
  const fold = within(region).getByRole("button", { name: "More options" });
  if (fold.getAttribute("aria-expanded") !== "true") await app.user.click(fold);
};

/** Shuts the More options fold inside `region`, if it is open from an earlier test: the fold's state outlives a card. */
const shutOptions = async (app: RenderedApp, region: HTMLElement) => {
  const fold = within(region).getByRole("button", { name: "More options" });
  if (fold.getAttribute("aria-expanded") === "true") await app.user.click(fold);
};

/** The dialog open, by its name. */
const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

/** What a region says, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** A line whose whole text, its parts in other elements included, matches `text`. */
const line = (text: RegExp) => (_: string, element: Element | null) => element?.tagName === "P" && text.test(element.textContent ?? "");

/** A connection on the card, by its label, once it is drawn. */
const connection = (label: string) => within(step()).findByRole("region", { name: label });

describe("the question", () => {
  it("asks Which one do you use?, I do not use one chosen and no form shown, offering the four key managers", async () => {
    await opened();
    const asked = await question();
    expect(within(asked).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["I do not use one", "OpenBao or Vault", "Doppler", "1Password", "Bitwarden Secrets Manager"]);
    expect(within(asked).getByRole("radio", { name: "I do not use one" }).getAttribute("aria-checked")).toBe("true");
    expect(within(step()).queryByRole("form")).toBeNull();
  });

  it("shows OpenBao's form in §5.7's words: the address with its hint, how you sign in with a token chosen, and the mount, token role and certificate under More options", async () => {
    const app = await opened();
    const form = await choose(app, "OpenBao or Vault");
    await shutOptions(app, form);
    expect(form.getAttribute("aria-label")).toBe("Connect OpenBao");
    const address = within(form).getByRole("textbox", { name: "Address" });
    expect(within(form).getByText("The address you open it at, like https://vault.example.com")).toBeDefined();
    expect(address.getAttribute("aria-describedby")).not.toBeNull();
    const how = within(form).getByRole("radiogroup", { name: "How do you sign in?" });
    expect(within(how).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["With a token", "With AppRole", "With a username and password"]);
    expect(within(how).getByRole("radio", { name: "With a token" }).getAttribute("aria-checked")).toBe("true");
    expect(within(form).getByLabelText("Token")).toBeDefined();
    // None of the technical words outside More options.
    for (const word of ["Mount", "Token role (optional)", "Label", "Signs in by"]) expect(within(form).queryByText(word)).toBeNull();
    await moreOptions(app, form);
    expect(within(form).getByRole("textbox", { name: "Mount" })).toBeDefined();
    expect(within(form).getByRole("textbox", { name: "Token role (optional)" })).toBeDefined();
    expect(within(form).getByRole("button", { name: "Read its certificate" })).toBeDefined();
    expect(within(form).getByRole("button", { name: "Connect OpenBao" })).toBeDefined();

    await app.user.click(within(how).getByRole("radio", { name: "With AppRole" }));
    expect(within(form).getByLabelText("Role ID")).toBeDefined();
    expect(within(form).getByLabelText("Secret ID")).toBeDefined();
    await app.user.click(within(how).getByRole("radio", { name: "With a username and password" }));
    expect(within(form).getByRole("textbox", { name: "Username" })).toBeDefined();
    expect(within(form).getByLabelText("Password")).toBeDefined();

    // I do not use one lets the form go.
    await app.user.click(within(await question()).getByRole("radio", { name: "I do not use one" }));
    expect(within(step()).queryByRole("form")).toBeNull();
  });

  it("asks the others for a read-only token alone, with Connect named for the key manager", async () => {
    const app = await opened();
    for (const [name, provider] of [["Doppler", "Doppler"], ["1Password", "1Password"], ["Bitwarden Secrets Manager", "Bitwarden Secrets Manager"]] as const) {
      const form = await choose(app, name);
      await shutOptions(app, form);
      expect(within(form).getByText(`Create a read-only token in ${provider} and paste it here.`)).toBeDefined();
      expect(within(form).getByLabelText("Token")).toBeDefined();
      expect(within(form).queryByRole("textbox", { name: "Address" })).toBeNull();
      expect(within(form).getByRole("button", { name: `Connect ${provider}` })).toBeDefined();
    }
  });
});

describe("connecting", () => {
  it("connects OpenBao by AppRole with keyManagers.connections.add sent directly, its CA the anchor a person accepted, and says Connected", async () => {
    const address = "https://bao.home.test:8200";
    const app = await opened({ keyManagers: { untrusted: [address] } });
    const form = await choose(app, "OpenBao or Vault");
    await app.user.type(within(form).getByRole("textbox", { name: "Address" }), address);
    await app.user.click(within(form).getByRole("radio", { name: "With AppRole" }));
    await moreOptions(app, form);
    await app.user.clear(within(form).getByRole("textbox", { name: "Name" }));
    await app.user.type(within(form).getByRole("textbox", { name: "Name" }), "Home OpenBao");

    // The certificate is optional, read from the one the address presents, and chosen only once it is trusted.
    expect(within(form).getByText("None pinned: the system's trusted CAs verify it.")).toBeDefined();
    await app.user.click(within(form).getByRole("button", { name: "Read its certificate" }));
    const check = await dialog(`The certificate ${address} presents`);
    const anchor = certificateOf(address);
    expect(facts(check)).toMatchObject({ "SHA-256 fingerprint": anchor.sha256Fingerprint, Subject: "CN=bao.home.test test CA", "Signs itself": "Yes: it is a root CA." });
    await app.user.click(within(check).getByRole("button", { name: "Trust this certificate" }));
    expect(await within(form).findByText("Pinned: requests to it trust this CA alone.")).toBeDefined();

    await app.user.type(within(form).getByLabelText("Role ID"), "role-for-tests");
    await app.user.type(within(form).getByLabelText("Secret ID"), "secret-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Connect OpenBao" }));

    expect(await within(step()).findByText("Connected to Home OpenBao.")).toBeDefined();
    const home = await connection("Home OpenBao");
    expect(within(home).getByText(line(/^Connected since \d\d:\d\d\.$/))).toBeDefined();
    expect(within(step()).queryByRole("form")).toBeNull();
    const desk = app.environment("desk");
    expect(desk.requests("keyManagers.connections.add")).toHaveLength(1);
    expect(desk.requests("keyManagers.connections.add")[0]?.params).toMatchObject({
      provider: "openbao",
      label: "Home OpenBao",
      address,
      ca: anchor.pem,
      method: "approle",
      mount: "approle",
      credential: { method: "approle", roleId: "role-for-tests", secretId: "secret-for-tests" },
    });
    expect(desk.keyManagerConnections()[0]).toMatchObject({ ca: anchor.pem, status: { kind: "signed-in" } });
    // The credential crossed the wire once, and nothing this client keeps holds it.
    expect(JSON.stringify([app.platform.documents.entries(), app.shell.calls])).not.toContain("secret-for-tests");
  });

  it("says a connection saved while its address does not answer is saved but not reached, never Added followed by what failed, its health one line with Check again", async () => {
    const address = "https://127.0.0.1:1";
    const app = await opened({ keyManagers: { unreachable: [address] } });
    const form = await choose(app, "OpenBao or Vault");
    await app.user.type(within(form).getByRole("textbox", { name: "Address" }), address);
    await app.user.type(within(form).getByLabelText("Token"), "token-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Connect OpenBao" }));

    expect(await within(step()).findByText("Saved, but agent-harness could not reach https://127.0.0.1:1. Check the address, then choose Check again.")).toBeDefined();
    const saved = await connection("OpenBao");
    expect(within(saved).getByText(line(/^Not answering since \d\d:\d\d\. Check the address and the connection, then choose Check again\.$/))).toBeDefined();
    expect(within(saved).getAllByRole("button").map((button) => button.textContent)).toEqual(["Check again"]);
    expect(within(step()).queryByText(/Added|ECONNREFUSED/)).toBeNull();
  });

  it("says a refused sign-in in plain words as an alert, what the key manager answered under Details, keeping what was typed but the secret", async () => {
    const app = await opened({ keyManagers: { rejects: ["token-refused-for-tests"] } });
    const form = await choose(app, "OpenBao or Vault");
    await app.user.type(within(form).getByRole("textbox", { name: "Address" }), "https://bao.home.test:8200");
    await app.user.type(within(form).getByLabelText("Token"), "token-refused-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Connect OpenBao" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("Error: OpenBao did not accept these details. Check them and try again.");
    const details = within(form).getByRole("region", { name: "Details" });
    expect(details.textContent).toContain("OpenBao at https://bao.home.test:8200 refused the credential (HTTP 400: invalid role or secret ID).");
    expect((within(form).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("https://bao.home.test:8200");
    expect((within(form).getByLabelText("Token") as HTMLInputElement).value).toBe("");
  });

  it("marks a key manager this computer cannot connect to yet for the visit, once Connect is refused with provider_unavailable", async () => {
    const app = await opened();
    const form = await choose(app, "Doppler");
    await app.user.type(within(form).getByLabelText("Token"), "token-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Connect Doppler" }));

    expect((await within(form).findByRole("alert")).textContent).toBe("Error: agent-harness cannot connect to Doppler on this computer yet.");
    const doppler = within(await question()).getByRole("radio", { name: "Doppler" });
    const mark = () => document.getElementById(doppler.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(mark()).toBe("Not available on this computer yet.");
    // Another choice and back: still marked, and the others are not.
    await app.user.click(within(await question()).getByRole("radio", { name: "OpenBao or Vault" }));
    await app.user.click(within(await question()).getByRole("radio", { name: "Doppler" }));
    expect(mark()).toBe("Not available on this computer yet.");
    const bao = within(await question()).getByRole("radio", { name: "OpenBao or Vault" });
    expect(document.getElementById(bao.getAttribute("aria-describedby") ?? "")?.textContent).toBe("");
  });
});

describe("a connection", () => {
  it("says its health in one line with the one button that fixes it, telling sealed, expired and unreachable apart", async () => {
    const status = (kind: KeyManagerStatusKind, message: string) => ({ kind, since: MANUAL_CLOCK_START, message });
    const app = await opened({
      keyManagers: {
        connections: [
          { label: "Sealed", address: "https://bao-sealed.test", status: status("sealed", "OpenBao at https://bao-sealed.test is sealed: unseal it to sign in.") },
          { label: "Old", address: "https://bao-old.test", method: "token", mount: "token", status: status("expired", "The token this connection signed in with expired.") },
          { label: "Down", address: "https://bao-down.test", status: status("unreachable", "OpenBao at https://bao-down.test could not answer (HTTP 500: internal error).") },
        ],
      },
    });
    const lines: Record<string, [RegExp, string]> = {
      Sealed: [/^Locked \(sealed\) since [^.]+\. Unlock it, then choose Check again\.$/, "Check again"],
      Old: [/^Expired since [^.]+\. Sign in with a new token\.$/, "Sign in again"],
      Down: [/^Not answering since [^.]+\. Check the address and the connection, then choose Check again\.$/, "Check again"],
    };
    for (const [label, [health, action]] of Object.entries(lines)) {
      const held = await connection(label);
      expect(within(held).getByText(line(health))).toBeDefined();
      // One button, and none of the environment's own words beside the line.
      expect(within(held).getAllByRole("button").map((button) => button.textContent)).toEqual([action]);
      expect(within(held).queryByText(/HTTP 500|unseal it to sign in|signed in with expired/)).toBeNull();
    }

    // Unsealed since, Check again finds it connected.
    const desk = app.environment("desk");
    const sealed = desk.keyManagerConnections().find((each) => each.label === "Sealed");
    desk.setKeyManagerStatus(sealed?.id ?? "", { kind: "signed-in", message: "Signed in to OpenBao as approle." });
    await app.user.click(within(await connection("Sealed")).getByRole("button", { name: "Check again" }));
    await waitFor(async () => expect(within(await connection("Sealed")).getByText(line(/^Connected since [^.]+\.$/))).toBeDefined());
    expect(desk.requests("keyManagers.connections.verify")[0]?.params).toEqual({ connectionId: sealed?.id });
    expect(within(await connection("Sealed")).queryByRole("button", { name: "Check again" })).toBeNull();

    // An expired token's Sign in again opens the sign-in for it.
    await app.user.click(within(await connection("Old")).getByRole("button", { name: "Sign in again" }));
    expect(await dialog("Sign in to Old again")).toBeDefined();
  });

  it("shows Let every run use {label}'s keys on as Settings › Key managers does: injection allowed and the connection's keys the ones runs get", async () => {
    const app = await opened({
      settings: { "credentials.injection": "allow" },
      keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", injects: false }] },
    });
    const home = await connection("Home OpenBao");
    const injection = within(home).getByRole("switch", { name: "Let every run use Home OpenBao's keys" });
    expect(within(home).getByText("You can turn this off for one account, routine or bot in Settings.")).toBeDefined();
    // Injection is allowed, but runs get another connection's keys or none: off, as Settings says "They do not receive its variables."
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("false"));

    const desk = app.environment("desk");
    await app.user.click(injection);
    await waitFor(() => expect(desk.requests("keyManagers.connections.setInjected")).toHaveLength(1));
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("true"));
    expect(desk.requests("settings.update")).toEqual([]);
    // Off denies the one answer every supplier reads, which the switch says while it is on.
    const offWords = "Turning it off stops every key manager's keys and the forges' credentials for runs here.";
    expect(within(home).getByText(offWords)).toBeDefined();

    await app.user.click(injection);
    await waitFor(() => expect(desk.settings()["credentials.injection"]).toBe("deny"));
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("false"));
    expect(within(home).queryByText(offWords)).toBeNull();
    await app.user.click(injection);
    await waitFor(() => expect(desk.settings()["credentials.injection"]).toBe("allow"));
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("true"));
    expect(desk.requests("settings.update").map((request) => request.params["values"])).toEqual([{ "credentials.injection": "deny" }, { "credentials.injection": "allow" }]);
    expect(desk.requests("keyManagers.connections.setInjected")).toHaveLength(1);
  });

  it("keeps the login's policy ticks under More options, a ticked policy that writes carrying ADR 0028's warning until it is unticked", async () => {
    const app = await opened({
      keyManagers: {
        policies: [
          { name: "default", writes: "no" },
          { name: "harness-write", writes: "yes" },
        ],
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", ticks: ["default", "harness-write"] }],
      },
    });
    await connection("Home OpenBao");
    const more = within(step()).getByRole("region", { name: "More options for your key managers" });
    await moreOptions(app, more);
    const policies = within(within(more).getByRole("group", { name: "Home OpenBao" })).getByRole("group", { name: "Policies runs receive" });
    const warning = "Runs given this policy can write to your key manager: untick it to keep them read-only.";
    expect(within(policies).getByRole("checkbox", { name: "default, reads only" })).toHaveProperty("checked", true);
    expect(within(policies).getByRole("checkbox", { name: "harness-write, writes" })).toHaveProperty("checked", true);
    expect(within(policies).getAllByText(warning)).toHaveLength(1);

    await app.user.click(within(policies).getByRole("checkbox", { name: "harness-write, writes" }));
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("keyManagers.connections.setPolicies").map((request) => request.params["ticks"])).toEqual([["default"]]));
    await waitFor(() => expect(within(policies).queryByText(warning)).toBeNull());
    expect(desk.keyManagerConnections()[0]?.ticks).toEqual(["default"]);
  });
});

/** The rows xterm.js draws in a tool terminal, each trimmed of its trailing blanks, the blank rows after the last dropped. */
const screenOf = (terminal: HTMLElement) => {
  const drawn = [...terminal.querySelectorAll(".xterm-rows > div")].map((line) => (line.textContent ?? "").replace(/\u00a0/g, " ").trimEnd());
  while (drawn.length > 0 && drawn.at(-1) === "") drawn.pop();
  return drawn;
};

/** bao's install by its apt repository under sudo, asking the password, and the probe after it. */
const BAO_RUN = {
  method: "apt",
  command: "sudo apt-get install openbao",
  password: "password-for-tests",
  output: "Setting up openbao (2.4.1) ...\r\n",
  after: { path: "/usr/bin/bao", realpath: "/usr/bin/bao", version: "2.4.1", latest: "2.4.1", method: "apt", status: "current", action: "update" },
} as const;

describe("the CLI row", () => {
  it("shares one terminal between the step's named Install and its connection's CLI row", async () => {
    const app = await opened({
      keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }], tools: [{ tool: "bao", path: null, realpath: null, version: null, status: "not-installed", action: "install" }] },
      managedTools: { runs: { bao: { exitCode: null } } },
      setup: { "key-manager": { state: "needs-attention", reason: "The bao tool is not installed on desk. Install it so agents can use Home OpenBao.", failing: ["key-manager.cli"], actions: ["install"],
        targets: [{ action: "install", kind: "tool", id: "bao", label: "bao" }],
      } },
    });
    await connection("Home OpenBao");
    await app.user.click(within(step()).getByRole("button", { name: "Install bao in a tool terminal" }));
    await within(step()).findByRole("region", { name: "Installing OpenBao CLI" });
    expect(within(step()).getAllByRole("region", { name: "Installing OpenBao CLI" })).toHaveLength(1);
    expect(app.environment("desk").requests("tools.run")).toHaveLength(1);
  });

  it("keeps the connection's CLI row under More options, whose Install runs tools.run in a tool terminal on the card, where the sudo password is typed, then shows the new probe", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }],
        tools: [{ tool: "bao", path: null, realpath: null, version: null, latest: null, minimum: "2.1.1", method: null, status: "not-installed", action: "install" }],
      },
      managedTools: { runs: { bao: BAO_RUN }, verifications: { bao: { outcome: "passed", reason: "bao looked up its run token at https://bao.home.test:8200: policies default, agent-read." } } },
    });
    await connection("Home OpenBao");
    const more = within(step()).getByRole("region", { name: "More options for your key managers" });
    await moreOptions(app, more);
    // The step's own line says the tool is missing; the card does not say it twice.
    expect(within(step()).queryByText(/^OpenBao CLI is not installed: runs receive/)).toBeNull();
    const cli = within(more).getByRole("region", { name: "OpenBao CLI" });
    expect(facts(cli)).toMatchObject({ Minimum: "2.1.1", Status: "Not installed" });
    await app.user.click(within(cli).getByRole("button", { name: "Install" }));

    const terminal = await within(step()).findByRole("region", { name: "Installing OpenBao CLI" });
    await waitFor(() => expect(screenOf(terminal)).toEqual(["$ sudo apt-get install openbao", "[sudo] password for milo:"]));
    const desk = app.environment("desk");
    const [run] = desk.requests("tools.run");
    expect(run?.params).toEqual({ commandId: expect.any(String), tool: "bao", action: "install", id: expect.any(String) });
    act(() => (terminal.querySelector("textarea") as HTMLTextAreaElement).focus());
    await app.user.keyboard("password-for-tests{Enter}");
    await waitFor(() => expect(desk.terminal(String(run?.params["id"])).writes.join("")).toBe("password-for-tests\r"));
    expect(await within(terminal).findByText("· exit 0")).toBeDefined();

    // The probe after the run reaches the connection's own row through keyManagers.list.
    await waitFor(() => expect(facts(within(within(step()).getByRole("region", { name: "More options for your key managers" })).getByRole("region", { name: "OpenBao CLI" }))).toMatchObject({ Version: "2.4.1", Status: "Current" }));
    await app.user.click(within(terminal).getByRole("button", { name: "Close" }));
    expect(within(step()).queryByRole("region", { name: "Installing OpenBao CLI" })).toBeNull();
  });
});

/** The Move saved tokens part of the card. */
const moveCard = () => within(step()).getByRole("region", { name: "Move saved tokens" });

/** The lines the last Move said, one per item. */
const moved = async () => (await within(moveCard()).findByRole("list", { name: "What the Move did" })).querySelectorAll("li");

describe("Move saved tokens", () => {
  it("shows only while agent-harness keeps tokens itself and a key manager is connected", async () => {
    const none = await opened({ keyManagers: { items: [{ name: "https://github.com", slug: "github" }] } });
    await question();
    expect(within(step()).queryByRole("region", { name: "Move saved tokens" })).toBeNull();
    none.view.unmount();

    const empty = await opened({ keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }] } });
    await connection("Home OpenBao");
    await waitFor(() => expect(empty.environment("desk").requests("keyManagers.move.list").length).toBeGreaterThan(0));
    expect(within(step()).queryByRole("region", { name: "Move saved tokens" })).toBeNull();
  });

  it("asks to move the tokens agent-harness keeps into the key manager, in the folder it suggests, and Move them moves every one", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", basePath: null, suggestedBasePath: "personal/harness" }],
        items: [
          { name: "https://github.com", slug: "github" },
          { name: "https://git.example.test", slug: "git-example" },
        ],
      },
    });
    await connection("Home OpenBao");
    const move = await within(step()).findByRole("region", { name: "Move saved tokens" });
    expect(await within(move).findByText("agent-harness keeps 2 tokens itself. Move them into Home OpenBao?")).toBeDefined();
    const folder = within(move).getByRole("textbox", { name: "Folder in Home OpenBao" }) as HTMLInputElement;
    await waitFor(() => expect(folder.value).toBe("personal/harness"));
    await app.user.click(within(move).getByRole("button", { name: "Move them" }));

    const desk = app.environment("desk");
    await waitFor(() => expect(desk.requests("keyManagers.move")).toHaveLength(1));
    expect(desk.requests("keyManagers.connections.setBasePath")[0]?.params).toMatchObject({ basePath: "personal/harness" });
    expect(desk.requests("keyManagers.move")[0]?.params).toMatchObject({ items: "all" });
    expect(desk.keyManagerValue("personal/harness/forge-github")).toBe("stored-token-for-tests-github");
    expect(desk.keyManagerValue("personal/harness/forge-git-example")).toBe("stored-token-for-tests-git-example");
    // Setting the base path on the way changes the connection; the Move it started still says what it did.
    await waitFor(async () => expect(await moved()).toHaveLength(2));
  });

  it("offers Copy value once where the login cannot write, and a verify-only Move of the paste finishes", async () => {
    const app = await opened({
      keyManagers: {
        writable: false,
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", basePath: "personal/harness" }],
        items: [{ name: "https://github.com", slug: "github" }],
      },
    });
    await connection("Home OpenBao");
    await app.user.click(within(await within(step()).findByRole("region", { name: "Move saved tokens" })).getByRole("button", { name: "Move them" }));
    await waitFor(async () => expect((await moved())[0]?.textContent).toMatch(/may not write OpenBao at personal\/harness\/forge-github/));

    await app.user.click(within(moveCard()).getByRole("button", { name: "Copy value" }));
    const copy = await dialog("Paste this value into Home OpenBao");
    expect((within(copy).getByRole("textbox", { name: "The stored token" }) as HTMLInputElement).value).toBe("stored-token-for-tests-github");
    await app.user.click(within(copy).getByRole("button", { name: "Done" }));
    expect(within(moveCard()).queryByRole("button", { name: "Copy value" })).toBeNull();

    const desk = app.environment("desk");
    desk.pasteKeyManagerValue("personal/harness/forge-github", "stored-token-for-tests-github");
    await app.user.click(within(moveCard()).getByRole("button", { name: "Verify the paste" }));
    await waitFor(async () =>
      expect([...(await moved())].map((line) => line.textContent)).toEqual([
        "https://github.com: Verified the value pasted at OpenBao at personal/harness/forge-github (key token) and moved to it; the stored token was deleted.",
      ]),
    );
    expect(desk.requests("keyManagers.move.copyValue")).toHaveLength(1);
    expect(desk.requests("keyManagers.move").at(-1)?.params).toMatchObject({ verifyOnly: true });
  });

  it("is where the Forges card's Move to your key manager goes: the full checklist on the Key manager step, Move saved tokens taking the focus", async () => {
    const app = await renderApp({
      environments: [
        {
          name: "desk",
          reach: "local",
          capabilities: [...FLAGGED, "forge"],
          forges: { accounts: [{}, { origin: "https://git.example.test", kind: "forgejo", credential: { kind: "gh", login: "david" } }] },
          keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }], items: [{ name: "https://github.com", slug: "github" }] },
        },
      ],
    });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Forges" }));
    const forges = within(settings).getByRole("region", { name: "Forges" });
    // A token the environment's own gh reads holds nothing to move; a stored one does.
    expect(within(await within(forges).findByRole("region", { name: "https://git.example.test" })).queryByRole("button", { name: "Move to your key manager" })).toBeNull();
    await app.user.click(within(await within(forges).findByRole("region", { name: "https://github.com" })).getByRole("button", { name: "Move to your key manager" }));

    expect(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
    await waitFor(() => expect(document.activeElement).toBe(moveCard()));
    expect(within(moveCard()).getByText("agent-harness keeps 1 token itself. Move it into Home OpenBao?")).toBeDefined();
  });
});

describe("without admin", () => {
  it("is read-only with the capability's line, said once", async () => {
    const app = await renderApp(
      {
        environments: [
          {
            name: "desk",
            reach: "paired",
            capabilities: [...FLAGGED],
            scopes: ["read", "sessions:write", "runs:drive", "terminal"],
            settings: { "credentials.injection": "allow" },
            keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", status: { kind: "sealed", since: MANUAL_CLOCK_START, message: "OpenBao at https://bao.home.test:8200 is sealed." } }], items: [{ name: "https://github.com", slug: "github" }] },
          },
        ],
      },
      { firstLaunch: true },
    );
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await screen.findByRole("region", { name: "Set up" });
    await app.user.click(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }));
    expect(await within(step()).findAllByText("You can look but not change this. This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toHaveLength(1);
    const home = await connection("Home OpenBao");
    expect(within(home).getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(within(home).getByRole("switch").hasAttribute("disabled")).toBe(true));
    for (const radio of within(await question()).getAllByRole("radio")) expect(radio.hasAttribute("disabled")).toBe(true);
    const more = within(step()).getByRole("region", { name: "More options for your key managers" });
    await moreOptions(app, more);
    for (const box of within(more).getAllByRole("checkbox")) expect(box.hasAttribute("disabled")).toBe(true);
    expect(within(within(more).getByRole("region", { name: "OpenBao CLI" })).getByRole("button", { name: "Verify" }).hasAttribute("disabled")).toBe(true);
    expect(within(await within(step()).findByRole("region", { name: "Move saved tokens" })).getByRole("button", { name: "Move them" }).hasAttribute("disabled")).toBe(true);
  });
});
