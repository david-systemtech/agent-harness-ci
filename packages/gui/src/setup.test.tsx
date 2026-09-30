import { act, screen, waitFor, within } from "@testing-library/react";
import { SETUP_PENDING_MS } from "@agent-harness/client-runtime";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import { SETTINGS, STEP_ORDER, denylistPresets } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment, type ScriptedSetup } from "../test/harness.js";

/**
 * Set up in the window (docs/specs/gui.md, "Set up in the window"; the Set
 * up specification, "The checklist in the GUI"; ADR 0016, ADR 0027, ADR
 * 0031; #413): the full checklist as the whole window on first launch, its
 * first-launch mark, the Set up pane, Re-run, the named actions, the health
 * dots on home rows and the header's line, all drawn from
 * `projections.setup` over the scripted environment's `setup.check`
 * answers.
 */

/** The session pane region's word while no session is open: the window as it is past Set up. */
const NO_SESSION = "No session is open. Choose one from the sidebar.";

/** Set up as the whole window; null while it is not. */
const checklist = () => screen.queryByRole("region", { name: "Set up" });

/** The full checklist's rail of steps. */
const steps = () => within(checklist() as HTMLElement).getByRole("navigation", { name: "Set up steps" });

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings with Mod+, on the row last opened (Set up, until another is), as a person does. */
const openSettings = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  return screen.findByRole("region", { name: "Settings" });
};

/** The Set up pane, in Settings. */
const setupPane = async (app: RenderedApp) => {
  const open = await openSettings(app);
  return within(open).getByRole("region", { name: "Set up" });
};

/**
 * An environment's Set up with results for these steps alone, and none for any other, whichever this build registers:
 * the counts and dots a test reads stay as it scripts them as more steps are registered.
 */
const onlySteps = (results: ScriptedSetup): ScriptedSetup => ({ ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])), ...results });

/** A first launch on this machine's environment, `desk`, as `given` scripts it, with Set up open over the window. */
const firstLaunch = async (given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true });
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

