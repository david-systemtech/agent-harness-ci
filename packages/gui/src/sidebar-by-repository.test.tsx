import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScriptedEnvironment } from "../test/harness.js";
import { LAPTOP_ID, TRAIN, desk, drag, drawn, heading, inUtc, laptop, lineOf, region, row, settled, sidebar, two, typeIn } from "../test/sidebar-fixtures.js";

/**
 * The sidebar by repository (docs/specs/gui.md, "The window and the
 * sidebar"; docs/specs/workspace-picker.md, "The picker in the client
 * runtime"; #422), through the harness over the two scripted environments,
 * their summaries carrying repository identities: the switch, kept as
 * presentation over a remount; one heading per repository across both
 * environments, labelled with the identity's path and with the host when two
 * share a path; each environment's last heading for its sessions with no
 * identity; the rows drawn as by group; a repository's fold kept by heading
 * name; the filter; and a drop on a repository refused with its reason.
 */

inUtc();

const HARNESS = "https://git.systemtech.dev/david/agent-harness";
const SITE_ON_GITHUB = "https://github.com/brandsolidate/site";
const SITE_ON_FORGE = "https://git.example.test/brandsolidate/site";

/** The fixtures' sessions, each given the repository identity its title names here, else none. */
const identified = (sessions: ScriptedEnvironment["sessions"], identities: Readonly<Record<string, string>>) =>
  (sessions ?? []).map((session) => ({ ...session, repositoryIdentity: identities[session.title ?? ""] ?? null }));

/**
 * The desk's "Fix the rail", pinned "Pinned one" and settled "Done" and the laptop's "Train tidy" are in one repository;
 * the desk's "Brand copy" and the laptop's "Brand on laptop" in two that share a path on different hosts; "Spare",
 * "Later", "Old thing" and "Laptop pin" in none.
 */
const inRepositories = (options: Parameters<typeof two>[0] = {}) =>
  two({
    ...options,
    desk: { sessions: identified(desk().sessions, { "Fix the rail": HARNESS, "Brand copy": SITE_ON_GITHUB, "Pinned one": HARNESS, Done: HARNESS }) },
    laptop: { sessions: identified(laptop().sessions, { "Train tidy": HARNESS, "Brand on laptop": SITE_ON_FORGE }) },
  });

const byRepository = () => within(sidebar()).getByRole("switch", { name: "By repository" });

describe("the switch", () => {
  it("shows the sidebar by repository or by groups, and the choice is presentation that survives a remount", async () => {
    const app = await settled(await inRepositories());
    expect(byRepository().getAttribute("aria-checked")).toBe("false");
    expect(drawn()).toContain("▾ Brandsolidate");

    await app.user.click(byRepository());
    expect(drawn()).toEqual([
      "▾ Pinned",
      "  Pinned one",
      "  Laptop pin",
      "▾ git.example.test/brandsolidate/site",
      "  Brand on laptop",
      "▾ david/agent-harness",
      "  Fix the rail #wip",
      "  Train tidy ?2",
      "▾ github.com/brandsolidate/site",
      "  Brand copy",
      "desk · no repository",
      "  Spare",
      "laptop · no repository",
      "▾ Snoozed",
      "  Later 18:00",
      "▸ Settled 1",
      "▸ Archive 1",
    ]);
    expect(app.presentation.values.read().sidebarView).toBe("repositories");

    await settled(await app.remount());
    expect(byRepository().getAttribute("aria-checked")).toBe("true");
    expect(drawn()).toContain("▾ david/agent-harness");

    await app.user.click(byRepository());
    expect(drawn()).toContain("▾ Brandsolidate");
    expect(drawn()).not.toContain("▾ david/agent-harness");
  });
});

