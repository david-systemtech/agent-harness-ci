import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AccountUsage } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";
import { region, sidebar } from "../test/sidebar-fixtures.js";

/**
 * The new-session surface's account and model picker (#1894): the status
 * line's own rows, so a person picking an account and model for a new
 * session sees what the status line's picker shows (#1821, #1822, #1824):
 * each account with its usage rings, the reading in their tooltip; the
 * favourite models first, else the provider's recommended ones with how to
 * pin favourites, every other model under Other models; and the model named
 * as the provider names it on the chip. Driven through the harness over the
 * scripted environment.
 */

const WORK = { provider: "claude", email: "milo@work.test", organisation: null };
const HOME = { provider: "claude", email: "milo@home.test", organisation: null };
const SPARE = { provider: "claude", email: "milo@spare.test", organisation: null };

const model = (id: string, family: string, tier: number, label: string | null = null, efforts: readonly string[] = []) => ({ id, family, tier, efforts: [...efforts], label });
/** Two opus models, one each of sonnet, haiku, fable and mini: four recommended, the second opus and the mini under Other models. */
const SIX = { accountId: "account-1", live: true, models: [
  model("claude-opus-4", "opus", 5, "Opus"), model("claude-opus-4-1m", "opus", 4), model("claude-sonnet-4", "sonnet", 3),
  model("claude-haiku-4", "haiku", 2), model("fable", "fable", 6, "Fable", ["low", "high"]), model("claude-mini-4", "mini", 1),
] };

const desk = (more: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  accounts: [{ id: "account-1", label: "work", identity: WORK }],
  models: [SIX],
  sessions: [{ title: "Receipts", accountId: "account-1", model: "claude-opus-4" }],
  ...more,
});

const reading = (accountId: string, identity: AccountUsage["identity"], windows: AccountUsage["windows"], unavailableReason: string | null = null): AccountUsage => ({
  accountId, identity, windows, readAt: "2026-09-25T09:00:00.000Z", unavailableReason,
});
const window = (name: string, utilisation: number) => ({ window: name, utilisation, resetsAt: "2026-09-25T14:30:00.000Z", verdict: null, observedAt: "2026-09-25T09:00:00.000Z" });

const surface = () => within(screen.getByRole("main")).getByRole("region", { name: "New session" });
const chip = (name: string) => within(within(surface()).getByRole("group", { name: "Where it starts" })).getByRole("button", { name: new RegExp(`^${name}: `) });

/** The app over `environments`, desk's sidebar drawn. */
const launch = async (environments: readonly ScriptedEnvironment[]) => {
  const app = await renderApp({ environments });
  await within(sidebar()).findByRole("button", { name: /Receipts/ });
  return app;
};

/** A new session on desk from its heading's control, its chips preset. */
const newSession = async (app: RenderedApp) => {
  await app.user.click(within(region("desk")).getByRole("button", { name: "New session on desk" }));
  await waitFor(() => expect(chip("Model").getAttribute("aria-label")).not.toBe("Model: none"));
};

/** Opens a chip, as a person tabbing to it and pressing Enter does. */
const openChip = async (app: RenderedApp, name: string) => {
  act(() => chip(name).focus());
  await app.user.keyboard("{Enter}");
  return screen.findByRole("menu", { name: "Run choices" });
};

const rows = (group: HTMLElement) => within(group).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"));
const rings = (row: HTMLElement) => within(row).queryAllByRole("img").map((ring) => ring.getAttribute("aria-label"));

