import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import type { KeyManagerStatus, KeyManagerStatusKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { certificateOf, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Key managers row (docs/specs/gui.md, "Settings"; key-managers spec,
 * "Wire methods", "Move stored tokens" and "Injection"; ADR 0011, ADR 0028;
 * #425): a card per connection from the cached `keyManagers.list`, Add with
 * the certificate preview, the card's sign-in, edit, sign-out, removal,
 * verification, policy ticks and injection, the Move card, the injection
 * setting and copies to other environments, driven through the harness over
 * the scripted environment's key-manager answers.
 */

/** The flags an environment with key managers offers: `keyManagers`, which the row reads, and `managedTools`, whose `tools.list` it does not (#776). */
const FLAGGED = ["keyManagers", "managedTools"] as const;

/** The window over `desk`, this machine's environment, as `desk` scripts it, and the other environments given, paired. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, others: readonly ScriptedEnvironment[] = []) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: [...FLAGGED], ...desk }, ...others] });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings on Key managers with Mod+, and the rail, as a person does, on the environment named when it is not the home one. */
const openKeyManagers = async (app: RenderedApp, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Key managers" }));
  if (environment !== undefined) await app.user.selectOptions(within(pane()).getByRole("combobox", { name: "Environment" }), environment);
  return pane();
};

/** The Key managers pane. */
const pane = () => within(settings()).getByRole("region", { name: "Key managers" });

/** A connection's card, by its label. */
const card = (label: string) => within(pane()).findByRole("region", { name: label });

/** What a card says of its connection, each fact by its name. */
const facts = (region: HTMLElement): Record<string, string> => {
  const terms = within(region).getAllByRole("term");
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
};

describe("a connection's card", () => {
  it("marks a signed-in connection as verified and describes the keyboard action", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Project keys" }] } });
    await openKeyManagers(app);
    const connection = await card("Project keys");
    expect(within(connection).getByText("Verified")).toBeDefined();
    const verify = within(connection).getByRole("button", { name: "Verify now" });
    expect(verify.querySelector("svg")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => verify.focus());
    expect(await screen.findByRole("tooltip", { name: "Verify now · Enter / Space" })).toBeDefined();
  });

  it("shows what the cached keyManagers.list holds of it: provider, label, address, method, status with its line, token, minting, base path, injection, its CLI row and a copy's source", async () => {
    const app = await opened({
      keyManagers: {
        connections: [
          {
            label: "Home OpenBao",
            address: "https://bao.home.test:8200",
            basePath: null,
            suggestedBasePath: "personal/harness",
            copiedFrom: { environmentId: "0199aa00-0000-7000-8000-0000000000aa", environmentName: "laptop" },
          },
        ],
        tools: [{ tool: "bao", version: "2.1.1", minimum: "2.1.1", status: "current" }],
      },
    });
    await openKeyManagers(app);
    const home = await card("Home OpenBao");
    expect(facts(home)).toMatchObject({
      Provider: "OpenBao or Vault",
      Address: "https://bao.home.test:8200",
      "Signs in by": "AppRole, at approle",
      Token: expect.stringMatching(/^approle: default and agent-read; renewable; expires at \d\d:\d\d$/),
      "Run tokens": "It can mint them.",
      "Base path": "None set; it suggests personal/harness.",
      Runs: "They receive its variables: BAO_ADDR, BAO_TOKEN, BAO_CACERT_BYTES, VAULT_ADDR, VAULT_TOKEN, VAULT_CACERT_BYTES.",
      CLI: "OpenBao CLI 2.1.1, at least 2.1.1: current.",
      "Copied from": "laptop, without its credential.",
    });
    expect(facts(home)["Status"]).toMatch(/^Signed in since \d\d:\d\d$/);
    expect(within(home).getByText("Signed in to OpenBao as approle.")).toBeDefined();
    await waitFor(() => expect(app.environment("desk").requests("keyManagers.list").length).toBeGreaterThan(0));
    // The CLI fact is the listed connection's own row (#375, #776): the pane asks no tools.list for it.
    expect(app.environment("desk").requests("tools.list")).toEqual([]);
  });

  it("shows its CLI row from keyManagers.list where the environment does not offer managedTools, and its CLI not installed where none is", async () => {
    const app = await opened({
      capabilities: ["keyManagers"],
      keyManagers: {
        connections: [
          { label: "Home OpenBao", address: "https://bao.home.test:8200" },
          { label: "Team Doppler", address: "https://api.doppler.com", provider: "doppler", method: null, mount: null, username: null, ca: null },
        ],
        tools: [{ tool: "vault", version: "1.18.0", minimum: "1.15.0", status: "current" }],
      },
    });
    await openKeyManagers(app);
    expect(facts(await card("Home OpenBao"))["CLI"]).toBe("Vault CLI 1.18.0, at least 1.15.0: current.");
    expect(facts(await card("Team Doppler"))["CLI"]).toBe("Doppler CLI: not installed: install it.");
  });
});

/** A confirmation dialog, by its name. */
const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

/** Fills inline Add's OpenBao form: label, address and an AppRole's role id and secret id. */
const fillAppRole = async (app: RenderedApp, add: HTMLElement, fields: { readonly label: string; readonly address: string; readonly secretId: string }) => {
  await app.user.clear(within(add).getByRole("textbox", { name: "Label" }));
  await app.user.type(within(add).getByRole("textbox", { name: "Label" }), fields.label);
  await app.user.type(within(add).getByRole("textbox", { name: "Address" }), fields.address);
  await app.user.type(within(add).getByLabelText("Role ID"), "role-for-tests");
  await app.user.type(within(add).getByLabelText("Secret ID"), fields.secretId);
};

describe("Add", () => {
  it("opens Add inline and chooses a provider with named tiles before signing in", async () => {
    const app = await opened();
    const keyManagers = await openKeyManagers(app);
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await within(keyManagers).findByRole("region", { name: "Add a key manager on desk" });
    expect(screen.queryByRole("dialog", { name: "Add a key manager on desk" })).toBeNull();
    expect(document.activeElement).toBe(within(add).getByRole("radio", { name: "OpenBao or Vault" }));
    const provider = within(add).getByRole("radio", { name: "Doppler" });
    await app.user.click(provider);
    expect(provider.getAttribute("aria-checked")).toBe("true");
    expect((within(add).getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("Doppler");
    expect(within(add).getByRole("button", { name: "Add" }).querySelector("svg")).not.toBeNull();
    await app.user.click(within(add).getByRole("button", { name: "Cancel" }));
    expect(within(keyManagers).queryByRole("region", { name: "Add a key manager on desk" })).toBeNull();
    expect(document.activeElement).toBe(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
  });

  it("sends keyManagers.connections.add directly with the form's fields, says a rejected credential in one line, keeps no credential, and adds on an accepted one", async () => {
    const app = await opened({ keyManagers: { rejects: ["secret-rejected-for-tests"] } });
    const keyManagers = await openKeyManagers(app);
    expect(await within(keyManagers).findByText("No key manager is connected here.")).toBeDefined();
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on desk" });
    // OpenBao by AppRole, the mount preset to the method's name and following it until it is typed at.
    expect(within(add).getByRole("radio", { name: "OpenBao or Vault" }).getAttribute("aria-checked")).toBe("true");
    expect((within(add).getByRole("textbox", { name: "Mount" }) as HTMLInputElement).value).toBe("approle");
    await app.user.selectOptions(within(add).getByRole("combobox", { name: "Signs in by" }), "userpass");
    expect((within(add).getByRole("textbox", { name: "Mount" }) as HTMLInputElement).value).toBe("userpass");
    expect(within(add).getByRole("textbox", { name: "Username" })).toBeDefined();
    await app.user.selectOptions(within(add).getByRole("combobox", { name: "Signs in by" }), "approle");
    expect(within(add).queryByRole("textbox", { name: "Username" })).toBeNull();

    await fillAppRole(app, add, { label: "Home OpenBao", address: "https://bao.home.test:8200/", secretId: "secret-rejected-for-tests" });
    await app.user.type(within(add).getByRole("textbox", { name: "Token role (optional)" }), "harness-runs");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: OpenBao did not accept these details. Check them and try again.")).toBeDefined();
    const desk = app.environment("desk");
    expect(desk.requests("keyManagers.connections.add")[0]?.params).toMatchObject({
      provider: "openbao",
      label: "Home OpenBao",
      address: "https://bao.home.test:8200/",
      method: "approle",
      mount: "approle",
      tokenRole: "harness-runs",
      credential: { method: "approle", roleId: "role-for-tests", secretId: "secret-rejected-for-tests" },
    });
    // The secret is not kept: its field is emptied, and nothing the client stores holds it.
    expect((within(add).getByLabelText("Secret ID") as HTMLInputElement).value).toBe("");
    expect(desk.keyManagerConnections()).toEqual([]);

    await app.user.type(within(add).getByLabelText("Secret ID"), "secret-for-tests");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add a key manager on desk" })).toBeNull());
    expect(await within(keyManagers).findByText("Added Home OpenBao: Signed in to OpenBao as approle.")).toBeDefined();
    const home = await card("Home OpenBao");
    expect(facts(home)["Status"]).toMatch(/^Signed in since/);
    const sent = JSON.stringify([app.platform.documents.entries(), app.shell.calls]);
    expect(sent).not.toContain("secret-for-tests");
    expect(sent).not.toContain("secret-rejected-for-tests");
  });

  it("adds another provider by its token alone, which this version's environment answers provider_unavailable in one line", async () => {
    const app = await opened();
    const keyManagers = await openKeyManagers(app);
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on desk" });
    await app.user.click(within(add).getByRole("radio", { name: "Doppler" }));
    expect((within(add).getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("Doppler");
    expect((within(add).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("https://api.doppler.com");
    expect(within(add).queryByRole("combobox", { name: "Signs in by" })).toBeNull();
    await app.user.type(within(add).getByLabelText("Token"), "token-for-tests");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: agent-harness cannot connect to Doppler on this computer yet.")).toBeDefined();
    const params = app.environment("desk").requests("keyManagers.connections.add")[0]?.params ?? {};
    expect(params).toMatchObject({ provider: "doppler", address: "https://api.doppler.com", credential: { method: "token", token: "token-for-tests" } });
    expect(Object.keys(params)).not.toContain("method");
    expect(Object.keys(params)).not.toContain("mount");
  });

  it("asks 1Password for its token alone, never an address: the account URL the token names, learned at sign-in", async () => {
    const app = await opened();
    const keyManagers = await openKeyManagers(app);
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on desk" });
    // An address typed for OpenBao first is not sent once 1Password is chosen.
    await app.user.type(within(add).getByRole("textbox", { name: "Address" }), "https://bao.home.test:8200");
    await app.user.click(within(add).getByRole("radio", { name: "1Password" }));
    expect((within(add).getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("1Password");
    expect(within(add).queryByRole("textbox", { name: "Address" })).toBeNull();
    expect(within(add).getByText("No address: it is the account URL the token names, learned at sign-in.")).toBeDefined();
    await app.user.type(within(add).getByLabelText("Token"), "token-for-tests");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: agent-harness cannot connect to 1Password on this computer yet.")).toBeDefined();
    const params = app.environment("desk").requests("keyManagers.connections.add")[0]?.params ?? {};
    expect(params).toMatchObject({ provider: "onepassword", label: "1Password", credential: { method: "token", token: "token-for-tests" } });
    expect(Object.keys(params)).not.toContain("address");
  });

  it("says a connection the environment holds already in one line", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }] } });
    const keyManagers = await openKeyManagers(app);
    await card("Home OpenBao");
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on desk" });
    await fillAppRole(app, add, { label: "Again", address: "https://bao.home.test:8200", secretId: "secret-for-tests" });
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: A connection to OpenBao at https://bao.home.test:8200 is on this environment already.")).toBeDefined();
  });
});

describe("a certificate the environment does not trust", () => {
  it("shows keyManagers.certificate.preview's anchor, and pins it as the connection's CA only once it is accepted", async () => {
    const address = "https://bao.home.test:8200";
    const app = await opened({ keyManagers: { untrusted: [address] } });
    const keyManagers = await openKeyManagers(app);
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on desk" });
    await fillAppRole(app, add, { label: "Home OpenBao", address, secretId: "secret-for-tests" });
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    const home = await card("Home OpenBao");
    expect(facts(home)["Status"]).toMatch(/^Certificate not trusted since /);
    expect(facts(home)["CA"]).toBe("None pinned: the system's trusted CAs verify it.");
    expect(within(home).getByText(/Check its certificate: trust it if it is your key manager's, and it signs in again\./)).toBeDefined();

    // Looked at and left: nothing is pinned.
    await app.user.click(within(home).getByRole("button", { name: "Check its certificate" }));
    const check = await dialog(`The certificate ${address} presents`);
    const anchor = certificateOf(address);
    expect(facts(check)).toEqual({
      "SHA-256 fingerprint": anchor.sha256Fingerprint,
      Subject: "CN=bao.home.test test CA",
      Names: "bao.home.test",
      Expires: expect.stringMatching(/^24 Sep 2027 \d\d:\d\d$/),
      "Signs itself": "Yes: it is a root CA.",
    });
    await app.user.click(within(check).getByRole("button", { name: "Cancel" }));
    const desk = app.environment("desk");
    expect(desk.requests("keyManagers.connections.update")).toEqual([]);

    await app.user.click(within(home).getByRole("button", { name: "Check its certificate" }));
    await app.user.click(within(await dialog(`The certificate ${address} presents`)).getByRole("button", { name: "Trust this certificate" }));
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))["Status"]).toMatch(/^Signed in since /));
    expect(desk.requests("keyManagers.connections.update")[0]?.params).toMatchObject({ ca: anchor.pem });
    expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))).toMatchObject({
      CA: "Pinned: requests to it trust this CA alone.",
      // Signed in at last, its login suggests a base path as a login at a trusted address does.
      "Base path": "None set; it suggests personal/harness.",
    });
  });
});