describe("the first-launch mark", () => {
  it("is set by closing Set up, so the next launch opens on the window, and the Set up pane's Open the full checklist brings it back", async () => {
    const app = await firstLaunch();
    await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();

    const again = await app.remount();
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();

    await again.user.click(within(await setupPane(again)).getByRole("button", { name: "Open the full checklist" }));
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  });

  it("is set by Finish on the last step, which Continue walks to one step at a time", async () => {
    const app = await firstLaunch();
    const card = () => within(checklist() as HTMLElement).getAllByRole("region")[0] as HTMLElement;
    const walked: string[] = [];
    while (within(card()).queryByRole("button", { name: "Continue" }) !== null) {
      walked.push(within(card()).getByRole("heading").textContent ?? "");
      await app.user.click(within(card()).getByRole("button", { name: "Continue" }));
    }
    expect(walked).toEqual(["Account", "Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions"]);
    expect(within(card()).getByRole("heading").textContent).toBe("Appearance");
    expect(within(steps()).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("step");

    await app.user.click(within(card()).getByRole("button", { name: "Finish" }));
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    await app.remount();
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();
  });

  it("stays unset when a step's link leaves Set up for its home row, so the next launch opens Set up again", async () => {
    const app = await firstLaunch();
    await app.user.click(within(steps()).getByRole("button", { name: "Permissions" }));
    await app.user.click(within(checklist() as HTMLElement).getByRole("button", { name: "Open Permissions" }));
    expect(within(settings()).getByRole("region", { name: "Permissions" })).toBeDefined();
    expect(checklist()).toBeNull();

    await app.remount();
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
    await waitFor(() => expect(within(steps()).getByRole("img", { name: "Account: done" })).toBeDefined());
  });
});

describe("Skip for now", () => {
  it("is on a skippable step's card beside Continue, moves the rail to the next step and records nothing", async () => {
    const app = await firstLaunch();
    const desk = app.environment("desk");
    const card = () => within(checklist() as HTMLElement).getAllByRole("region")[0] as HTMLElement;
    const skippable: string[] = [];
    while (within(card()).queryByRole("button", { name: "Continue" }) !== null) {
      if (within(card()).queryByRole("button", { name: "Skip for now" }) !== null) skippable.push(within(card()).getByRole("heading").textContent ?? "");
      await app.user.click(within(card()).getByRole("button", { name: "Continue" }));
    }
    // The steps this build registers as skippable: Forges and Key manager, with nothing set up there when they are skipped.
    expect(skippable).toEqual(["Forges", "Key manager"]);

    await app.user.click(within(steps()).getByRole("button", { name: "Forges" }));
    const commands = () => desk.requests().filter((request) => request.params["commandId"] !== undefined).length;
    const sent = { commands: commands(), checks: desk.requests("setup.check").length };
    await app.user.click(within(card()).getByRole("button", { name: "Skip for now" }));
    expect(within(card()).getByRole("heading").textContent).toBe("Key manager");
    expect(within(steps()).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(within(card()).getByRole("button", { name: "Skip for now" }));
    expect(within(card()).getByRole("heading").textContent).toBe("Memory bank");
    expect({ commands: commands(), checks: desk.requests("setup.check").length }).toEqual(sent);

    // Nothing was recorded, the first-launch mark included: the next launch opens Set up again.
    await app.remount();
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
  });
});

/** The six steps both environments give results for, each done. */
const PASSING: ScriptedSetup = { account: {}, "your-machines": {}, forges: {}, browser: {}, permissions: {}, appearance: {} };

/** Two environments: `desk`, this machine's, with Permissions needing attention and Browser skipped; `laptop`, paired, with the `setup` flag and Appearance needing attention. */
const twoEnvironments = async () => {
  const app = await renderApp({
    environments: [
      {
        name: "desk",
        reach: "local",
        setup: onlySteps({
          ...PASSING,
          permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] },
          browser: { state: "skipped", reason: "No Chrome is paired." },
        }),
      },
      {
        name: "laptop",
        reach: "paired",
        capabilities: ["setup"],
        setup: onlySteps({
          ...PASSING,
          appearance: { state: "needs-attention", reason: "Theme \"Olive\" has 1 seed clamped.", failing: ["appearance.contrast"], actions: ["restore"] },
        }),
      },
    ],
  });
  await screen.findByText(NO_SESSION);
  return app;
};

