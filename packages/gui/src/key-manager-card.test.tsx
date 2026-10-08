import { act, screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import type { KeyManagerStatusKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { certificateOf, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Key manager card in Set up (the Set up specification, "5. Key
 * manager"; key-managers spec, "The Key manager step"; ADR 0028; #590): the
 * four provider tiles, each with its sign-in form, OpenBao's with an
 * optional CA from the certificate preview; after sign-in, the policy ticks
 * with the write warning, the injection switch, the CLI's Managed tools row
 * with Install or Update in a tool terminal, and Move stored tokens; the
 * health lines telling sealed, expired, unreachable and a missing CLI
 * apart; the Forges card's way to the Move card; and the card read-only
 * without `admin`. Driven through the harness's full checklist over the
 * scripted environment's key-manager and tools answers, in jsdom.
 */

/** The flags an environment with key managers offers: `keyManagers`, and `managedTools` for the CLI rows' Install and Update. */
const FLAGGED = ["keyManagers", "managedTools"] as const;

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The Key manager step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Key manager" });

/** A provider's tile on the card, by the provider's name. */
const tile = (name: string) => within(step()).getByRole("region", { name });

/** The full checklist on its first launch over `desk`, this machine's environment, as `desk` scripts it, showing the Key manager step. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}): Promise<RenderedApp> => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: [...FLAGGED], ...desk }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }));
  return app;
};

describe("the provider tiles", () => {
  it("shows four: OpenBao or Vault, Doppler, 1Password, and Bitwarden Secrets Manager, each offering its sign-in", async () => {
    await opened();
    await waitFor(() =>
      expect(within(step()).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(
        expect.arrayContaining(["OpenBao or Vault", "Doppler", "1Password", "Bitwarden Secrets Manager"]),
      ),
    );
    for (const name of ["OpenBao or Vault", "Doppler", "1Password", "Bitwarden Secrets Manager"]) expect(within(tile(name)).getByRole("button", { name: "Sign in" })).toBeDefined();
  });
});

/** The dialog open, by its name. */
const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

/** What a region says, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

/** A line whose whole text, its parts in other elements included, matches `text`. */
const line = (text: RegExp) => (_: string, element: Element | null) => element?.tagName === "P" && text.test(element.textContent ?? "");

/** A connection on its provider's tile, by its label, once it is drawn. */
const connection = (provider: string, label: string) => within(tile(provider)).findByRole("region", { name: label });

describe("signing in from a tile", () => {
  it("signs in to OpenBao with keyManagers.connections.add sent directly, its CA the anchor keyManagers.certificate.preview read and a person accepted, by AppRole", async () => {
    const address = "https://bao.home.test:8200";
    const app = await opened({ keyManagers: { untrusted: [address] } });
    const bao = tile("OpenBao or Vault");
    await app.user.click(within(bao).getByRole("button", { name: "Sign in" }));
    const form = within(bao).getByRole("form", { name: "Sign in to OpenBao or Vault" });
    // The tile is OpenBao's alone: no provider to choose; AppRole, userpass or token.
    expect(within(form).queryByRole("combobox", { name: "Provider" })).toBeNull();
    expect(within(within(form).getByRole("combobox", { name: "Signs in by" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["AppRole", "userpass", "token"]);
    await app.user.clear(within(form).getByRole("textbox", { name: "Label" }));
    await app.user.type(within(form).getByRole("textbox", { name: "Label" }), "Home OpenBao");
    await app.user.type(within(form).getByRole("textbox", { name: "Address" }), address);

    // The CA is optional, read from the certificate the address presents, and chosen only once it is trusted.
    expect(within(form).getByText("None pinned: the system's trusted CAs verify it.")).toBeDefined();
    await app.user.click(within(form).getByRole("button", { name: "Read its certificate" }));
    const check = await dialog(`The certificate ${address} presents`);
    const anchor = certificateOf(address);
    expect(facts(check)).toMatchObject({ "SHA-256 fingerprint": anchor.sha256Fingerprint, Subject: "CN=bao.home.test test CA", "Signs itself": "Yes: it is a root CA." });
    await app.user.click(within(check).getByRole("button", { name: "Trust this certificate" }));
    expect(await within(form).findByText("Pinned: requests to it trust this CA alone.")).toBeDefined();

    await app.user.type(within(form).getByLabelText("Role ID"), "role-for-tests");
    await app.user.type(within(form).getByLabelText("Secret ID"), "secret-for-tests");
    await app.user.click(within(form).getByRole("button", { name: "Sign in" }));

    const home = await connection("OpenBao or Vault", "Home OpenBao");
    expect(within(home).getByText(line(/^Signed in since \d\d:\d\d\. Signed in to OpenBao as approle\.$/))).toBeDefined();
    expect(within(tile("OpenBao or Vault")).queryByRole("form")).toBeNull();
    expect(within(tile("OpenBao or Vault")).getByText("Added Home OpenBao: Signed in to OpenBao as approle.")).toBeDefined();
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
});

describe("after sign-in", () => {
  it("shows the login's policies as ticks, a ticked policy that writes carrying ADR 0028's warning until it is unticked with keyManagers.connections.setPolicies", async () => {
    const app = await opened({
      keyManagers: {
        policies: [
          { name: "default", writes: "no" },
          { name: "harness-write", writes: "yes" },
        ],
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", ticks: ["default", "harness-write"] }],
      },
    });
    const home = await connection("OpenBao or Vault", "Home OpenBao");
    const policies = within(home).getByRole("group", { name: "Policies runs receive" });
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

  it("shows the injection switch with its sentence once a connection is here, on as credentials.injection allows, writing credentials.injection through settings.update", async () => {
    const sentence = "Every run on this environment receives this key manager's variables unless an account, routine or bot turns it off.";
    const none = await opened({ settings: { "credentials.injection": "allow" } });
    // Nothing is connected yet: no switch, and the Move card says what it waits for.
    expect(await within(step()).findByText("Sign in to a key manager above to move your stored tokens into it.")).toBeDefined();
    expect(within(step()).queryByRole("switch")).toBeNull();
    none.view.unmount();

    const app = await opened({ settings: { "credentials.injection": "allow" }, keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }] } });
    const injection = await within(step()).findByRole("switch", { name: sentence });
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("true"));
    await app.user.click(injection);
    const desk = app.environment("desk");
    await waitFor(() => expect(desk.settings()["credentials.injection"]).toBe("deny"));
    await waitFor(() => expect(injection.getAttribute("aria-checked")).toBe("false"));
    await app.user.click(injection);
    await waitFor(() => expect(desk.settings()["credentials.injection"]).toBe("allow"));
    expect(desk.requests("settings.update").map((request) => request.params["values"])).toEqual([{ "credentials.injection": "deny" }, { "credentials.injection": "allow" }]);
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
      setup: { "key-manager": { state: "needs-attention", reason: "bao is not installed.", failing: ["key-manager.cli"], actions: ["install"],
        targets: [{ action: "install", kind: "tool", id: "bao", label: "bao" }],
      } },
    });
    await connection("OpenBao or Vault", "Home OpenBao");
    await app.user.click(within(step()).getByRole("button", { name: "Install bao in a tool terminal" }));
    await within(step()).findByRole("region", { name: "Installing OpenBao CLI" });
    expect(within(step()).getAllByRole("region", { name: "Installing OpenBao CLI" })).toHaveLength(1);
    expect(app.environment("desk").requests("tools.run")).toHaveLength(1);
  });

  it("says a CLI the injecting connection lacks, and Install runs tools.run in a tool terminal on the card, where the sudo password is typed, then shows the new probe", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }],
        tools: [{ tool: "bao", path: null, realpath: null, version: null, latest: null, minimum: "2.1.1", method: null, status: "not-installed", action: "install" }],
      },
      managedTools: { runs: { bao: BAO_RUN }, verifications: { bao: { outcome: "passed", reason: "bao looked up its run token at https://bao.home.test:8200: policies default, agent-read." } } },
    });
    const home = await connection("OpenBao or Vault", "Home OpenBao");
    expect(
      within(home).getByText(
        "OpenBao CLI is not installed: runs receive this key manager's variables but cannot read it from their shell until it is installed. The harness still resolves its own references over the key manager's API without it, so forge and bank credentials keep working.",
      ),
    ).toBeDefined();
    const cli = within(home).getByRole("region", { name: "OpenBao CLI" });
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

    // The probe after the run reaches the connection's own row through keyManagers.list, and the line goes.
    await waitFor(async () => expect(facts(within(await connection("OpenBao or Vault", "Home OpenBao")).getByRole("region", { name: "OpenBao CLI" }))).toMatchObject({ Version: "2.4.1", Status: "Current" }));
    expect(within(await connection("OpenBao or Vault", "Home OpenBao")).queryByText(/^OpenBao CLI is not installed/)).toBeNull();
    await app.user.click(within(terminal).getByRole("button", { name: "Close" }));
    expect(within(step()).queryByRole("region", { name: "Installing OpenBao CLI" })).toBeNull();
  });
});