describe("the card's verbs", () => {
  it("says what each status asks, and Verify now refreshes the card with what keyManagers.connections.verify found", async () => {
    const status = (kind: KeyManagerStatusKind, message: string): KeyManagerStatus => ({ kind, since: MANUAL_CLOCK_START, message });
    const app = await opened({
      keyManagers: {
        connections: [
          { label: "Down", address: "https://bao-down.test", status: status("unreachable", "OpenBao at https://bao-down.test could not answer (HTTP 500: internal error).") },
          { label: "Sealed", address: "https://bao-sealed.test", status: status("sealed", "OpenBao at https://bao-sealed.test is sealed: unseal it to sign in.") },
          { label: "Old", address: "https://bao-old.test", method: "token", mount: "token", status: status("expired", "The token this connection signed in with expired.") },
          { label: "Refused", address: "https://bao-refused.test", status: status("credential-rejected", "OpenBao at https://bao-refused.test refused the credential.") },
          { label: "Copied", address: "https://bao-copied.test", status: status("awaiting-sign-in", "No credential is on this environment: sign in in Set up, Key manager."), tokenInformation: null },
        ],
      },
    });
    await openKeyManagers(app);
    const advice: Record<string, string> = {
      Down: "Check the address and that the key manager is up and reachable from this environment, then Verify now.",
      Sealed: "Unseal it, then Verify now.",
      Old: "Sign in again with a new token.",
      Refused: "Sign in again with a credential the key manager takes.",
      Copied: "Sign in to give this environment its credential.",
    };
    for (const [label, line] of Object.entries(advice)) expect(within(await card(label)).getByText(line)).toBeDefined();

    const desk = app.environment("desk");
    const down = desk.keyManagerConnections().find((connection) => connection.label === "Down");
    desk.setKeyManagerStatus(down?.id ?? "", { kind: "signed-in", message: "Signed in to OpenBao as approle." });
    await app.user.click(within(await card("Down")).getByRole("button", { name: "Verify now" }));
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "Down" }))["Status"]).toMatch(/^Signed in since /));
    expect(desk.requests("keyManagers.connections.verify")[0]?.params).toEqual({ connectionId: down?.id });
    expect(within(pane()).getByText("Verified Down: Signed in to OpenBao as approle.")).toBeDefined();
  });

  it("signs in again with keyManagers.connections.signIn, sent directly, a refusal said in the form with the secret emptied", async () => {
    const refused: KeyManagerStatus = { kind: "credential-rejected", since: MANUAL_CLOCK_START, message: "OpenBao at https://bao.home.test refused the credential." };
    const app = await opened({ keyManagers: { rejects: ["password-rejected-for-tests"], connections: [{ label: "Home OpenBao", address: "https://bao.home.test", status: refused }] } });
    await openKeyManagers(app);
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Sign in again" }));
    const signIn = await dialog("Sign in to Home OpenBao again");
    expect((within(signIn).getByRole("combobox", { name: "Signs in by" }) as HTMLSelectElement).value).toBe("approle");
    await app.user.selectOptions(within(signIn).getByRole("combobox", { name: "Signs in by" }), "userpass");
    await app.user.type(within(signIn).getByRole("textbox", { name: "Username" }), "david");
    await app.user.type(within(signIn).getByLabelText("Password"), "password-rejected-for-tests");
    await app.user.click(within(signIn).getByRole("button", { name: "Sign in" }));
    expect(await within(signIn).findByText("Not signed in: OpenBao did not accept these details. Check them and try again.")).toBeDefined();
    expect((within(signIn).getByLabelText("Password") as HTMLInputElement).value).toBe("");

    await app.user.type(within(signIn).getByLabelText("Password"), "password-for-tests");
    await app.user.click(within(signIn).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign in to Home OpenBao again" })).toBeNull());
    const home = await card("Home OpenBao");
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))["Status"]).toMatch(/^Signed in since /));
    expect(facts(home)["Signs in by"]).toBe("userpass as david, at userpass");
    expect(app.environment("desk").requests("keyManagers.connections.signIn").at(-1)?.params).toMatchObject({
      credential: { method: "userpass", password: "password-for-tests" },
      mount: "userpass",
      username: "david",
    });
    expect(JSON.stringify([app.platform.documents.entries(), app.shell.calls])).not.toContain("password-for-tests");
  });

  it("edits the label and token role with keyManagers.connections.update, sending only what changed", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test" }] } });
    await openKeyManagers(app);
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Edit" }));
    const edit = await dialog("Edit Home OpenBao");
    expect((within(edit).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("https://bao.home.test");
    await app.user.clear(within(edit).getByRole("textbox", { name: "Label" }));
    await app.user.type(within(edit).getByRole("textbox", { name: "Label" }), "Bao at home");
    await app.user.type(within(edit).getByRole("textbox", { name: "Token role (optional)" }), "harness-runs");
    await app.user.click(within(edit).getByRole("button", { name: "Save" }));
    expect(await card("Bao at home")).toBeDefined();
    const params = app.environment("desk").requests("keyManagers.connections.update")[0]?.params ?? {};
    expect(Object.keys(params).sort()).toEqual(["commandId", "connectionId", "label", "tokenRole"]);
    expect(params).toMatchObject({ label: "Bao at home", tokenRole: "harness-runs" });
  });

  it("offers no address in a 1Password connection's Edit, the account URL its token names", async () => {
    const onePassword = { label: "Team 1Password", provider: "onepassword", address: "https://my.1password.com", ca: null, method: null, mount: null, username: null } as const;
    const app = await opened({ keyManagers: { connections: [onePassword] } });
    await openKeyManagers(app);
    await app.user.click(within(await card("Team 1Password")).getByRole("button", { name: "Edit" }));
    const edit = await dialog("Edit Team 1Password");
    expect(within(edit).queryByRole("textbox", { name: "Address" })).toBeNull();
    await app.user.clear(within(edit).getByRole("textbox", { name: "Label" }));
    await app.user.type(within(edit).getByRole("textbox", { name: "Label" }), "Our 1Password");
    await app.user.click(within(edit).getByRole("button", { name: "Save" }));
    expect(await card("Our 1Password")).toBeDefined();
    const params = app.environment("desk").requests("keyManagers.connections.update")[0]?.params ?? {};
    expect(Object.keys(params).sort()).toEqual(["commandId", "connectionId", "label"]);
  });

  it("signs out and removes, each only once it is confirmed", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test" }] } });
    await openKeyManagers(app);
    const desk = app.environment("desk");
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Sign out" }));
    const signOut = await dialog("Sign out of Home OpenBao?");
    await app.user.click(within(signOut).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("keyManagers.connections.signOut")).toEqual([]);
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Sign out" }));
    await app.user.click(within(await dialog("Sign out of Home OpenBao?")).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))["Status"]).toMatch(/^Awaiting a sign-in since /));
    // What the login was known by goes with it.
    expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))).toMatchObject({ "Run tokens": "Not known until it is verified." });
    expect(within(within(pane()).getByRole("region", { name: "Home OpenBao" })).queryByRole("group", { name: "Policies runs receive" })).toBeNull();

    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Remove" }));
    const remove = await dialog("Remove Home OpenBao?");
    await app.user.click(within(remove).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("keyManagers.connections.remove")).toEqual([]);
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Remove" }));
    await app.user.click(within(await dialog("Remove Home OpenBao?")).getByRole("button", { name: "Remove" }));
    expect(await within(pane()).findByText("No key manager is connected here.")).toBeDefined();
    expect(desk.keyManagerConnections()).toEqual([]);
  });

  it("takes no press of Verify now or Inject its variables while either is on its way, nor a second press of Remove", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Work OpenBao", address: "https://bao.work.test", injects: false, injectedVariables: [] }] } });
    await openKeyManagers(app);
    const desk = app.environment("desk");
    // The environment answers neither, as on a slow link.
    for (const method of ["keyManagers.connections.verify", "keyManagers.connections.remove"]) desk.wire.answer(method, () => new Promise(() => undefined));
    const work = await card("Work OpenBao");
    await app.user.click(within(work).getByRole("button", { name: "Verify now" }));
    // The card's one-line verbs wait for the one on its way.
    for (const name of ["Verify now", "Inject its variables"]) {
      await waitFor(() => expect(within(work).getByRole("button", { name }).hasAttribute("disabled")).toBe(true));
      await app.user.click(within(work).getByRole("button", { name }));
    }
    await app.user.click(within(work).getByRole("button", { name: "Remove" }));
    const remove = await dialog("Remove Work OpenBao?");
    await app.user.click(within(remove).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(remove).getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true));
    await app.user.click(within(remove).getByRole("button", { name: "Remove" }));
    expect(desk.requests("keyManagers.connections.verify")).toHaveLength(1);
    expect(desk.requests("keyManagers.connections.setInjected")).toEqual([]);
    expect(desk.requests("keyManagers.connections.remove")).toHaveLength(1);
  });
});