/** The environment a picker in `region` has picked, by the name it shows. */
const pickedIn = (region: HTMLElement) => within(within(region).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent;

/** Each of the Set up pane's steps: its name, its dot's state (null for none) and its line. */
const paneSteps = (pane: HTMLElement) =>
  within(within(pane).getByRole("list", { name: "Steps" }))
    .getAllByRole("listitem")
    .map((item) => {
      const name = within(item).getByRole("button").textContent ?? "";
      return [name, within(item).queryByRole("img")?.getAttribute("aria-label")?.replace(`${name}: `, "") ?? null, item.lastElementChild?.textContent];
    });

/** The names a list of steps draws dim: the steps the environment does not register. */
const dimSteps = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .filter((button) => button.className.split(" ").includes("text-ink-faint"))
    .map((button) => button.textContent);

describe("the Set up pane", () => {
  it("names the environment it checks with a picker, and lists each step with its dot and line, linking to its home row, and the counts", async () => {
    const app = await twoEnvironments();
    const pane = await setupPane(app);
    expect(pickedIn(pane)).toBe("desk");
    expect(await within(pane).findByText("4 done, 1 needs attention, 1 skipped")).toBeDefined();
    expect(paneSteps(pane)).toEqual([
      ["Account", "done", "Every setting it writes holds a valid value."],
      ["Carry over", null, "Not checked yet."],
      ["Your machines", "done", expect.stringMatching(/^The environment runs as a non-root user\. /)],
      ["Forges", "done", expect.stringMatching(/^At least one forge account is on this environment\. /)],
      ["Key manager", null, "Not checked yet."],
      ["Memory bank", null, "Not checked yet."],
      ["Skills", null, "Not checked yet."],
      ["Instructions", null, "Not checked yet."],
      ["Browser", "skipped", "No Chrome is paired."],
      ["Permissions", "needs attention", "The denylist lost 2 presets."],
      ["Appearance", "done", expect.stringMatching(/^Both ladders of the theme meet /)],
    ]);

    // The steps desk gives no result for are ones it does not register: their names dim, with no dot, and uncounted.
    const unregistered = ["Carry over", "Key manager", "Memory bank", "Skills", "Instructions"];
    expect(dimSteps(within(pane).getByRole("list", { name: "Steps" }))).toEqual(unregistered);

    // Another environment picked: checked as it opens there, since its stream alone would never ask.
    const laptop = app.environment("laptop");
    const asked = laptop.requests("setup.check").length;
    await app.user.selectOptions(within(pane).getByRole("combobox", { name: "Environment" }), "laptop");
    expect(await within(pane).findByText("5 done, 1 needs attention, 0 skipped")).toBeDefined();
    expect(laptop.requests("setup.check").length).toBe(asked + 1);

    await app.user.click(within(within(pane).getByRole("list", { name: "Steps" })).getByRole("button", { name: "Appearance" }));
    const theme = within(settings()).getByRole("region", { name: "Theme" });
    expect(theme).toBeDefined();

    await app.user.click(within(settings()).getByRole("button", { name: "Set up" }));
    await app.user.click(within(within(settings()).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Set up another machine" }));
    expect(within(settings()).getByRole("region", { name: "Your machines" })).toBeDefined();

    // The full checklist's rail draws them the same.
    await app.user.click(within(settings()).getByRole("button", { name: "Set up" }));
    await app.user.selectOptions(within(settings()).getByRole("combobox", { name: "Environment" }), "desk");
    await app.user.click(within(within(settings()).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Open the full checklist" }));
    expect(dimSteps(steps())).toEqual(unregistered);
    for (const step of unregistered) expect(within(steps()).queryByRole("img", { name: new RegExp(`^${step}:`) })).toBeNull();
  });

  it("runs setup.check as it opens, even where the stream carries the results, and Re-run checks every step and then opens the first needing attention", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"] }] });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    expect(desk.requests("setup.check")).toHaveLength(0);
    const pane = await setupPane(app);
    await waitFor(() => expect(desk.requests("setup.check")).toHaveLength(1));
    expect(desk.requests("setup.check")[0]?.params).toEqual({});

    // Every step passes: Re-run says so, and opens nothing.
    await app.user.click(within(pane).getByRole("button", { name: "Re-run" }));
    expect(await within(pane).findByText("Every step desk checks passes.")).toBeDefined();
    expect(desk.requests("setup.check")).toHaveLength(2);

    desk.setSetup({
      permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] },
      appearance: { state: "needs-attention", reason: "Theme \"Olive\" has 1 seed clamped.", failing: ["appearance.contrast"], actions: ["restore"] },
    });
    await app.user.click(within(pane).getByRole("button", { name: "Re-run" }));
    const card = await within(await screen.findByRole("region", { name: "Set up" })).findByRole("region", { name: "Permissions" });
    expect(within(card).getByText("The denylist lost 2 presets.")).toBeDefined();
    expect(within(card).getByRole("button", { name: "Restore" })).toBeDefined();
    expect(within(steps()).getByRole("button", { name: "Permissions" }).getAttribute("aria-current")).toBe("step");
  });
});

/** The full checklist opened from the Set up pane on the card of `step`, by its label. */
const cardOf = async (app: RenderedApp, step: string) => {
  await app.user.click(within(await setupPane(app)).getByRole("button", { name: "Open the full checklist" }));
  await app.user.click(within(steps()).getByRole("button", { name: step }));
  return within(checklist() as HTMLElement).getByRole("region", { name: step });
};

describe("a step's named actions", () => {
  it("maps restore to the step's restore, the denylist's presets or the preset theme, and checks the step again", async () => {
    const app = await renderApp({
      environments: [
        {
          name: "desk",
          reach: "local",
          setup: {
            permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] },
            appearance: { state: "needs-attention", reason: "Theme \"Olive\" has 1 seed clamped.", failing: ["appearance.contrast"], actions: ["restore"] },
          },
          settings: { "appearance.theme": { ...SETTINGS["appearance.theme"].preset, name: "Olive" } },
          lostPresets: denylistPresets("/home").paths.slice(0, 2).map((entry) => entry.id),
        },
      ],
    });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");

    const permissions = await cardOf(app, "Permissions");
    desk.setSetup({ permissions: {} });
    await app.user.click(within(permissions).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Restored the denylist's presets: 2 put back.")).toBeDefined();
    expect(await within(steps()).findByRole("img", { name: "Permissions: done" })).toBeDefined();
    expect(within(permissions).getByText(/^The containment default can be enforced here\./)).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets")).toHaveLength(1);
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "permissions" });

    await app.user.click(within(steps()).getByRole("button", { name: "Appearance" }));
    const appearance = within(checklist() as HTMLElement).getByRole("region", { name: "Appearance" });
    await app.user.click(within(appearance).getByRole("button", { name: "Restore" }));
    expect(await within(appearance).findByText("Restored the Default theme.")).toBeDefined();
    expect(desk.settings()["appearance.theme"]).toEqual(SETTINGS["appearance.theme"].preset);
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "appearance" });
  });

  it("maps check-again to setup.check of the step, sign-in-again to the Accounts row, and set-up-this-machine to the checklist on the machine it names", async () => {
    const app = await renderApp({
      environments: [
        { name: "desk", reach: "local" },
        { name: "laptop", reach: "paired" },
      ],
    });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    const laptop = app.environment("laptop");
    desk.setSetup({
      account: { state: "needs-attention", reason: "work is signed out.", failing: ["account.signed-in"], actions: ["sign-in-again"] },
      "your-machines": {
        state: "needs-attention",
        reason: "could not check: timed out after 10 s",
        failing: ["your-machines.release-channel"],
        actions: ["check-again", "set-up-this-machine"],
        targets: [{ action: "set-up-this-machine", kind: "environment", id: laptop.environmentId, label: "laptop" }],
        lastGood: { state: "done", reason: "The release channel was read.", checkedAt: new Date(app.clock.now().getTime() - 2 * 3_600_000).toISOString() },
      },
    });

    const machines = await cardOf(app, "Your machines");
    expect(await within(machines).findByText("could not check: timed out after 10 s")).toBeDefined();
    expect(within(machines).getByText("Last good, checked 2 h ago: The release channel was read.")).toBeDefined();
    expect(within(machines).queryByRole("button", { name: "Check now" })).toBeNull();
    const asked = desk.requests("setup.check").length;
    await app.user.click(within(machines).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(desk.requests("setup.check")).toHaveLength(asked + 1));
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "your-machines" });

    await app.user.click(within(machines).getByRole("button", { name: "Set up this machine" }));
    expect(pickedIn(checklist() as HTMLElement)).toBe("laptop");
    await waitFor(() => expect(laptop.requests("setup.check").length).toBeGreaterThan(0));

    await app.user.selectOptions(within(checklist() as HTMLElement).getByRole("combobox", { name: "Environment" }), "desk");
    await app.user.click(within(steps()).getByRole("button", { name: "Account" }));
    const account = within(checklist() as HTMLElement).getByRole("region", { name: "Account" });
    await app.user.click(await within(account).findByRole("button", { name: "Sign in again" }));
    expect(within(settings()).getByRole("region", { name: "Accounts" })).toBeDefined();
    expect(pickedIn(within(settings()).getByRole("region", { name: "Accounts" }))).toBe("desk");
  });
});

