import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Key managers row (docs/specs/gui.md, "Settings"; key-managers spec,
 * "Wire methods", "Move stored tokens" and "Injection"; ADR 0011, ADR 0028;
 * #425): a card per connection from the cached `keyManagers.list`, Add with
 * the certificate preview, the card's sign-in, edit, sign-out, removal,
 * verification, policy ticks and injection, the Move card, the injection
 * setting and copies to other environments, driven through the harness over
 * the scripted environment's key-manager answers.
 */

/** Both flags the row reads: its connections and the CLI rows. */
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
  await app.user.keyboard("{Control>},{/Control}");
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
  });
});

/** The dialog open, by its name. */
const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

/** Fills the Add dialog's OpenBao form: label, address and an AppRole's role id and secret id. */
const fillAppRole = async (app: RenderedApp, add: HTMLElement, fields: { readonly label: string; readonly address: string; readonly secretId: string }) => {
  await app.user.clear(within(add).getByRole("textbox", { name: "Label" }));
  await app.user.type(within(add).getByRole("textbox", { name: "Label" }), fields.label);
  await app.user.type(within(add).getByRole("textbox", { name: "Address" }), fields.address);
  await app.user.type(within(add).getByLabelText("Role ID"), "role-for-tests");
  await app.user.type(within(add).getByLabelText("Secret ID"), fields.secretId);
};

describe("Add", () => {
  it("sends keyManagers.connections.add directly with the form's fields, says a rejected credential in one line, keeps no credential, and adds on an accepted one", async () => {
    const app = await opened({ keyManagers: { rejects: ["secret-rejected-for-tests"] } });
    const keyManagers = await openKeyManagers(app);
    expect(await within(keyManagers).findByText("No key manager is connected here.")).toBeDefined();
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await dialog("Add a key manager on desk");
    // OpenBao by AppRole, the mount preset to the method's name and following it until it is typed at.
    expect((within(add).getByRole("combobox", { name: "Provider" }) as HTMLSelectElement).value).toBe("openbao");
    expect((within(add).getByRole("textbox", { name: "Mount" }) as HTMLInputElement).value).toBe("approle");
    await app.user.selectOptions(within(add).getByRole("combobox", { name: "Signs in by" }), "userpass");
    expect((within(add).getByRole("textbox", { name: "Mount" }) as HTMLInputElement).value).toBe("userpass");
    expect(within(add).getByRole("textbox", { name: "Username" })).toBeDefined();
    await app.user.selectOptions(within(add).getByRole("combobox", { name: "Signs in by" }), "approle");
    expect(within(add).queryByRole("textbox", { name: "Username" })).toBeNull();

    await fillAppRole(app, add, { label: "Home OpenBao", address: "https://bao.home.test:8200/", secretId: "secret-rejected-for-tests" });
    await app.user.type(within(add).getByRole("textbox", { name: "Token role (optional)" }), "harness-runs");
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(
      await within(add).findByText("Not added: OpenBao at https://bao.home.test:8200 refused the credential (HTTP 400: invalid role or secret ID). Nothing was stored."),
    ).toBeDefined();
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
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a key manager on desk" })).toBeNull());
    expect(await within(keyManagers).findByText("Added Home OpenBao: Signed in to OpenBao as approle.")).toBeDefined();
    const home = await card("Home OpenBao");
    expect(facts(home)["Status"]).toMatch(/^Signed in since/);
    const sent = JSON.stringify([app.platform.documents.entries(), app.shell.calls]);
    expect(sent).not.toContain("secret-for-tests");
    expect(sent).not.toContain("secret-rejected-for-tests");
  });

  it("says a connection the environment holds already in one line", async () => {
    const app = await opened({ keyManagers: { connections: [{ label: "Home OpenBao", address: "https://bao.home.test:8200" }] } });
    const keyManagers = await openKeyManagers(app);
    await card("Home OpenBao");
    await app.user.click(within(keyManagers).getByRole("button", { name: "Add a key manager" }));
    const add = await dialog("Add a key manager on desk");
    await fillAppRole(app, add, { label: "Again", address: "https://bao.home.test:8200", secretId: "secret-for-tests" });
    await app.user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("Not added: A connection to OpenBao at https://bao.home.test:8200 is on this environment already.")).toBeDefined();
  });
});