describe("policies and injection", () => {
  it("shows the login's policies with their write flags, ticks them with keyManagers.connections.setPolicies, and warns on a ticked one that writes or may", async () => {
    const app = await opened({
      keyManagers: {
        policies: [
          { name: "default", writes: "no" },
          { name: "agent-read", writes: "no" },
          { name: "agent-write", writes: "yes" },
          { name: "team-secrets", writes: "possibly" },
        ],
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test", ticks: ["default", "agent-read"] }],
      },
    });
    await openKeyManagers(app);
    const home = await card("Home OpenBao");
    const ticks = within(home).getByRole("group", { name: "Policies runs receive" });
    const ticked = () =>
      within(within(pane()).getByRole("group", { name: "Policies runs receive" }))
        .getAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked)
        .map((box) => box.getAttribute("name"));
    expect(ticked()).toEqual(["default", "agent-read"]);
    const WRITES = "Runs given this policy can write to your key manager: untick it to keep them read-only.";
    const MAY = "This login cannot read this policy, so runs given it may be able to write: untick it to keep them read-only.";
    // Unticked, a writing policy carries no warning.
    expect(within(ticks).queryByText(WRITES)).toBeNull();

    await app.user.click(within(ticks).getByRole("checkbox", { name: /^agent-write/ }));
    await waitFor(() => expect(ticked()).toEqual(["default", "agent-read", "agent-write"]));
    expect(app.environment("desk").requests("keyManagers.connections.setPolicies")[0]?.params).toMatchObject({ ticks: ["default", "agent-read", "agent-write"] });
    expect(within(pane()).getByText(WRITES)).toBeDefined();

    await app.user.click(within(within(pane()).getByRole("group", { name: "Policies runs receive" })).getByRole("checkbox", { name: /^team-secrets/ }));
    await waitFor(() => expect(ticked()).toEqual(["default", "agent-read", "agent-write", "team-secrets"]));
    expect(within(pane()).getByText(MAY)).toBeDefined();

    await app.user.click(within(within(pane()).getByRole("group", { name: "Policies runs receive" })).getByRole("checkbox", { name: /^agent-write/ }));
    await waitFor(() => expect(ticked()).toEqual(["default", "agent-read", "team-secrets"]));
    expect(within(pane()).queryByText(WRITES)).toBeNull();
  });

  it("keeps both of two ticks made one straight after the other, the second sent over the first", async () => {
    const app = await opened({
      keyManagers: {
        policies: [
          { name: "default", writes: "no" },
          { name: "agent-read", writes: "no" },
          { name: "team-read", writes: "no" },
        ],
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test", ticks: ["default"] }],
      },
    });
    await openKeyManagers(app);
    const ticks = within(await card("Home OpenBao")).getByRole("group", { name: "Policies runs receive" });
    const desk = app.environment("desk");
    // The list is read again only after both ticks are made, as on a slow link.
    const release = desk.holdKeyManagerLists();
    await app.user.click(within(ticks).getByRole("checkbox", { name: /^agent-read/ }));
    await waitFor(() => expect(desk.requests("keyManagers.connections.setPolicies")).toHaveLength(1));
    await waitFor(() => expect(desk.keyManagerConnections()[0]?.ticks).toEqual(["default", "agent-read"]));
    await app.user.click(within(ticks).getByRole("checkbox", { name: /^team-read/ }));
    await waitFor(() => expect(desk.requests("keyManagers.connections.setPolicies")).toHaveLength(2));
    release();
    await waitFor(() => expect(desk.keyManagerConnections()[0]?.ticks).toEqual(["default", "agent-read", "team-read"]));
    await waitFor(() =>
      expect(
        within(within(pane()).getByRole("group", { name: "Policies runs receive" }))
          .getAllByRole("checkbox")
          .filter((box) => (box as HTMLInputElement).checked)
          .map((box) => box.getAttribute("name")),
      ).toEqual(["default", "agent-read", "team-read"]),
    );
    expect(desk.requests("keyManagers.connections.setPolicies").map((request) => request.params["ticks"])).toEqual([
      ["default", "agent-read"],
      ["default", "agent-read", "team-read"],
    ]);
  });

  it("chooses which connection of a provider injects with keyManagers.connections.setInjected", async () => {
    const app = await opened({
      keyManagers: {
        connections: [
          { label: "Home OpenBao", address: "https://bao.home.test" },
          { label: "Work OpenBao", address: "https://bao.work.test", injects: false, injectedVariables: [] },
        ],
      },
    });
    await openKeyManagers(app);
    expect(within(await card("Home OpenBao")).queryByRole("button", { name: "Inject its variables" })).toBeNull();
    const work = await card("Work OpenBao");
    expect(facts(work)["Runs"]).toBe("They do not receive its variables: it serves the harness's references only.");
    await app.user.click(within(work).getByRole("button", { name: "Inject its variables" }));
    await waitFor(() => expect(facts(within(pane()).getByRole("region", { name: "Work OpenBao" }))["Runs"]).toMatch(/^They receive its variables: BAO_ADDR/));
    expect(facts(within(pane()).getByRole("region", { name: "Home OpenBao" }))["Runs"]).toBe("They do not receive its variables: it serves the harness's references only.");
    expect(app.environment("desk").requests("keyManagers.connections.setInjected")).toHaveLength(1);
  });
});

