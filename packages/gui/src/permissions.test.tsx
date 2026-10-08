import { screen, waitFor, within } from "@testing-library/react";
import { SETTINGS, type SettingsKey, BYPASS_SENTENCE, denylistPresets, type ContainmentReport } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Permissions row, `access.permissions` (docs/specs/gui.md, "Settings";
 * the permissions spec; ADR 0006, ADR 0027; #415): the permission settings
 * through `permissions.settings.*`, the containment default with each
 * level's availability, the denylist's four sections with test and restore,
 * and the Unattended review. Driven through the harness over two scripted
 * environments: `desk`, this machine's, and `laptop`, paired.
 */

/** The window with its two environments ready and no session open, each as `given` scripts it. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given.desk }, { name: "laptop", reach: "paired", ...given.laptop }] });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** A row's pane, by its label. */
const pane = (label: string) => within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: label });

/** Opens Settings on Permissions with Mod+, and the rail, as a person does, the picker on `environment` when it is given. */
const openPermissions = async (app: RenderedApp, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Permissions" }));
  if (environment !== undefined) await app.user.selectOptions(within(pane("Permissions")).getByRole("combobox", { name: "Environment" }), environment);
  return pane("Permissions");
};

/** A key's group, by the key. */
const field = (region: HTMLElement, key: SettingsKey) => within(region).getByRole("group", { name: SETTINGS[key].label });

/** What `laptop`'s probe finds: bubblewrap missing, so neither workspace level can be enforced. */
const NO_BUBBLEWRAP: Partial<ContainmentReport> = {
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: false, reason: "bwrap is not on PATH: install bubblewrap.", cause: "binary_missing" },
    { level: "workspace-no-network", available: false, reason: "bwrap is not on PATH: install bubblewrap.", cause: "binary_missing" },
  ],
  mechanism: null,
};

/** The presets the scripted environments seed their denylists with. */
const PRESETS = denylistPresets("/home/milo/.agent-harness");

/** The Denylist part of the pane. */
const denylistOf = (region: HTMLElement) => within(region).getByRole("region", { name: "Denylist" });

/** A section of the denylist, by its name, once it is read. */
const section = (region: HTMLElement, name: string) => within(denylistOf(region)).findByRole("region", { name });