describe("a check's time", () => {
  it("says a last good result checked under a minute ago was checked just now", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await screen.findByText(NO_SESSION);
    app.environment("desk").setSetup({
      "your-machines": {
        state: "needs-attention",
        reason: "could not check: timed out after 10 s",
        failing: ["your-machines.release-channel"],
        actions: ["check-again"],
        lastGood: { state: "done", reason: "The release channel was read.", checkedAt: new Date(app.clock.now().getTime() - 20_000).toISOString() },
      },
    });
    const machines = await cardOf(app, "Your machines");
    expect(await within(machines).findByText("Last good, checked just now: The release channel was read.")).toBeDefined();
  });

  it("shows a step pending once this window's check has waited half a second, and a result older than its step's cadence with its age", async () => {
    const threeHoursBefore = new Date(Date.parse(MANUAL_CLOCK_START) - 3 * 3_600_000).toISOString();
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { account: { checkedAt: threeHoursBefore } } }] });
    await screen.findByText(NO_SESSION);
    const release = app.environment("desk").holdSetupChecks();
    const pane = await setupPane(app);
    await waitFor(() => expect(app.environment("desk").requests("setup.check").length).toBeGreaterThan(0));
    expect(within(pane).queryByText("Checking…")).toBeNull();

    act(() => app.clock.advance(SETUP_PENDING_MS));
    expect(await within(pane).findAllByText("Checking…")).toHaveLength(11);

    release();
    expect(await within(pane).findByText("Every setting it writes holds a valid value. (checked 3 h ago)")).toBeDefined();
    expect(within(pane).queryByText("Checking…")).toBeNull();
    expect(within(pane).getByText("The containment default can be enforced here. Each denylist section holds its presets, or was emptied on purpose. The environment runs as a non-root user.")).toBeDefined();
  });
});