describe("the new-session account picker (ticket 1894)", () => {
  it("lists each account with its identity, sign-in status and usage rings, the reading in the rings' tooltip, with no text block", async () => {
    const app = await launch([desk({ accounts: [
      { id: "account-1", label: "work", identity: WORK },
      { id: "account-2", label: "personal", identity: HOME, status: { state: "expired", checkedAt: null, detail: null } },
      { id: "account-3", label: "spare", identity: SPARE },
    ] })]);
    app.environment("desk").setUsage([
      reading("account-1", WORK, [window("five_hour", 0.42), window("seven_day", 0.8)]),
      reading("account-2", HOME, [], "Not signed in."),
      reading("account-3", SPARE, [window("five_hour", 0.95)]),
    ]);
    await newSession(app);
    const menu = await openChip(app, "Account");
    const work = within(menu).getByRole("menuitem", { name: /^work/ });
    const personal = within(menu).getByRole("menuitem", { name: /^personal/ });
    const spare = within(menu).getByRole("menuitem", { name: /^spare/ });
    await waitFor(() => expect(rings(work)).toEqual(["5-hour 42%", "Weekly 80%"]));
    expect(rings(spare)).toEqual(["5-hour 95%"]);
    expect(rings(personal)).toEqual([]);
    expect(work.textContent).toBe("work milo@work.testsigned in · claude");
    expect(personal.textContent).toBe("personal milo@home.testsign-in expired · claude");
    for (const row of [work, spare, personal]) expect(row.querySelectorAll("[data-usage-rings]")).toHaveLength(1);
    await app.user.hover(within(work).getByRole("group", { name: "5-hour 42% · Weekly 80%" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("5-hour 42% · Weekly 80%");
  });
});

describe("the new-session model picker (ticket 1894)", () => {
  it("lists the favourites first in the person's order, then the chip's model, and the rest under Other models, opened on hover", async () => {
    const app = await launch([desk({ settings: { "accounts.favouriteModels": ["claude-haiku-4", "claude-sonnet-4"] } })]);
    await newSession(app);
    const menu = await openChip(app, "Model");
    const list = within(menu).getByRole("group", { name: "Models" });
    // The chip holds the account's strongest model, fable, from a heading's New session.
    await waitFor(() => expect(rows(list)).toEqual(["claude-haiku-4", "claude-sonnet-4", "Fable 5.1 (fable)", "Other models", "Edit favourites…"]));
    expect(within(list).queryByText(/Pin your favourites/)).toBeNull();
    await app.user.hover(within(list).getByRole("menuitem", { name: "Other models" }));
    const others = await screen.findByRole("menu", { name: "Other models" });
    expect(rows(others)).toEqual(["Opus (claude-opus-4)", "claude-opus-4-1m", "claude-mini-4"]);
    fireEvent.click(within(others).getByRole("menuitem", { name: "claude-mini-4" }));
    await waitFor(() => expect(chip("Model").getAttribute("aria-label")).toBe("Model: claude-mini-4"));
  });

  it("offers the recommended models with no favourite pinned and says how to pin them", async () => {
    const app = await launch([desk()]);
    await newSession(app);
    const menu = await openChip(app, "Model");
    const list = within(menu).getByRole("group", { name: "Models" });
    await waitFor(() => expect(rows(list)).toEqual(["Opus (claude-opus-4)", "claude-sonnet-4", "claude-haiku-4", "Fable 5.1 (fable)", "Other models", "Pin favourites…"]));
    expect(within(list).getByText("Recommended models. Pin your favourites in Settings, Default account and model.")).toBeTruthy();
  });

  it("names the model on the chip as the provider does, with its effort and no id after it", async () => {
    const app = await launch([desk({ sessions: [{ title: "Receipts", accountId: "account-1", model: "fable" }] })]);
    await newSession(app);
    expect(chip("Model").getAttribute("aria-label")).toBe("Model: Fable 5.1");
    const menu = await openChip(app, "Model");
    const fable = within(within(menu).getByRole("group", { name: "Models" })).getByRole("menuitem", { name: "Fable 5.1 (fable)" });
    // The row's first line is the provider's name alone; the id sits on a line of its own under it.
    expect([...fable.querySelectorAll(":scope > span > span")].map((line) => line.textContent).slice(0, 2)).toEqual(["Fable 5.1", "fable"]);
    await app.user.click(within(within(menu).getByRole("group", { name: "Effort" })).getByRole("menuitem", { name: "High" }));
    await waitFor(() => expect(chip("Model").getAttribute("aria-label")).toBe("Model: Fable 5.1 - High"));
  });
});

describe("both account and model pickers (ticket 1894)", () => {
  const quickPicks = async (app: RenderedApp, open: () => Promise<HTMLElement>) => {
    const menu = await open();
    const list = within(menu).getByRole("group", { name: "Models" });
    await waitFor(() => expect(rows(list)).toContain("Other models"));
    const listed = rows(list);
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Run choices" })).toBeNull());
    return listed;
  };
  const statusLinePicker = (app: RenderedApp) => async () => {
    const button = await within(screen.getByRole("region", { name: "Status line" })).findByRole("button", { name: /^Model: / });
    act(() => button.focus());
    await app.user.keyboard("{Enter}");
    return screen.findByRole("menu", { name: "Run choices" });
  };

  const cases: readonly (readonly [string, NonNullable<ScriptedEnvironment["settings"]>, readonly string[]])[] = [
    ["the favourites", { "accounts.favouriteModels": ["fable", "claude-mini-4", "claude-haiku-4"] }, ["Fable 5.1 (fable)", "claude-mini-4", "claude-haiku-4", "Opus (claude-opus-4)", "Other models", "Edit favourites…"]],
    ["the recommended models", {}, ["Opus (claude-opus-4)", "claude-sonnet-4", "claude-haiku-4", "Fable 5.1 (fable)", "Other models", "Pin favourites…"]],
  ];
  for (const [name, settings, expected] of cases) {
    it(`list ${name} in the same order`, async () => {
      const app = await launch([desk({ settings })]);
      app.open("desk");
      await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
      const inSession = await quickPicks(app, statusLinePicker(app));
      await app.user.keyboard("{Control>}n{/Control}");
      await waitFor(() => expect(chip("Model").getAttribute("aria-label")).not.toBe("Model: none"));
      const inNewSession = await quickPicks(app, () => openChip(app, "Model"));
      expect(inSession).toEqual(expected);
      expect(inNewSession).toEqual(inSession);
    });
  }
});