/** A section's entries, each as its pattern, whether it is enabled, and what else it says. */
const entries = (region: HTMLElement) =>
  within(within(region).getByRole("list", { name: "Entries" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

/** The containment default's levels, each as its radio is named and described, and whether it is chosen. */
const levels = (region: HTMLElement) =>
  within(within(region).getByRole("radiogroup", { name: "Default process containment" }))
    .getAllByRole("radio")
    .map((radio) => {
      const input = radio as HTMLInputElement;
      return [input.labels?.[0]?.textContent ?? "", input.checked];
    });

describe("the permission settings", () => {
  it("labels mode choices with readable titles above their keys and retains descriptions in both settings", async () => {
    const app = await opened();
    const permissions = await openPermissions(app);
    const choices = [
      ["plan", "Plan only", "Plan without changing files."],
      ["acceptEdits", "Accept file edits", "Accept file edits; ask before other actions when the provider supports it."],
      ["auto", "Automatic review", "Let the provider review actions automatically where supported."],
      ["bypassPermissions", "Bypass permissions", "Run without permission checks. The denylist still applies."],
    ] as const;
    for (const key of ["permissions.defaultCeiling", "permissions.unattended.mode"] as const) {
      const group = await within(field(permissions, key)).findByRole("radiogroup");
      const supported = key === "permissions.defaultCeiling" ? choices : choices.filter(([mode]) => mode === "acceptEdits" || mode === "bypassPermissions");
      expect(within(group).getAllByRole("radio")).toHaveLength(supported.length);
      for (const [mode, title, note] of supported) {
        const radio = within(group).getByRole("radio", { name: title });
        const row = radio.closest("label")!;
        const titleNode = within(row).getByText(title);
        const keyNode = within(row).getByText(mode);
        expect(titleNode.compareDocumentPosition(keyNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(keyNode.className).toContain("font-mono");
        expect(keyNode.className).toContain("text-2xs");
        expect(document.getElementById(radio.getAttribute("aria-describedby") ?? "")?.textContent).toBe(note);
        if (mode === "bypassPermissions") expect(row.className).toContain("text-signal");
      }
    }
  });

  it("edits the default ceiling, the unattended mode and the parked-prompt TTL, a duration or never, through permissions.settings.set", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);

    const ceiling = await within(field(permissions, "permissions.defaultCeiling")).findByRole("radiogroup");
    expect(within(ceiling).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Plan only", "Accept file edits", "Automatic review", "Bypass permissions"]);
    expect(within(ceiling).getByText("Plan without changing files.")).toBeDefined();
    await app.user.click(within(ceiling).getByRole("radio", { name: "Plan only" }));
    await waitFor(() => expect(desk.settings()["permissions.defaultCeiling"]).toBe("plan"));

    const ttl = () => within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("textbox") as HTMLInputElement;
    const typeTtl = async (typed: string) => {
      await app.user.clear(ttl());
      await app.user.type(ttl(), typed);
      await app.user.click(within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("button", { name: "Save" }));
    };
    expect(ttl().value).toBe("24 hours");
    await typeTtl("2 days");
    await waitFor(() => expect(ttl().value).toBe("2 days"));
    await typeTtl("never");
    await waitFor(() => expect(ttl().value).toBe("never"));
    expect(desk.settings()["permissions.parkedPrompt.ttl"]).toBe("never");
    expect(desk.requests("permissions.settings.set").map((request) => request.params["values"])).toEqual([
      { "permissions.defaultCeiling": "plan" },
      { "permissions.parkedPrompt.ttl": { amount: 2, unit: "days" } },
      { "permissions.parkedPrompt.ttl": "never" },
    ]);
    expect(desk.requests("settings.update")).toEqual([]);
  });

  it("shows the one sentence before bypassPermissions becomes the unattended mode, sends the acknowledgement with it, and shows its time read-only", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const acknowledged = field(permissions, "permissions.unattended.bypassAcknowledgedAt");
    expect(within(acknowledged).getByText("The environment records it itself; nothing sets it.")).toBeDefined();
    expect(within(acknowledged).queryByRole("textbox")?.hasAttribute("disabled") ?? true).toBe(true);

    const mode = await within(field(permissions, "permissions.unattended.mode")).findByRole("radiogroup");
    await app.user.click(within(mode).getByRole("radio", { name: "Bypass permissions" }));
    const cancelled = await screen.findByRole("dialog", { name: "Set Unattended permission mode to bypassPermissions?" });
    expect(within(cancelled).getByText(BYPASS_SENTENCE)).toBeDefined();
    await app.user.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("permissions.settings.set")).toEqual([]);

    await app.user.click(within(mode).getByRole("radio", { name: "Bypass permissions" }));
    const confirm = await screen.findByRole("dialog", { name: "Set Unattended permission mode to bypassPermissions?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Set it" }));
    await waitFor(() => expect(desk.settings()["permissions.unattended.mode"]).toBe("bypassPermissions"));
    expect(desk.requests("permissions.settings.set").map((request) => request.params)).toEqual([
      { commandId: expect.any(String), values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true },
    ]);
    expect(desk.settings()["permissions.unattended.bypassAcknowledgedAt"]).not.toBeNull();
  });

  it("offers each containment level with its availability, greying one the environment cannot enforce with its reason, and says the refusal in one line", async () => {
    const app = await opened({ laptop: { containment: NO_BUBBLEWRAP } });
    const laptop = app.environment("laptop");
    const permissions = await openPermissions(app, "laptop");

    await waitFor(() =>
      expect(levels(permissions)).toEqual([
        ["off: available", true],
        ["workspace: not available here: bwrap is not on PATH: install bubblewrap.", false],
        ["no network: not available here: bwrap is not on PATH: install bubblewrap.", false],
      ]),
    );
    const group = within(permissions).getByRole("radiogroup", { name: "Default process containment" });
    expect(within(group).getByText("How new sessions restrict agent processes and network access. The environment reports which restrictions this machine supports.")).toBeDefined();
    const workspace = within(group).getByRole("radio", { name: /^workspace/ });
    expect(workspace.closest("label")?.className).toMatch(/text-ink-muted/);

    await app.user.click(workspace);
    expect(await within(group).findByText(/^Not saved: workspace cannot be enforced here/)).toBeDefined();
    expect(within(permissions).getAllByText(/^Not saved:/)).toHaveLength(1);
    expect(laptop.settings()["permissions.containment.default"]).toBe("off");

    await app.user.click(within(group).getByRole("radio", { name: /^off/ }));
    const desk = await openPermissions(app, "desk");
    await app.user.click(await within(desk).findByRole("radio", { name: /^no network/ }));
    await waitFor(() => expect(app.environment("desk").settings()["permissions.containment.default"]).toBe("workspace-no-network"));
    expect(levels(desk).find(([, chosen]) => chosen)?.[0]).toBe("no network: available");
  });

  it("shows a value another client changes once settings.changed is heard", async () => {
    const app = await opened();
    const permissions = await openPermissions(app);
    const ceiling = await within(field(permissions, "permissions.defaultCeiling")).findByRole("radiogroup");
    await waitFor(() => expect(within(ceiling).getByRole("radio", { name: "Accept file edits" })).toBeDefined());
    app.environment("desk").setSettings({ "permissions.defaultCeiling": "auto", "permissions.containment.default": "off" });
    await waitFor(() => expect((within(ceiling).getByRole("radio", { name: "Automatic review" }) as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect(levels(permissions).find(([, chosen]) => chosen)?.[0]).toBe("off: available"));
  });

  it("is read-only without admin with the capability's line said once, and shows an unreachable environment's values as last read, read-only", async () => {
    const app = await opened({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"], containment: NO_BUBBLEWRAP } });
    const laptop = await openPermissions(app, "laptop");
    expect(await within(laptop).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(laptop).getAllByText(/^Read-only:/)).toHaveLength(1);
    await waitFor(() => expect(levels(laptop)).toHaveLength(3));
    for (const radio of within(laptop).getAllByRole("radio")) expect(radio.hasAttribute("disabled")).toBe(true);
    expect(within(field(laptop, "permissions.defaultCeiling")).getByRole("radio", { name: "Plan only" }).hasAttribute("disabled")).toBe(true);
    expect(within(field(laptop, "permissions.parkedPrompt.ttl")).getByRole("textbox").hasAttribute("disabled")).toBe(true);

    const scripted = app.environment("laptop");
    scripted.discovery("nothing");
    scripted.server.drop();
    const cached = await openPermissions(app, "laptop");
    expect(await within(cached).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    expect(within(cached).queryByText(/^Read-only:/)).toBeNull();
    expect(levels(cached)[1]).toEqual(["workspace: not available here: bwrap is not on PATH: install bubblewrap.", false]);
    for (const radio of within(cached).getAllByRole("radio")) expect(radio.hasAttribute("disabled")).toBe(true);
    expect(within(field(cached, "permissions.defaultCeiling")).getByRole("radio", { name: "Plan only" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the denylist", () => {
  it("draws its four sections from permissions.denylist.get, and adds, edits, disables and removes an entry through permissions.denylist.set", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);

    const paths = await section(permissions, "Paths");
    expect(within(denylistOf(permissions)).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["Browser domains", "Paths", "Command patterns", "Hosts"]);
    expect(within(paths).getByText("Files and directories, and everything under a directory.")).toBeDefined();
    expect(entries(paths)).toEqual(PRESETS.paths.map((entry) => entry.pattern));
    const ssh = within(paths).getByRole("listitem", { name: "~/.ssh" });
    expect(within(ssh).getByText("SSH keys and known hosts.")).toBeDefined();
    expect(within(ssh).getByText("preset")).toBeDefined();
    const hosts = await section(permissions, "Hosts");
    expect(within(hosts).getByText("No entry yet.")).toBeDefined();

    // Added at the end, with its note.
    await app.user.type(within(hosts).getByRole("textbox", { name: "New pattern" }), "*.internal.example");
    await app.user.type(within(hosts).getByRole("textbox", { name: "New note" }), "The office network.");
    await app.user.click(within(hosts).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(entries(hosts)).toEqual(["*.internal.example"]));
    expect(desk.denylist().hosts).toEqual([{ id: expect.any(String), pattern: "*.internal.example", note: "The office network.", preset: false, enabled: true }]);
    expect((within(hosts).getByRole("textbox", { name: "New pattern" }) as HTMLInputElement).value).toBe("");

    // Disabled in place.
    await app.user.click(within(ssh).getByRole("switch", { name: "Enabled" }));
    await waitFor(() => expect(within(within(paths).getByRole("listitem", { name: "~/.ssh" })).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("false"));
    expect(desk.denylist().paths.find((entry) => entry.pattern === "~/.ssh")).toMatchObject({ id: "preset:~/.ssh", preset: true, enabled: false });

    // Edited under its id: a preset stays a preset.
    const gnupg = within(paths).getByRole("listitem", { name: "~/.gnupg" });
    await app.user.click(within(gnupg).getByRole("button", { name: "Edit" }));
    const pattern = within(paths).getByRole("textbox", { name: "Pattern" });
    await app.user.clear(pattern);
    await app.user.type(pattern, "~/.gnupg/private-keys-v1.d");
    await app.user.click(within(paths).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entries(paths)[1]).toBe("~/.gnupg/private-keys-v1.d"));
    expect(desk.denylist().paths[1]).toMatchObject({ id: "preset:~/.gnupg", pattern: "~/.gnupg/private-keys-v1.d", preset: true });

    // Removed.
    await app.user.click(within(within(hosts).getByRole("listitem", { name: "*.internal.example" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(hosts).getByText("No entry yet.")).toBeDefined());
    expect(desk.denylist().hosts).toEqual([]);

    // Each write names its section alone, every entry of it under its id.
    const sent = desk.requests("permissions.denylist.set").map((request) => request.params["sections"] as Record<string, readonly { readonly id?: string }[]>);
    expect(sent.map((sections) => Object.keys(sections))).toEqual([["hosts"], ["paths"], ["paths"], ["hosts"]]);
    expect(sent[1]?.["paths"]?.map((entry) => entry.id)).toEqual(PRESETS.paths.map((entry) => entry.id));
  });

  it("shows another client's change once denylist.updated is heard, with no wait for the cache's five minutes", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const paths = await section(permissions, "Paths");
    const hosts = await section(permissions, "Hosts");
    expect(within(hosts).getByText("No entry yet.")).toBeDefined();
    const [ssh, ...rest] = PRESETS.paths;

    desk.setDenylist({ paths: [...rest, { ...ssh!, enabled: false }], hosts: [{ id: "metadata", pattern: "169.254.169.254", note: "The metadata service.", preset: false, enabled: true }] });
    await waitFor(() => expect(entries(hosts)).toEqual(["169.254.169.254"]));
    expect(within(hosts).getByText("The metadata service.")).toBeDefined();
    expect(entries(paths)).toEqual([...rest, ssh!].map((entry) => entry.pattern));
    expect(within(within(paths).getByRole("listitem", { name: "~/.ssh" })).getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("false");
    expect(desk.requests("permissions.denylist.get")).toHaveLength(2);
  });

  it("writes a section one change at a time, so a change made before the last one is answered cannot send the section without it", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const paths = await section(permissions, "Paths");
    const enabled = (pattern: string) => within(within(paths).getByRole("listitem", { name: pattern })).getByRole("switch", { name: "Enabled" });
    const writes = () => desk.requests("permissions.denylist.set");

    // While ~/.ssh's write is unanswered, nothing else writes the section; another section still writes.
    const release = desk.holdDenylistWrites();
    await app.user.click(enabled("~/.ssh"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await app.user.type(within(paths).getByRole("textbox", { name: "New pattern" }), "~/.aws");
    const waiting = [
      enabled("~/.gnupg"),
      within(within(paths).getByRole("listitem", { name: "~/.gnupg" })).getByRole("button", { name: "Remove" }),
      within(paths).getByRole("button", { name: "Add" }),
      within(paths).getByRole("button", { name: "Restore presets" }),
    ];
    for (const control of waiting) expect(control.hasAttribute("disabled")).toBe(true);
    const commands = await section(permissions, "Command patterns");
    expect(within(within(commands).getByRole("listitem", { name: "sudo *" })).getByRole("switch", { name: "Enabled" }).hasAttribute("disabled")).toBe(false);

    // Once it is answered, the next change is made on the section it answered.
    release();
    await waitFor(() => expect(enabled("~/.gnupg").hasAttribute("disabled")).toBe(false));
    await app.user.click(enabled("~/.gnupg"));
    await waitFor(() => expect(enabled("~/.gnupg").getAttribute("aria-checked")).toBe("false"));
    expect(writes()).toHaveLength(2);
    expect(desk.denylist().paths.filter((entry) => entry.pattern === "~/.ssh" || entry.pattern === "~/.gnupg").map((entry) => entry.enabled)).toEqual([false, false]);
  });

  it("says a pattern its section's grammar refuses in one line and sends nothing, and says the environment's refusal in one line", async () => {
    const app = await opened({ laptop: { receipts: { "permissions.denylist.set": { rejected: "conflict", message: "The denylist changed meanwhile." } } } });
    const permissions = await openPermissions(app);
    const paths = await section(permissions, "Paths");
    await app.user.type(within(paths).getByRole("textbox", { name: "New pattern" }), "notes/private");
    await app.user.click(within(paths).getByRole("button", { name: "Add" }));
    expect(
      await within(paths).findByText("Not saved: notes/private is not a pattern paths takes: A POSIX absolute, drive-letter absolute or ~-relative path; Windows accepts either separator and compares without regard to case. UNC, device and drive-relative patterns are refused. Glob segments: * and ? within a segment, ** for any number of segments."),
    ).toBeDefined();
    expect(app.environment("desk").requests("permissions.denylist.set")).toEqual([]);

    const laptop = await openPermissions(app, "laptop");
    const commands = await section(laptop, "Command patterns");
    await app.user.click(within(within(commands).getByRole("listitem", { name: "sudo *" })).getByRole("button", { name: "Remove" }));
    expect(await within(commands).findByText("Not saved: The denylist changed meanwhile.")).toBeDefined();
    expect(within(laptop).getAllByText(/^Not saved:/)).toHaveLength(1);
    expect(entries(commands)[0]).toBe("sudo *");
  });

  it("tests a path, a command or a host and names the entries it matches", async () => {
    const app = await opened();
    const permissions = await openPermissions(app);
    const test = within(denylistOf(permissions)).getByRole("form", { name: "Test the denylist" });
    const run = async (kind: string, value: string) => {
      await app.user.selectOptions(within(test).getByRole("combobox", { name: "Test as" }), kind);
      await app.user.clear(within(test).getByRole("textbox", { name: "Value to test" }));
      await app.user.type(within(test).getByRole("textbox", { name: "Value to test" }), value);
      await app.user.click(within(test).getByRole("button", { name: "Test" }));
    };

    await run("A path", "~/.ssh/id_ed25519");
    expect(await within(test).findByText("~/.ssh/id_ed25519 is on the denylist (paths: ~/.ssh).")).toBeDefined();
    await run("A command line", "sudo apt install jq");
    expect(await within(test).findByText("sudo apt install jq is on the denylist (command patterns: sudo *).")).toBeDefined();
    await run("A host or URL", "https://example.com/docs");
    expect(await within(test).findByText("Nothing on the denylist matches https://example.com/docs.")).toBeDefined();
    expect(app.environment("desk").requests("permissions.denylist.test").map((request) => request.params)).toEqual([
      { kind: "path", value: "~/.ssh/id_ed25519" },
      { kind: "command", value: "sudo apt install jq" },
      { kind: "host", value: "https://example.com/docs" },
    ]);
  });

  it("restores a section's presets after one confirmation", async () => {
    const app = await opened({ desk: { lostPresets: [PRESETS.paths[0]!.id, PRESETS.paths[1]!.id, PRESETS.commandPatterns[0]!.id] } });
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const paths = await section(permissions, "Paths");
    expect(entries(paths)).not.toContain("~/.ssh");
    expect(within(await section(permissions, "Hosts")).queryByRole("button", { name: "Restore presets" })).toBeNull();

    await app.user.click(within(paths).getByRole("button", { name: "Restore presets" }));
    const cancelled = await screen.findByRole("dialog", { name: "Restore the presets Paths lost?" });
    await app.user.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("permissions.denylist.restorePresets")).toEqual([]);

    await app.user.click(within(paths).getByRole("button", { name: "Restore presets" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore the presets Paths lost?" });
    expect(within(confirm).getByText("Each preset the section no longer holds is put back at its end, enabled; a preset edited or disabled stays as it is.")).toBeDefined();
    await app.user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(await within(paths).findByText("Restored the denylist's presets: 2 put back.")).toBeDefined();
    expect(entries(paths).slice(-2)).toEqual(["~/.ssh", "~/.gnupg"]);
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params["sections"])).toEqual([["paths"]]);
    expect(entries(await section(permissions, "Command patterns"))).not.toContain("sudo *");
  });
});

describe("the Unattended review", () => {
  /** The review's runs, each as its item reads. */
  const runs = (region: HTMLElement) =>
    within(within(region).getByRole("list", { name: "Runs" }))
      .getAllByRole("listitem")
      .filter((item) => item.parentElement?.getAttribute("aria-label") === "Runs")
      .map((item) => item.textContent);

  it("lists permissions.review.list and marks what it listed seen through permissions.review.seen", async () => {
    const app = await opened({
      desk: {
        sessions: [{ title: "Receipts" }],
        review: [
          {
            counts: { toolCalls: 3, autoApproved: 2, denied: 1, answeredByPerson: 0, expired: 0 },
            denials: [{ toolCallId: "t1", tool: "Bash", summary: "rm -rf /tmp/cache", decidedBy: "denylist", reason: "the command matches the denylist" }],
          },
          {
            actor: { kind: "completions", name: null },
            mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" },
            containment: { requested: null, effective: "off", mechanism: null, reason: null },
            counts: { toolCalls: 1, autoApproved: 1, denied: 0, answeredByPerson: 0, expired: 0 },
          },
        ],
      },
    });
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const review = within(permissions).getByRole("region", { name: "Unattended review" });

    await waitFor(() => expect(within(review).queryByRole("list", { name: "Runs" })).not.toBeNull());
    expect(runs(review)).toEqual([
      expect.stringMatching(
        /^\d\d:\d\d Receipts · routine nightly · unattended · acceptEdits · workspace3 calls: 2 auto-approved, 1 denied, 0 by a person, 0 expireddenied Bash: rm -rf \/tmp\/cache \(denylist: the command matches the denylist\)$/,
      ),
      expect.stringMatching(/^\d\d:\d\d Receipts · completions · unattended · auto \(clamped from bypassPermissions\) · off1 call: 1 auto-approved, 0 denied, 0 by a person, 0 expired$/),
    ]);

    const head = (await app.runtime.requests.call(desk.environmentId, "permissions.review.list", {})) as { ok: true; result: { head: number } };
    await app.user.click(within(review).getByRole("button", { name: "Mark seen" }));
    expect(await within(review).findByText("Marked 2 runs seen.")).toBeDefined();
    expect(await within(review).findByText("Nothing to review: no run since the review was last seen.")).toBeDefined();
    expect(within(review).getByRole("button", { name: "Mark seen" }).hasAttribute("disabled")).toBe(true);
    expect(desk.requests("permissions.review.seen").map((request) => request.params["through"])).toEqual([head.result.head]);
    expect(desk.reviewWatermark()).toBe(head.result.head);
  });

  it("shows a run decided since and another client's Mark seen once review.updated is heard, with no wait for the cache's five minutes", async () => {
    const app = await opened({ desk: { sessions: [{ title: "Receipts" }], review: [{ counts: { toolCalls: 1, autoApproved: 1, denied: 0, answeredByPerson: 0, expired: 0 } }] } });
    const desk = app.environment("desk");
    const permissions = await openPermissions(app);
    const review = within(permissions).getByRole("region", { name: "Unattended review" });
    await waitFor(() => expect(within(review).queryByRole("list", { name: "Runs" })).not.toBeNull());
    expect(runs(review)).toEqual([expect.stringContaining("routine nightly")]);

    desk.decideReviewRun({ actor: { kind: "bot", name: "triage" }, counts: { toolCalls: 2, autoApproved: 2, denied: 0, answeredByPerson: 0, expired: 0 } });
    await waitFor(() => expect(runs(review)).toEqual([expect.stringContaining("bot triage"), expect.stringContaining("routine nightly")]));

    desk.seeReview();
    expect(await within(review).findByText("Nothing to review: no run since the review was last seen.")).toBeDefined();
    expect(desk.requests("permissions.review.list")).toHaveLength(3);
  });

  it("can be marked seen without admin, and not without sessions:write, whose line it says", async () => {
    const app = await opened({
      desk: { scopes: ["read", "sessions:write", "runs:drive", "terminal"], review: [{}] },
      laptop: { scopes: ["read", "runs:drive", "terminal"], review: [{}] },
    });
    const desk = await openPermissions(app);
    const review = within(desk).getByRole("region", { name: "Unattended review" });
    await waitFor(() => expect(within(review).getByRole("button", { name: "Mark seen" }).hasAttribute("disabled")).toBe(false));

    const laptop = await openPermissions(app, "laptop");
    const cannot = within(laptop).getByRole("region", { name: "Unattended review" });
    expect(await within(cannot).findByText("This app has limited access to laptop, so it cannot start sessions. Pair again with full access to change this.")).toBeDefined();
    expect(within(cannot).getByRole("button", { name: "Mark seen" }).hasAttribute("disabled")).toBe(true);
  });
});