/** The Move card. */
const moveCard = () => within(pane()).findByRole("region", { name: "Move stored tokens" });

/** A stored token's row on the Move card, by what people know it by. */
const item = async (name: string) => within(await moveCard()).findByRole("listitem", { name });

/** The lines the last Move said, one per item. */
const moved = async () =>
  within(await within(await moveCard()).findByRole("list", { name: "What the Move did" }))
    .getAllByRole("listitem")
    .map((line) => line.textContent);

describe("the Move card", () => {
  it("sets the base path the suggestion presets, then Move all answers one line per item, and a target holding another value offers overwrite", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test", basePath: null, suggestedBasePath: "personal/harness" }],
        items: [
          { name: "https://github.com", slug: "github" },
          { name: "https://git.home.test", slug: "forgejo" },
        ],
        values: { "personal/harness/forge-github": "another-value-for-tests" },
      },
    });
    await openKeyManagers(app);
    const move = await moveCard();
    expect(within(move).getByText("Suggested: personal/harness.")).toBeDefined();
    expect(within(await item("https://github.com")).getByText("Set a base path to see where it goes.")).toBeDefined();
    expect(within(move).queryByRole("button", { name: "Move all" })).toBeNull();
    const base = within(move).getByRole("textbox", { name: "Base path" }) as HTMLInputElement;
    expect(base.value).toBe("personal/harness");
    await app.user.click(within(move).getByRole("button", { name: "Set the base path" }));
    const desk = app.environment("desk");
    await waitFor(() => expect(within(pane()).queryByText("Suggested: personal/harness.")).toBeNull());
    expect(desk.requests("keyManagers.connections.setBasePath")[0]?.params).toMatchObject({ basePath: "personal/harness" });
    expect(await within(await item("https://github.com")).findByText("To personal/harness/forge-github (key token)")).toBeDefined();
    expect(within(await item("https://git.home.test")).getByText("To personal/harness/forge-forgejo (key token)")).toBeDefined();

    await app.user.click(within(await moveCard()).getByRole("button", { name: "Move all" }));
    await waitFor(async () => expect(await moved()).toHaveLength(2));
    expect(await moved()).toEqual([
      "https://github.com: A different value is at OpenBao at personal/harness/forge-github (key token) already: nothing was written, and the forge account https://github.com keeps its stored token. Move it with overwrite to replace that value.",
      "https://git.home.test: Moved to OpenBao at personal/harness/forge-forgejo (key token); the stored token was deleted.",
    ]);
    expect(desk.requests("keyManagers.move")[0]?.params).toMatchObject({ items: "all" });
    await waitFor(async () => expect(within(await moveCard()).queryByRole("listitem", { name: "https://git.home.test" })).toBeNull());

    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Overwrite" }));
    await waitFor(async () => expect(await moved()).toEqual(["https://github.com: Moved to OpenBao at personal/harness/forge-github (key token); the stored token was deleted."]));
    expect(desk.requests("keyManagers.move")[1]?.params).toMatchObject({ items: [{ kind: "forge-account" }], overwrite: true });
    expect(desk.keyManagerValue("personal/harness/forge-github")).toBe("stored-token-for-tests-github");
    expect(await within(await moveCard()).findByText("No stored token is left to move here.")).toBeDefined();
  });

  it("starts afresh on the connection it goes into when another comes to inject, keeping nothing typed for the one before", async () => {
    const app = await opened({
      keyManagers: {
        connections: [
          { label: "Home OpenBao", address: "https://bao.home.test", basePath: null },
          { label: "Work OpenBao", address: "https://bao.work.test", basePath: null, injects: false, injectedVariables: [] },
        ],
        items: [{ name: "https://github.com", slug: "github" }],
      },
    });
    await openKeyManagers(app);
    const base = async () => within(await moveCard()).getByRole("textbox", { name: "Base path" }) as HTMLInputElement;
    await app.user.clear(await base());
    await app.user.type(await base(), "team/harness");
    expect((within(await moveCard()).getByRole("combobox", { name: "Move into" }) as HTMLSelectElement).value).toBe(
      app.environment("desk").keyManagerConnections()[0]?.id,
    );
    await app.user.click(within(await card("Work OpenBao")).getByRole("button", { name: "Inject its variables" }));
    const work = app.environment("desk").keyManagerConnections()[1]?.id;
    await waitFor(async () => expect((within(await moveCard()).getByRole("combobox", { name: "Move into" }) as HTMLSelectElement).value).toBe(work));
    expect((await base()).value).toBe("personal/harness");
  });

  it("goes back to its preset when the connection chosen to move into is removed, and starts afresh when the base path changes", async () => {
    const app = await opened({
      keyManagers: {
        connections: [
          { label: "Home OpenBao", address: "https://bao.home.test", basePath: "personal/harness" },
          { label: "Work OpenBao", address: "https://bao.work.test", basePath: null, injects: false, injectedVariables: [] },
        ],
        items: [{ name: "https://github.com", slug: "github" }],
        values: { "personal/harness/forge-github": "another-value-for-tests" },
      },
    });
    await openKeyManagers(app);
    const desk = app.environment("desk");
    const [home, work] = desk.keyManagerConnections();
    await app.user.selectOptions(within(await moveCard()).getByRole("combobox", { name: "Move into" }), work?.id ?? "");
    await app.user.click(within(await card("Work OpenBao")).getByRole("button", { name: "Remove" }));
    await app.user.click(within(await dialog("Remove Work OpenBao?")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(pane()).queryByRole("region", { name: "Work OpenBao" })).toBeNull());
    // Home is the one left, and the card goes into it.
    expect((within(await moveCard()).getByRole("textbox", { name: "Base path" }) as HTMLInputElement).value).toBe("personal/harness");

    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Move" }));
    expect(await within(await item("https://github.com")).findByRole("button", { name: "Overwrite" })).toBeDefined();
    const base = within(await moveCard()).getByRole("textbox", { name: "Base path" });
    await app.user.clear(base);
    await app.user.type(base, "team/harness");
    // While the edit is not set, a Move would go to the base path set: it waits.
    expect(within(await item("https://github.com")).getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
    expect(within(await moveCard()).getByRole("button", { name: "Move all" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(await moveCard()).getByRole("button", { name: "Set the base path" }));
    await waitFor(() => expect(desk.keyManagerConnections().find((each) => each.id === home?.id)?.basePath).toBe("team/harness"));
    // The Overwrite was offered for the old target: it goes with it.
    await waitFor(async () => expect(within(await item("https://github.com")).queryByRole("button", { name: "Overwrite" })).toBeNull());
    expect(within(await item("https://github.com")).getByText("To team/harness/forge-github (key token)")).toBeDefined();
  });

  it("holds Set the base path while a Move is on its way, so the Move's answer is not dropped", async () => {
    const app = await opened({
      keyManagers: {
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test", basePath: "personal/harness" }],
        items: [{ name: "https://github.com", slug: "github" }],
      },
    });
    await openKeyManagers(app);
    const desk = app.environment("desk");
    // The environment does not answer the Move, as on a slow link.
    desk.wire.answer("keyManagers.move", () => new Promise(() => undefined));
    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(desk.requests("keyManagers.move")).toHaveLength(1));
    const base = within(await moveCard()).getByRole("textbox", { name: "Base path" });
    await app.user.clear(base);
    await app.user.type(base, "team/harness");
    expect(within(await moveCard()).getByRole("button", { name: "Set the base path" }).hasAttribute("disabled")).toBe(true);
    await app.user.click(within(await moveCard()).getByRole("button", { name: "Set the base path" }));
    expect(desk.requests("keyManagers.connections.setBasePath")).toEqual([]);
  });

  it("offers Copy value, sent directly, where the login cannot write: the value shows once, and a verify-only Move says a missing or different paste, then finishes the swap", async () => {
    const app = await opened({
      keyManagers: {
        writable: false,
        connections: [{ label: "Home OpenBao", address: "https://bao.home.test", basePath: "personal/harness" }],
        items: [{ name: "https://github.com", slug: "github" }],
      },
    });
    await openKeyManagers(app);
    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Move" }));
    await waitFor(async () => expect((await moved())[0]).toMatch(/^https:\/\/github\.com: The login of Home OpenBao may not write OpenBao at personal\/harness\/forge-github \(key token\)/));
    const desk = app.environment("desk");

    await app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Copy value" }));
    const copy = await dialog("Paste this value into Home OpenBao");
    expect(within(copy).getByText("At personal/harness/forge-github (key token)")).toBeDefined();
    expect((within(copy).getByRole("textbox", { name: "The stored token" }) as HTMLInputElement).value).toBe("stored-token-for-tests-github");
    expect(desk.requests("keyManagers.move.copyValue")).toHaveLength(1);
    await app.user.click(within(copy).getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue("stored-token-for-tests-github")).toBeNull();
    expect(JSON.stringify(app.platform.documents.entries())).not.toContain("stored-token-for-tests-github");
    // Copied once: the value is not offered again.
    expect(within(await item("https://github.com")).queryByRole("button", { name: "Copy value" })).toBeNull();

    const verify = async () => app.user.click(within(await item("https://github.com")).getByRole("button", { name: "Verify the paste" }));
    await verify();
    await waitFor(async () => expect((await moved())[0]).toMatch(/Nothing is pasted at OpenBao at personal\/harness\/forge-github \(key token\) yet: paste the value there, then verify it again\./));
    desk.pasteKeyManagerValue("personal/harness/forge-github", "a-wrong-paste-for-tests");
    await verify();
    await waitFor(async () => expect((await moved())[0]).toMatch(/holds another value than the stored token of the forge account https:\/\/github\.com/));
    desk.pasteKeyManagerValue("personal/harness/forge-github", "stored-token-for-tests-github");
    await verify();
    await waitFor(async () =>
      expect(await moved()).toEqual(["https://github.com: Verified the value pasted at OpenBao at personal/harness/forge-github (key token) and moved to it; the stored token was deleted."]),
    );
    expect(desk.requests("keyManagers.move").at(-1)?.params).toMatchObject({ verifyOnly: true });
  });
});