/** Each row of the Settings rail that shows a health dot, and the dot's state, by the row's label. */
const railDots = () =>
  within(within(settings()).getByRole("navigation", { name: "Settings rows" }))
    .queryAllByRole("img")
    .map((dot) => dot.getAttribute("aria-label"));

describe("health dots", () => {
  it("show on home rows only, each the worst state of the steps homed there, the Set up row the worst of all, and follow the environment the last environment pane picked", async () => {
    const app = await twoEnvironments();
    await openSettings(app);
    await waitFor(() =>
      expect(railDots()).toEqual([
        "Set up: needs attention",
        "Accounts: done",
        "Permissions: needs attention",
        "Browser: skipped",
        "Forges: done",
        "Your machines: done",
        "Theme: done",
      ]),
    );

    // An environment pane picks laptop: the dots follow it, whose results its stream carries.
    const accounts = within(settings()).getByRole("region", { name: "Set up" });
    await app.user.selectOptions(within(accounts).getByRole("combobox", { name: "Environment" }), "laptop");
    await waitFor(() =>
      expect(railDots()).toEqual([
        "Set up: needs attention",
        "Accounts: done",
        "Permissions: done",
        "Browser: done",
        "Forges: done",
        "Your machines: done",
        "Theme: needs attention",
      ]),
    );
    expect(within(within(settings()).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Theme" })).toBeDefined();
  });
});

describe("the header's Set up line", () => {
  it("shows while a step needs attention on the home environment, opens the Set up pane on it, and goes once none does", async () => {
    const app = await twoEnvironments();
    const header = screen.getByRole("banner");
    const line = await within(header).findByRole("button", { name: "Set up on desk: 1 step needs attention (Permissions)" });
    // laptop's Appearance needs attention too, but laptop is not the home environment.
    expect(within(header).queryByText(/laptop/)).toBeNull();

    await app.user.click(line);
    const pane = within(settings()).getByRole("region", { name: "Set up" });
    expect(pickedIn(pane)).toBe("desk");
    app.environment("desk").setSetup({ permissions: {} });
    await app.user.click(within(pane).getByRole("button", { name: "Re-run" }));
    expect(await within(pane).findByText("Every step desk checks passes.")).toBeDefined();
    expect(within(header).queryByRole("button", { name: /^Set up on/ })).toBeNull();
  });
});

describe("an environment the checklist cannot reach", () => {
  it("marks each result it holds stale, dated, beneath the line saying since when, on the pane's rows and on the card", async () => {
    const tenMinutesBefore = new Date(Date.parse(MANUAL_CLOCK_START) - 10 * 60_000).toISOString();
    const app = await renderApp({
      environments: [
        { name: "desk", reach: "local" },
        {
          name: "laptop",
          reach: "paired",
          capabilities: ["setup"],
          setup: onlySteps({
            ...PASSING,
            permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"], checkedAt: tenMinutesBefore },
          }),
        },
      ],
    });
    await screen.findByText(NO_SESSION);
    const pane = await setupPane(app);
    await app.user.selectOptions(within(pane).getByRole("combobox", { name: "Environment" }), "laptop");
    expect(await within(pane).findByText("5 done, 1 needs attention, 0 skipped")).toBeDefined();
    expect(paneSteps(pane)).toContainEqual(["Permissions", "needs attention", "The denylist lost 2 presets."]);

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(pane).findByText(/^laptop has not been reached since \d\d:\d\d: its results are from before\.$/)).toBeDefined();
    expect(within(pane).getByText("5 done, 1 needs attention, 0 skipped")).toBeDefined();
    expect(paneSteps(pane).filter(([, state]) => state !== null)).toEqual([
      ["Account", "done", "Every setting it writes holds a valid value. (stale, checked just now)"],
      ["Your machines", "done", expect.stringMatching(/^The environment runs as a non-root user\. .* \(stale, checked just now\)$/)],
      ["Forges", "done", expect.stringMatching(/ \(stale, checked just now\)$/)],
      ["Browser", "done", expect.stringMatching(/ \(stale, checked just now\)$/)],
      ["Permissions", "needs attention", "The denylist lost 2 presets. (stale, checked 10 min ago)"],
      ["Appearance", "done", expect.stringMatching(/ \(stale, checked just now\)$/)],
    ]);

    await app.user.click(within(pane).getByRole("button", { name: "Open the full checklist" }));
    await app.user.click(within(steps()).getByRole("button", { name: "Permissions" }));
    const shown = checklist() as HTMLElement;
    expect(within(shown).getByText(/^laptop has not been reached since \d\d:\d\d: its results are from before\.$/)).toBeDefined();
    expect(within(within(shown).getByRole("region", { name: "Permissions" })).getByText("The denylist lost 2 presets. (stale, checked 10 min ago)")).toBeDefined();
  });

  it("says since when, its results kept beneath, and offers this machine's environment, its service down, a start", async () => {
    // With the setup flag, the results come on the environment's stream, which the runtime keeps across a restart.
    const first = await renderApp({
      environments: [{ name: "desk", reach: "local", environmentId: "0199aa00-0000-7000-8000-00000000d35c", capabilities: ["setup"], setup: onlySteps(PASSING) }],
    });
    await screen.findByText(NO_SESSION);
    await openSettings(first);
    await waitFor(() => expect(railDots()).toContain("Permissions: done"));
    first.environment("desk").discovery("nothing");
    const app = await first.remount();
    app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));

    const pane = await setupPane(app);
    expect(await within(pane).findByText("desk is not running: its results are from before it stopped.")).toBeDefined();
    expect(within(pane).getByText("6 done, 0 need attention, 0 skipped")).toBeDefined();
    await app.user.click(within(pane).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(pane).queryByText(/is not running/)).toBeNull());
    expect(app.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
  });
});