/** The Move card on the Key manager card. */
const moveCard = () => within(step()).getByRole("region", { name: "Move stored tokens" });

/** A stored token's row on the Move card, by its name. */
const item = (name: string) => within(moveCard()).findByRole("listitem", { name });

/** The lines the last Move said, one per item. */
const moved = async () => (await within(moveCard()).findByRole("list", { name: "What the Move did" })).querySelectorAll("li");

describe("Move stored tokens", () => {
  it("shows the base path and each item's target, with Move and Move all", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", basePath: "personal/harness" }],
        items: [
          { name: "https://github.com", slug: "github" },
          { name: "https://git.example.test", slug: "git-example" },
        ],
      },
    });
    await connection("OpenBao or Vault", "Home OpenBao");
    expect((within(moveCard()).getByRole("textbox", { name: "Base path" }) as HTMLInputElement).value).toBe("personal/harness");
    expect(within(await item("https://github.com")).getByText("To personal/harness/forge-github (key token)")).toBeDefined();
    expect(within(await item("https://git.example.test")).getByText("To personal/harness/forge-git-example (key token)")).toBeDefined();
    expect(within(moveCard()).getByRole("button", { name: "Move all" })).toBeDefined();

    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Move" }));
    await waitFor(async () =>
      expect([...(await moved())].map((line) => line.textContent)).toEqual([expect.stringMatching(/^https:\/\/github\.com: Moved to OpenBao at personal\/harness\/forge-github/)]),
    );
    const desk = app.environment("desk");
    expect(desk.keyManagerValue("personal/harness/forge-github")).toBe("stored-token-for-tests-github");
    expect(desk.requests("keyManagers.move")[0]?.params).toMatchObject({ items: [{ kind: "forge-account" }] });
  });

  it("offers Copy value once where the login cannot write, and a verify-only Move of the paste finishes", async () => {
    const app = await opened({
      keyManagers: {
        writable: false,
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200", basePath: "personal/harness" }],
        items: [{ name: "https://github.com", slug: "github" }],
      },
    });
    await connection("OpenBao or Vault", "Home OpenBao");
    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Move" }));
    await waitFor(async () => expect((await moved())[0]?.textContent).toMatch(/may not write OpenBao at personal\/harness\/forge-github/));

    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Copy value" }));
    const copy = await dialog("Paste this value into Home OpenBao");
    expect((within(copy).getByRole("textbox", { name: "The stored token" }) as HTMLInputElement).value).toBe("stored-token-for-tests-github");
    await app.user.click(within(copy).getByRole("button", { name: "Done" }));
    expect(within(await item("https://github.com")).queryByRole("button", { name: "Copy value" })).toBeNull();

    const desk = app.environment("desk");
    desk.pasteKeyManagerValue("personal/harness/forge-github", "stored-token-for-tests-github");
    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Verify the paste" }));
    await waitFor(async () =>
      expect([...(await moved())].map((line) => line.textContent)).toEqual([
        "https://github.com: Verified the value pasted at OpenBao at personal/harness/forge-github (key token) and moved to it; the stored token was deleted.",
      ]),
    );
    expect(desk.requests("keyManagers.move.copyValue")).toHaveLength(1);
    expect(desk.requests("keyManagers.move").at(-1)?.params).toMatchObject({ verifyOnly: true });
  });

  it("is where the Forges card's Keep this token in your key manager goes: the full checklist on the Key manager step, its Move card taking the focus", async () => {
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
    expect(within(await within(forges).findByRole("region", { name: "https://git.example.test" })).queryByRole("button", { name: "Keep this token in your key manager" })).toBeNull();
    await app.user.click(await within(await within(forges).findByRole("region", { name: "https://github.com" })).findByRole("button", { name: "Keep this token in your key manager" }));

    expect(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
    await waitFor(() => expect(document.activeElement).toBe(moveCard()));
    expect(await item("https://github.com")).toBeDefined();
  });
});