describe("the injection setting", () => {
  it("edits credentials.injection and each account's override in credentials.injectionByAccount through settings.update", async () => {
    const app = await opened({
      accounts: [
        { id: "account-1", label: "work" },
        { id: "account-2", label: "personal" },
      ],
      settings: { "credentials.injection": "allow", "credentials.injectionByAccount": { "account-2": "deny" } },
    });
    const keyManagers = await openKeyManagers(app);
    const injection = within(keyManagers).getByRole("region", { name: "Injection" });
    const choice = (name: string) => within(injection).getByRole("combobox", { name }) as HTMLSelectElement;
    await waitFor(() => expect(choice("Runs on desk").value).toBe("allow"));
    await waitFor(() => expect(choice("Runs on work").value).toBe("inherit"));
    expect(choice("Runs on personal").value).toBe("deny");
    expect(within(choice("Runs on work")).getByRole("option", { selected: true }).textContent).toBe("As the environment: receive credentials");

    const desk = app.environment("desk");
    await app.user.selectOptions(choice("Runs on work"), "deny");
    await waitFor(() => expect(desk.settings()["credentials.injectionByAccount"]).toEqual({ "account-1": "deny", "account-2": "deny" }));
    await app.user.selectOptions(choice("Runs on personal"), "inherit");
    await waitFor(() => expect(desk.settings()["credentials.injectionByAccount"]).toEqual({ "account-1": "deny" }));
    await app.user.selectOptions(choice("Runs on desk"), "deny");
    await waitFor(() => expect(desk.settings()["credentials.injection"]).toBe("deny"));
    await waitFor(() => expect(within(choice("Runs on personal")).getByRole("option", { selected: true }).textContent).toBe("As the environment: receive none"));
    expect(desk.requests("settings.update").map((request) => Object.keys(request.params["values"] as object))).toEqual([
      ["credentials.injectionByAccount"],
      ["credentials.injectionByAccount"],
      ["credentials.injection"],
    ]);
  });
});