describe("a repository's heading", () => {
  it("holds the repository's sessions from both environments, each row drawn as by group: its own environment's badge, its activity and its tags", async () => {
    await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    const harness = region("david/agent-harness");
    const rows = within(harness).getAllByRole("listitem");
    expect(rows.map((line) => line.textContent?.trim())).toEqual(["Fix the rail #wip", "Train tidy ?2"]);
    const badges = rows.map((line) => within(line).getAllByRole("img")[0] as HTMLElement).map((badge) => [badge.getAttribute("aria-label"), badge.style.color]);
    expect(badges).toEqual([
      ["desk", "var(--environment-teal)"],
      ["laptop", "var(--environment-amber)"],
    ]);
    expect(within(row("Fix the rail")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(row("Train tidy")).getByRole("img", { name: "2 prompts waiting for you" })).toBeDefined();
  });

  it("is labelled with the identity's path, and with the host when two headings share a path", async () => {
    await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    expect(within(region("github.com/brandsolidate/site")).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Brand copy"]);
    expect(within(region("git.example.test/brandsolidate/site")).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Brand on laptop"]);
    expect(within(sidebar()).queryByRole("region", { name: "brandsolidate/site" })).toBeNull();
    expect(within(sidebar()).queryByRole("region", { name: "git.systemtech.dev/david/agent-harness" })).toBeNull();
  });

  it("shows the pending marker on a row until its receipt, and a row of an environment that cannot be reached dim", async () => {
    const app = await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    const laptop = app.environment("laptop");
    const release = laptop.list.hold("sessions.tag");
    void app.runtime.commands.dispatch(LAPTOP_ID, "sessions.tag", { sessionId: TRAIN, tag: "later" });
    await waitFor(() => expect(within(row("Train tidy")).getByRole("img", { name: "Pending" })).toBeDefined());
    expect(within(region("david/agent-harness")).getAllByRole("listitem").map((line) => line.textContent?.trim())).toContain("Train tidy #later ?2 ↻");
    release();
    await waitFor(() => expect(within(row("Train tidy")).queryByRole("img", { name: "Pending" })).toBeNull());

    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(region("laptop · no repository")).findByText("Unreachable since 00:00")).toBeDefined();
    expect(within(region("david/agent-harness")).getByRole("button", { name: /Train tidy/, description: "Cached: laptop is not answering." })).toBeDefined();
    expect(within(region("david/agent-harness")).getByRole("button", { name: /Fix the rail/, description: "" })).toBeDefined();
  });

  it("folds, kept in collapsedHeadings keyed as the terminal UI keys it, and stays folded when the window opens again", async () => {
    const app = await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    await app.user.click(within(sidebar()).getByRole("button", { name: "david/agent-harness", expanded: true }));
    expect(drawn()).toContain("▸ david/agent-harness 2");
    expect(within(region("david/agent-harness")).queryAllByRole("listitem")).toEqual([]);
    expect(app.presentation.values.read().collapsedHeadings).toEqual({ [`repository:${HARNESS}`]: true });

    await settled(await app.remount(), "Brand on laptop");
    expect(drawn()).toContain("▸ david/agent-harness 2");
  });

  it("refuses a session dropped on it with the reason, since a repository is not a group, and nothing is sent", async () => {
    const app = await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    const status = () => within(sidebar()).getByRole("status").textContent;
    expect(drag(row("Spare"), heading("david/agent-harness"))).toBe(false);
    expect(status()).toBe("Not moved: a repository is not a group; a session's repository is its workspace's.");
    expect(drag(row("Brand copy"), lineOf("Train tidy"))).toBe(false);
    expect(drag(row("Brand copy"), heading("desk · no repository"))).toBe(false);
    expect(status()).toBe("Not moved: a repository is not a group; a session's repository is its workspace's.");
    for (const name of ["desk", "laptop"]) {
      for (const method of ["sessions.setGroup", "sessions.reorderActive", "groups.create"]) expect(app.environment(name).requests(method)).toEqual([]);
    }
  });
});

describe("an environment's last heading", () => {
  it("holds its sessions with no identity, one per environment after every repository, with its environment's name, badge and status", async () => {
    await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    const desk = region("desk · no repository");
    expect(within(desk).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Spare"]);
    expect(within(desk).getAllByRole("img")[0]?.style.color).toBe("var(--environment-teal)");
    const headings = drawn().filter((line) => !line.startsWith("  "));
    expect(headings.indexOf("desk · no repository")).toBeGreaterThan(headings.indexOf("▾ github.com/brandsolidate/site"));
    expect(headings.indexOf("laptop · no repository")).toBe(headings.indexOf("desk · no repository") + 1);
    expect(within(region("laptop · no repository")).queryAllByRole("listitem")).toEqual([]);
  });
});

describe("the filter", () => {
  it("narrows the sidebar by repository to projections.search's rows as by group, and clearing it brings the repositories back", async () => {
    const app = await settled(await inRepositories({ presentation: { sidebarView: "repositories" } }));
    const before = drawn();
    const filter = within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" });
    await typeIn(app, filter, "agent-harness");
    const found = within(sidebar()).getByRole("list", { name: "Sessions matching “agent-harness”" });
    expect(within(found).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Pinned one", "Fix the rail #wip", "Train tidy ?2", "Done"]);
    expect(within(sidebar()).queryAllByRole("region")).toEqual([]);

    await app.user.click(row("Train tidy"));
    await waitFor(() => expect(app.shown()).toEqual({ environmentId: LAPTOP_ID, sessionId: TRAIN }));
    await typeIn(app, filter, "{Backspace>13/}");
    expect(drawn()).toEqual(before);
    expect(screen.queryByText(/No session matches/)).toBeNull();
  });
});