describe("the health lines", () => {
  it("tell sealed, expired and unreachable apart in the key-managers spec's words, each with its action", async () => {
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
      Sealed: [/^Sealed since \d\d:\d\d\. OpenBao at https:\/\/bao-sealed\.test is sealed: unseal it to sign in\. Unseal it, then Verify now\.$/, "Verify now"],
      Old: [/^Expired since \d\d:\d\d\. The token this connection signed in with expired\. Sign in again with a new token\.$/, "Sign in again"],
      Down: [/^Unreachable since \d\d:\d\d\. OpenBao at https:\/\/bao-down\.test could not answer \(HTTP 500: internal error\)\. Check the address and that the key manager is up and reachable from this environment, then Verify now\.$/, "Verify now"],
    };
    for (const [label, [health, action]] of Object.entries(lines)) {
      const held = await connection("OpenBao or Vault", label);
      expect(within(held).getByText(line(health))).toBeDefined();
      expect(within(held).getByRole("button", { name: action })).toBeDefined();
    }

    // Unsealed since, Verify now finds it signed in.
    const desk = app.environment("desk");
    const sealed = desk.keyManagerConnections().find((each) => each.label === "Sealed");
    desk.setKeyManagerStatus(sealed?.id ?? "", { kind: "signed-in", message: "Signed in to OpenBao as approle." });
    await app.user.click(within(await connection("OpenBao or Vault", "Sealed")).getByRole("button", { name: "Verify now" }));
    await waitFor(async () => expect(within(await connection("OpenBao or Vault", "Sealed")).getByText(line(/^Signed in since \d\d:\d\d\. Signed in to OpenBao as approle\.$/))).toBeDefined());
    expect(desk.requests("keyManagers.connections.verify")[0]?.params).toEqual({ connectionId: sealed?.id });
    expect(within(await connection("OpenBao or Vault", "Sealed")).queryByRole("button", { name: "Verify now" })).toBeNull();

    // An expired token's Sign in again opens the sign-in for it.
    await app.user.click(within(await connection("OpenBao or Vault", "Old")).getByRole("button", { name: "Sign in again" }));
    expect(await dialog("Sign in to Old again")).toBeDefined();
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
    expect(await within(step()).findAllByText("Read-only: This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toHaveLength(1);
    const home = await connection("OpenBao or Vault", "Home OpenBao");
    for (const name of ["Sign in to another", "Verify now"]) expect(within(tile("OpenBao or Vault")).getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    for (const name of ["Doppler", "1Password", "Bitwarden Secrets Manager"]) expect(within(tile(name)).getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(true);
    for (const box of within(home).getAllByRole("checkbox")) expect(box.hasAttribute("disabled")).toBe(true);
    expect(within(within(home).getByRole("region", { name: "OpenBao CLI" })).getByRole("button", { name: "Verify" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(within(step()).getByRole("switch").hasAttribute("disabled")).toBe(true));
    expect(within(await item("https://github.com")).getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
  });
});