describe("copies to other environments", () => {
  it("offers the environments this client holds an admin connection to, and copies the connection there without its credential, one line each", async () => {
    const connection = { label: "Home OpenBao", address: "https://bao.home.test", basePath: "personal/harness" } as const;
    const app = await opened({ keyManagers: { connections: [connection] } }, [
      { name: "laptop", reach: "paired", capabilities: [...FLAGGED] },
      { name: "tablet", reach: "paired", capabilities: [...FLAGGED], keyManagers: { connections: [{ label: "Tablet's", address: connection.address }] } },
      { name: "phone", reach: "paired", capabilities: [...FLAGGED], scopes: ["read", "sessions:write", "runs:drive", "terminal"] },
    ]);
    await openKeyManagers(app);
    await app.user.click(within(await card("Home OpenBao")).getByRole("button", { name: "Copy to other environments" }));
    const copy = await dialog("Copy Home OpenBao to other environments");
    expect(within(copy).getAllByRole("checkbox").map((box) => box.getAttribute("name"))).toEqual(["laptop", "tablet"]);
    expect(within(copy).getByText(/without its credential/)).toBeDefined();
    await app.user.click(within(copy).getByRole("checkbox", { name: "laptop" }));
    await app.user.click(within(copy).getByRole("checkbox", { name: "tablet" }));
    await app.user.click(within(copy).getByRole("button", { name: "Copy" }));
    expect(await within(copy).findByText("laptop: copied, awaiting a sign-in there.")).toBeDefined();
    expect(within(copy).getByText(`tablet: not copied: A connection to OpenBao at ${connection.address} is on this environment already.`)).toBeDefined();

    const laptop = app.environment("laptop");
    const [copied] = laptop.keyManagerConnections();
    expect(copied).toMatchObject({ label: "Home OpenBao", address: connection.address, basePath: "personal/harness", status: { kind: "awaiting-sign-in" } });
    expect(copied?.copiedFrom).toMatchObject({ environmentName: "desk" });
    expect(laptop.requests("keyManagers.connections.add")[0]?.params).not.toHaveProperty("credential");
    expect(app.environment("phone").requests("keyManagers.connections.add")).toEqual([]);
  });
});

describe("the row's reach", () => {
  it("opens from a connection's status notice, on that notice's environment", async () => {
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: [...FLAGGED], keyManagers: { connections: [{ label: "Laptop OpenBao", address: "https://bao.laptop.test" }] } }]);
    const laptop = app.environment("laptop");
    const [connection] = laptop.keyManagerConnections();
    // The window has heard the connection's status once, as its notices do, before the verification that changes it.
    await waitFor(() => expect(laptop.requests("environment.subscribe").length).toBeGreaterThan(0));
    laptop.setKeyManagerStatus(connection?.id ?? "", { kind: "sealed", message: "OpenBao at https://bao.laptop.test is sealed: unseal it to sign in." });
    laptop.verifyKeyManager(connection?.id ?? "");
    const notices = await screen.findByRole("region", { name: /^Notifications/ });
    const toast = await within(notices).findByRole("listitem");
    expect(toast.textContent).toContain("Laptop OpenBao on laptop: OpenBao at https://bao.laptop.test is sealed: unseal it to sign in.");
    await app.user.click(within(toast).getByRole("button", { name: "Open Key managers" }));
    const keyManagers = pane();
    expect(within(within(keyManagers).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent).toBe("laptop");
    expect(facts(await card("Laptop OpenBao"))["Status"]).toMatch(/^Sealed since /);
    expect(screen.queryByRole("region", { name: /^Notifications/ })).toBeNull();
  });

  it("is absent with its reason without the keyManagers flag, and read-only with the capability's line without admin", async () => {
    const app = await opened({ capabilities: [] }, [
      { name: "laptop", reach: "paired", capabilities: [...FLAGGED], scopes: ["read", "sessions:write", "runs:drive", "terminal"], keyManagers: { connections: [{ label: "Laptop OpenBao", address: "https://bao.laptop.test" }], items: [{ name: "https://github.com", slug: "github" }] } },
    ]);
    const desk = await openKeyManagers(app);
    expect(within(desk).getByText("desk runs an older agent-harness without this. Update desk to use it.")).toBeDefined();
    expect(within(desk).queryByRole("button", { name: "Add a key manager" })).toBeNull();

    const laptop = await openKeyManagers(app, "laptop");
    expect(await within(laptop).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    const bao = await card("Laptop OpenBao");
    for (const name of ["Sign in again", "Verify now", "Edit", "Sign out", "Remove"]) expect(within(bao).getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    expect(within(laptop).getByRole("button", { name: "Add a key manager" }).hasAttribute("disabled")).toBe(true);
    for (const box of within(bao).getAllByRole("checkbox")) expect(box.hasAttribute("disabled")).toBe(true);
    expect(within(await item("https://github.com")).getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
  });

  it("fails a direct send at once while the environment cannot be reached, holding nothing to send later", async () => {
    const app = await opened({}, [{ name: "laptop", reach: "paired", capabilities: [...FLAGGED], keyManagers: { connections: [{ label: "Laptop OpenBao", address: "https://bao.laptop.test" }] } }]);
    const keyManagers = await openKeyManagers(app, "laptop");
    await card("Laptop OpenBao");
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await screen.findByRole("region", { name: "Add a key manager on laptop" });
    await fillAppRole(app, add, { label: "Work OpenBao", address: "https://bao.work.test", secretId: "secret-for-tests" });

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await waitFor(() => expect(app.runtime.projections.environments.read().find((view) => view.name === "laptop")?.unreachableSince).not.toBeNull());
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText(/^Not added: /)).toBeDefined();
    await app.user.click(within(add).getByRole("button", { name: "Cancel" }));
    // The cached connections stay, read-only, with since when.
    expect(within(pane()).getByText(/^Unreachable since \d\d:\d\d: its key managers as this window last read them, read-only\.$/)).toBeDefined();
    expect(within(pane()).getByRole("region", { name: "Laptop OpenBao" })).toBeDefined();

    // Back again, as the backoff reaches it: nothing was held for it.
    laptop.discovery("ready");
    await waitFor(async () => {
      await act(async () => app.clock.advance(5_000));
      expect(app.runtime.projections.environments.read().find((view) => view.name === "laptop")?.phase).toBe("ready");
    });
    expect(laptop.requests("keyManagers.connections.add")).toEqual([]);
  });
});
