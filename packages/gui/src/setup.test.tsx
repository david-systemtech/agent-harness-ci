import { act, screen, waitFor, within } from "@testing-library/react";
import { SETUP_PENDING_MS, clockTime } from "@agent-harness/client-runtime";
import { MANUAL_CLOCK_START } from "@agent-harness/client-runtime/testing";
import { SETTINGS, STEP_ORDER, denylistPresets } from "@agent-harness/contracts";
import { TOKEN_NAMES } from "@agent-harness/theme";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment, type ScriptedSetup } from "../test/harness.js";
import { StepStatus } from "./setup/step-status.js";
import type { StepCardProps } from "./setup/cards.js";

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
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

it("numbers all eleven steps with an outcome hint and distinguishes required from optional", async () => {
  await firstLaunch();
  const rows = within(steps()).getAllByRole("listitem");
  const hints = ["Sign in to Claude", "Bring your past chats", "Use it from other devices", "Connect GitHub and others", "Use your key manager", "A notebook agents keep", "Ready-made agent skills", "Notes every agent reads", "Let agents use Chrome", "When agents must ask", "Light, dark and colours"];
  expect(rows).toHaveLength(11);
  for (const [index, row] of rows.entries()) {
    expect(within(row).getByText(String(index + 1))).toBeDefined();
    expect(within(row).getByText(hints[index] as string)).toBeDefined();
    expect(within(row).getByText(index === 0 ? "Required" : "Optional")).toBeDefined();
  }
  expect(within(screen.getByRole("region", { name: "Account" })).getByText(hints[0] as string)).toBeDefined();
});

it("shows a pending scheduled read as neutral checking and leaves it out of the header attention count", async () => {
  const app = await firstLaunch({ capabilities: ["setup"], setup: onlySteps({
    "your-machines": { state: "pending", reason: "Waiting for the first release channel read." },
    permissions: { state: "needs-attention", reason: "Containment is unavailable." },
  }) });
  const dot = await within(steps()).findByRole("img", { name: "Your machines: Checking" });
  expect(dot.className).toContain("bg-ink-faint");
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
  expect(await screen.findByRole("button", { name: "Set up: 1 needs attention" })).toBeDefined();
  const pane = await setupPane(app);
  expect(await within(pane).findByText("0 done, 1 needs attention, 0 skipped, 1 checking")).toBeDefined();
});

it("counts a bank awaiting owner review as done and shows its review URL in the step's line", async () => {
  const reason = "team-memory is landed and awaiting your review: https://git.example.test/team/memory/pulls/7.";
  const app = await firstLaunch({ capabilities: ["setup"], setup: onlySteps({ "memory-bank": { state: "done", reason } }) });
  expect(await within(steps()).findByRole("img", { name: "Memory bank: Done" })).toBeDefined();
  await app.user.click(within(steps()).getByRole("button", { name: "Memory bank" }));
  expect(await within(checklist() as HTMLElement).findByText(reason)).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
  expect(await within(await setupPane(app)).findByText("1 done, 0 need attention, 0 skipped")).toBeDefined();
});

describe("the first-launch mark", () => {
  it("is set by closing Set up, so the next launch opens on the window, and the Set up pane's Open the full checklist brings it back", async () => {
    const app = await firstLaunch();
    await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
    await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
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
    // Continue past Account waits on a signed-in account on first launch (#575).
    const app = await firstLaunch({ accounts: [{ label: "personal" }] });
    const card = () => within(checklist() as HTMLElement).getAllByRole("region")[0] as HTMLElement;
    const walked: string[] = [];
    while (within(card()).queryByRole("button", { name: "Continue" }) !== null) {
      walked.push(within(card()).getByRole("heading", { level: 2 }).textContent ?? "");
      await app.user.click(within(card()).getByRole("button", { name: "Continue" }));
    }
    expect(walked).toEqual(["Account", "Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions"]);
    expect(within(card()).getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
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

    const again = await app.remount();
    await again.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
    await waitFor(() => expect(within(steps()).getByRole("img", { name: "Account: Done" })).toBeDefined());
  });
});

it("walks eleven steps in both directions and keeps Skip visible but disabled on Account", async () => {
  const app = await firstLaunch({ accounts: [{ label: "personal" }] });
  const back = () => screen.getByRole("button", { name: "Back" });
  expect(back().hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true);
  for (const label of ["Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions", "Appearance"]) {
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeDefined();
    expect(back().hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
  }
  expect(screen.getByRole("button", { name: "Finish" })).toBeDefined();
  for (const label of ["Permissions", "Browser", "Instructions", "Skills", "Memory bank", "Key manager", "Forges", "Your machines", "Carry over", "Account"]) {
    await app.user.click(back());
    expect(screen.getByRole("heading", { name: label, level: 2 })).toBeDefined();
  }
  expect(back().hasAttribute("disabled")).toBe(true);
});

describe("Skip for now", () => {
  it("is on a skippable step's card beside Continue, moves the rail to the next step and records nothing", async () => {
    // Continue past Account waits on a signed-in account on first launch (#575).
    const app = await firstLaunch({ accounts: [{ label: "personal" }] });
    const desk = app.environment("desk");
    const card = () => within(checklist() as HTMLElement).getAllByRole("region")[0] as HTMLElement;
    const skippable: string[] = [];
    while (within(card()).queryByRole("button", { name: "Continue" }) !== null) {
      if (!within(card()).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")) skippable.push(within(card()).getByRole("heading", { level: 2 }).textContent ?? "");
      await app.user.click(within(card()).getByRole("button", { name: "Continue" }));
    }
    // Every step after Account may be left for later; this navigation does not change the health skip rules.
    expect(skippable).toEqual(["Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions"]);

    await app.user.click(within(steps()).getByRole("button", { name: "Forges" }));
    const commands = () => desk.requests().filter((request) => request.params["commandId"] !== undefined).length;
    const sent = { commands: commands(), checks: desk.requests("setup.check").length };
    await app.user.click(within(card()).getByRole("button", { name: "Skip for now" }));
    expect(within(card()).getByRole("heading", { level: 2 }).textContent).toBe("Key manager");
    expect(within(steps()).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(within(card()).getByRole("button", { name: "Skip for now" }));
    expect(within(card()).getByRole("heading", { level: 2 }).textContent).toBe("Memory bank");
    expect({ commands: commands(), checks: desk.requests("setup.check").length }).toEqual(sent);

    // Nothing was recorded, the first-launch mark included: the next launch opens Set up again.
    const again = await app.remount();
    await again.user.click(await screen.findByRole("button", { name: "Begin set up" }));
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
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);

describe("the Set up pane", () => {
  it("shows a step's whole line on keyboard focus as well as on hover, for a line the list cuts short at a narrow width", async () => {
    const app = await twoEnvironments();
    const pane = await setupPane(app);
    await within(pane).findByText("4 done, 1 needs attention, 1 skipped");
    const permissions = within(within(pane).getByRole("list", { name: "Steps" })).getAllByRole("listitem").find((item) => within(item).getByRole("button").textContent === "Permissions");
    const line = permissions?.lastElementChild as HTMLElement;
    expect(line.className.split(" ")).toContain("truncate");
    expect(line.tabIndex).toBe(0);
    act(() => line.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("The denylist lost 2 presets.");
  });

  it("names the environment it checks with a picker, and lists each step with its dot and line, linking to its home row, and the counts", async () => {
    const app = await twoEnvironments();
    const pane = await setupPane(app);
    expect(pickedIn(pane)).toBe("desk");
    expect(await within(pane).findByText("4 done, 1 needs attention, 1 skipped")).toBeDefined();
    expect(paneSteps(pane)).toEqual([
      ["Account", "Done", "All your accounts are signed in."],
      ["Carry over", null, "Not checked yet."],
      ["Your machines", "Done", "This computer is ready."],
      ["Forges", "Done", "Your forges are connected."],
      ["Key manager", null, "Not checked yet."],
      ["Memory bank", null, "Not checked yet."],
      ["Skills", null, "Not checked yet."],
      ["Instructions", null, "Not checked yet."],
      ["Browser", "Not set up", "No Chrome is paired."],
      ["Permissions", "Needs a fix", "The denylist lost 2 presets."],
      ["Appearance", "Done", "Your theme is easy to read."],
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

describe("a step's pane", () => {
  it("checks the steps it is home to as it opens, on the environments it shows, the results held showing meanwhile", async () => {
    const app = await twoEnvironments();
    const desk = app.environment("desk");
    const laptop = app.environment("laptop");
    await openSettings(app);
    await waitFor(() => expect(railDots()).toContain("Permissions: Needs a fix"));
    const rows = within(within(settings()).getByRole("navigation", { name: "Settings rows" }));
    const asked = (environment: typeof desk) => environment.requests("setup.check").map((request) => request.params);
    const before = { desk: asked(desk).length, laptop: asked(laptop).length };
    const release = desk.holdSetupChecks();

    // An environment row, on the environment picked: its step alone, its dot held meanwhile.
    await app.user.click(rows.getByRole("button", { name: "Permissions" }));
    await waitFor(() => expect(asked(desk).slice(before.desk)).toEqual([{ step: "permissions" }]));
    expect(railDots()).toContain("Permissions: Needs a fix");
    // Accounts is home to Account and Carry over: both.
    await app.user.click(rows.getByRole("button", { name: "Accounts" }));
    await waitFor(() => expect(asked(desk).slice(before.desk)).toEqual([{ step: "permissions" }, { step: "account" }, { step: "carry-over" }]));
    // A client row, on the home environment; an everywhere row, on every environment.
    await app.user.click(rows.getByRole("button", { name: "Theme" }));
    await waitFor(() => expect(asked(desk).slice(before.desk).at(-1)).toEqual({ step: "appearance" }));
    await app.user.click(rows.getByRole("button", { name: "Your machines" }));
    await waitFor(() => expect(asked(desk).slice(before.desk).at(-1)).toEqual({ step: "your-machines" }));
    await waitFor(() => expect(asked(laptop).slice(before.laptop)).toEqual([{ step: "your-machines" }]));
    // A row no step lives on checks nothing.
    const count = asked(desk).length;
    await app.user.click(rows.getByRole("button", { name: "Service" }));
    expect(asked(desk)).toHaveLength(count);
    release();
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
    // The Permissions card asks once, as a section's Restore presets does (#594).
    await app.user.click(within(await screen.findByRole("dialog", { name: "Restore the presets the denylist lost?" })).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Restored the denylist's presets: 2 put back.")).toBeDefined();
    expect(await within(steps()).findByRole("img", { name: "Permissions: Done" })).toBeDefined();
    expect(within(permissions).getByText(/^Set\./)).toBeDefined();
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
        reason: "Checking took too long. Choose Check again.",
        failing: ["your-machines.release-channel"],
        actions: ["check-again", "set-up-this-machine"],
        targets: [{ action: "set-up-this-machine", kind: "environment", id: laptop.environmentId, label: "laptop" }],
        lastGood: { state: "done", reason: "The release channel was read.", checkedAt: new Date(app.clock.now().getTime() - 2 * 3_600_000).toISOString() },
      },
    });

    const machines = await cardOf(app, "Your machines");
    expect(await within(machines).findByText("Checking took too long. Choose Check again.")).toBeDefined();
    expect(within(machines).getByText("Last good, checked 2 h ago: The release channel was read.")).toBeDefined();
    expect(within(machines).queryByRole("button", { name: "Check now" })).toBeNull();
    const asked = desk.requests("setup.check").length;
    await app.user.click(within(machines).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(desk.requests("setup.check")).toHaveLength(asked + 1));
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "your-machines" });

    await app.user.click(within(machines).getByRole("button", { name: "Set up this machine: laptop" }));
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

describe("a step's named actions on their targets", () => {
  it("sign in again opens the sign-in of the account it names, one button an account, and a forge account's the Forges row", async () => {
    const app = await renderApp({
      environments: [
        {
          name: "desk",
          reach: "local",
          accounts: [
            { id: "account-work", label: "Work", status: { state: "signed-out", checkedAt: null, detail: null } },
            { id: "account-home", label: "Home", status: { state: "expired", checkedAt: null, detail: null } },
          ],
          setup: {
            account: {
              state: "needs-attention",
              reason: "Work is signed out and Home has expired.",
              failing: ["account.signed-in"],
              actions: ["sign-in-again"],
              targets: [
                { action: "sign-in-again", kind: "account", id: "account-work", label: "Work" },
                { action: "sign-in-again", kind: "account", id: "account-home", label: "Home" },
              ],
            },
            forges: {
              state: "needs-attention",
              reason: "david on git.example.com answers as someone else.",
              failing: ["forges.identity"],
              actions: ["sign-in-again", "check-again"],
              targets: [{ action: "sign-in-again", kind: "forge-account", id: "https://git.example.com", label: "david on git.example.com" }],
            },
          },
        },
      ],
    });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    const account = await cardOf(app, "Account");
    expect(await within(account).findByRole("button", { name: "Sign in again: Home" })).toBeDefined();
    await app.user.click(within(account).getByRole("button", { name: "Sign in again: Work" }));
    expect(await screen.findByRole("dialog", { name: "Sign in: Work on desk" })).toBeDefined();
    await waitFor(() => expect(desk.requests("accounts.signin.start").map((request) => request.params["accountId"])).toEqual(["account-work"]));

    await app.user.click(screen.getByRole("button", { name: "Cancel the sign-in" }));
    await app.user.click(within(steps()).getByRole("button", { name: "Forges" }));
    const forges = within(checklist() as HTMLElement).getByRole("region", { name: "Forges" });
    await app.user.click(within(forges).getByRole("button", { name: "Sign in again: david on git.example.com" }));
    expect(within(settings()).getByRole("region", { name: "Forges" })).toBeDefined();
  });

  it("restore puts back the presets of the denylist sections it names alone, and update is Update now on Your machines", async () => {
    const presets = denylistPresets("/home");
    const app = await renderApp({
      environments: [
        {
          name: "desk",
          reach: "local",
          setup: {
            permissions: {
              state: "needs-attention",
              reason: "The paths section of the denylist is missing 1 of its presets (~/.ssh); Restore puts them back.",
              failing: ["permissions.denylist"],
              actions: ["restore"],
              targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }],
            },
            "your-machines": {
              state: "needs-attention",
              reason: "A failed update left this machine behind.",
              failing: ["your-machines.updates"],
              actions: ["update"],
            },
          },
          lostPresets: [presets.paths[0]!.id, presets.commandPatterns[0]!.id],
          updates: { status: { version: "1.2.0", newest: "1.3.0" } },
        },
      ],
    });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");

    const permissions = await cardOf(app, "Permissions");
    await app.user.click(within(permissions).getByRole("button", { name: "Restore: paths" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Restore the presets Paths lost?" })).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Restored the denylist's presets: 1 put back.")).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params["sections"])).toEqual([["paths"]]);

    await app.user.click(within(steps()).getByRole("button", { name: "Your machines" }));
    const machines = within(checklist() as HTMLElement).getByRole("region", { name: "Your machines" });
    // The step's action, drawn above each machine card's own (#576).
    await app.user.click(within(machines).getAllByRole("button", { name: "Update now" })[0] as HTMLElement);
    expect(await within(machines).findByText("Updating to 1.3.0 once desk is idle.")).toBeDefined();
    expect(desk.requests("updates.apply").map((request) => request.params["when"])).toEqual(["idle"]);
  });

  it("pulls every named source on the checked environment and reports each sync, continuing after a refusal", async () => {
    const ids = ["0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5b-d9cb-469f-a165-70867728950f", "0f8fad5b-d9cb-469f-a165-708677289510"];
    const labels = ["team-skills", "house-skills", "work-skills"];
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", setup: { skills: {
      state: "needs-attention", reason: "Three sources need a pull.", failing: ["skills.sources-synced"], actions: ["pull-now"],
      targets: ids.map((id, i) => ({ action: "pull-now", kind: "skill-source", id, label: labels[i]! })),
    } } }] }, { stepCards: { skills: StepStatus } });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    desk.wire.answer("skills.sources.pull", (params) => {
      if (params.sourceId === ids[0]) return { error: { code: "not_found", message: "The source was removed.", data: { kind: "source" } } };
      const since = app.clock.now().toISOString();
      const sync = params.sourceId === ids[1] ? { outcome: "failed", since, problem: "network", line: "Could not reach the repository." } : { outcome: "ok", since };
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { source: {
        id: params.sourceId, url: "https://git.example.test/team/skills", identity: "https://git.example.test/team/skills", folder: ".",
        follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: "desk" }, addedAt: since,
        commit: "c".repeat(40), skillCount: 1, sync, attemptedAt: since,
      } } } };
    });
    const skills = await cardOf(app, "Skills");
    await app.user.click(within(skills).getByRole("button", { name: "Pull now: team-skills, house-skills, work-skills" }));
    expect(await within(skills).findByText("team-skills: Not pulled: The source was removed. house-skills: Not pulled: Could not reach the repository. work-skills: Source pulled.")).toBeDefined();
    expect(desk.requests("skills.sources.pull").map((request) => request.params.sourceId)).toEqual(ids);
    expect(new Set(desk.requests("skills.sources.pull").map((request) => request.params.commandId)).size).toBe(3);
    expect(checklist()).not.toBeNull();
  });

  it.each(["install", "update"] as const)("runs a named tool's %s in a terminal on its card and accepts its prompt", async (action) => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired", capabilities: ["managedTools"],
      managedTools: { runs: { gh: { password: "password-for-tests", command: "sudo brew install gh" } } },
      setup: { forges: { state: "needs-attention", reason: "gh needs attention.", failing: ["forges.gh"], actions: [action],
        targets: [{ action, kind: "tool", id: "gh", label: "gh" }],
      } },
    }] });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("laptop");
    await cardOf(app, "Forges");
    await app.user.selectOptions(within(checklist() as HTMLElement).getByRole("combobox", { name: "Environment" }), "laptop");
    const forges = within(checklist() as HTMLElement).getByRole("region", { name: "Forges" });
    await app.user.click(within(forges).getByRole("button", { name: `${action === "install" ? "Install" : "Update"} gh in a tool terminal` }));
    const terminal = await within(forges).findByRole("region", { name: `${action === "install" ? "Installing" : "Updating"} GitHub CLI` });
    expect(desk.requests("tools.run").map((request) => request.params)).toEqual([{ commandId: expect.any(String), id: expect.any(String), tool: "gh", action }]);
    await waitFor(() => expect(terminal.textContent).toContain("[sudo] password for milo:"));
    act(() => (terminal.querySelector("textarea") as HTMLTextAreaElement).focus());
    await app.user.keyboard("password-for-tests{Enter}");
    expect(await within(terminal).findByText("· exit 0")).toBeDefined();
    expect(desk.requests("terminals.write").length).toBeGreaterThan(0);
    await app.user.click(within(terminal).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(desk.requests("terminals.close")).toHaveLength(1));
    expect(checklist()).not.toBeNull();
  });

  it("shows a named tool's refusal and its vendor command without opening a terminal", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["managedTools"],
      managedTools: { runs: { gh: { refused: { message: "No supported install method.", command: "brew install gh" } } } },
      setup: { forges: { state: "needs-attention", reason: "gh is missing.", failing: ["forges.gh"], actions: ["install"],
        targets: [{ action: "install", kind: "tool", id: "gh", label: "gh" }],
      } },
    }] });
    await screen.findByText(NO_SESSION);
    const forges = await cardOf(app, "Forges");
    await app.user.click(within(forges).getByRole("button", { name: "Install gh in a tool terminal" }));
    expect(await within(forges).findByText("Not run: No supported install method.")).toBeDefined();
    expect(within(forges).getByText("brew install gh")).toBeDefined();
    expect(within(forges).queryByRole("region", { name: "Installing GitHub CLI" })).toBeNull();
    expect(app.environment("desk").requests("terminals.subscribe")).toHaveLength(0);
  });

  it("dims named pulls and tool runs without admin and says why, sending neither", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["managedTools"], scopes: ["read"], setup: {
      skills: { state: "needs-attention", reason: "The source needs a pull.", failing: ["skills.sources-synced"], actions: ["pull-now"],
        targets: [{ action: "pull-now", kind: "skill-source", id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "team-skills" }],
      },
      forges: { state: "needs-attention", reason: "gh is missing.", failing: ["forges.gh"], actions: ["install"],
        targets: [{ action: "install", kind: "tool", id: "gh", label: "gh" }],
      },
    } }] }, { stepCards: { skills: StepStatus } });
    await screen.findByText(NO_SESSION);
    const skills = await cardOf(app, "Skills");
    const pull = within(skills).getByRole("button", { name: "Pull now: team-skills" });
    expect(pull).toHaveProperty("disabled", true);
    expect(within(skills).getByText(/admin/)).toBeDefined();
    await app.user.click(pull);
    await app.user.click(within(steps()).getByRole("button", { name: "Forges" }));
    const forges = within(checklist() as HTMLElement).getByRole("region", { name: "Forges" });
    const install = within(forges).getByRole("button", { name: "Install gh in a tool terminal" });
    expect(install).toHaveProperty("disabled", true);
    expect(within(forges).getByText(/admin/)).toBeDefined();
    await app.user.click(install);
    expect(app.environment("desk").requests("skills.sources.pull")).toHaveLength(0);
    expect(app.environment("desk").requests("tools.run")).toHaveLength(0);
  });

  it("opens the step's home row for a verb whose card is not registered in this build, naming each item it applies to, and the step's card takes the authoring and import verbs", async () => {
    const app = await renderApp({
      environments: [
        {
          name: "desk",
          reach: "local",
          setup: {
            "memory-bank": {
              state: "needs-attention",
              reason: "The describe conversation stopped before BANK.md was written.",
              failing: ["memory-bank.manifest"],
              actions: ["try-again", "start-over"],
              targets: [{ action: "try-again", kind: "session", id: "0199aa00-0000-7000-8000-0000000000b1", label: "Describe work-memory" }],
            },
          },
        },
      ],
    });
    await screen.findByText(NO_SESSION);

    const bank = await cardOf(app, "Memory bank");
    expect(within(bank).getByRole("button", { name: "Start over" })).toBeDefined();
    await app.user.click(within(bank).getByRole("button", { name: "Try again: Describe work-memory" }));
    expect(within(settings()).getByRole("region", { name: "Memory banks" })).toBeDefined();
  });
});

describe("a card registered for a step", () => {
  it("replaces the fallback card for that step alone, under the step's name and dot, with the checklist's Continue", async () => {
    const PermissionsCard = ({ environmentId, step }: StepCardProps) => (
      <p>
        The Permissions card on {environmentId}: {step.result?.reason}
      </p>
    );
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { stepCards: { permissions: PermissionsCard } });
    await screen.findByText(NO_SESSION);
    const permissions = await cardOf(app, "Permissions");
    const desk = app.environment("desk").environmentId;
    expect(await within(permissions).findByText(new RegExp(`^The Permissions card on ${desk}: Set\\.`))).toBeDefined();
    expect(within(permissions).queryByRole("button", { name: "Check now" })).toBeNull();
    expect(within(permissions).getByRole("img", { name: "Permissions: Done" })).toBeDefined();
    expect(within(permissions).getByRole("button", { name: "Continue" })).toBeDefined();

    await app.user.click(within(steps()).getByRole("button", { name: "Appearance" }));
    const appearance = within(checklist() as HTMLElement).getByRole("region", { name: "Appearance" });
    expect(within(appearance).getByRole("button", { name: "Check now" })).toBeDefined();
  });
});

describe("a check's time", () => {
  it("says a last good result checked under a minute ago was checked just now", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await screen.findByText(NO_SESSION);
    app.environment("desk").setSetup({
      "your-machines": {
        state: "needs-attention",
        reason: "Checking took too long. Choose Check again.",
        failing: ["your-machines.release-channel"],
        actions: ["check-again"],
        lastGood: { state: "done", reason: "The release channel was read.", checkedAt: new Date(app.clock.now().getTime() - 20_000).toISOString() },
      },
    });
    const machines = await cardOf(app, "Your machines");
    expect(await within(machines).findByText("Last good, checked just now: The release channel was read.")).toBeDefined();
  });

  // A poll time read on a phone broke inside its date and said milliseconds in UTC (#1742).
  it("says a time a result's reason names where this window is, its age and its clock time, never the environment's UTC timestamp", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    await screen.findByText(NO_SESSION);
    const polledAt = new Date(app.clock.now().getTime() - 2 * 3_600_000 - 5 * 60_000).toISOString();
    app.environment("desk").setSetup({
      "your-machines": {
        state: "needs-attention",
        reason: `The host-side updater last polled more than an hour ago, at ${polledAt.slice(0, 10)} ${polledAt.slice(11, 16)} UTC: check that it still runs on the Docker host.`,
        failing: ["your-machines.host-updater"],
        actions: ["check-again"],
        times: [{ text: `more than an hour ago, at ${polledAt.slice(0, 10)} ${polledAt.slice(11, 16)} UTC`, at: polledAt }],
      },
    });
    const machines = await cardOf(app, "Your machines");
    const line = await within(machines).findByText(/^The host-side updater last polled 2 h ago, at /);
    expect(line.textContent).toMatch(new RegExp(`at (\\S+\u00a0)*${clockTime(polledAt)}: check that it still runs on the Docker host\\.`));
    expect(line.textContent).not.toMatch(/UTC|\d-\d/);
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
    expect(await within(pane).findByText("All your accounts are signed in. (checked 3 h ago)")).toBeDefined();
    expect(within(pane).queryByText("Checking…")).toBeNull();
    expect(within(pane).getByText("Set.")).toBeDefined();
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
        "Set up: Needs a fix",
        "Accounts: Done",
        "Permissions: Needs a fix",
        "Browser: Not set up",
        "Forges: Done",
        "Your machines: Done",
        "Theme: Done",
      ]),
    );

    // An environment pane picks laptop: the dots follow it, whose results its stream carries.
    const accounts = within(settings()).getByRole("region", { name: "Set up" });
    await app.user.selectOptions(within(accounts).getByRole("combobox", { name: "Environment" }), "laptop");
    await waitFor(() =>
      expect(railDots()).toEqual([
        "Set up: Needs a fix",
        "Accounts: Done",
        "Permissions: Done",
        "Browser: Done",
        "Forges: Done",
        "Your machines: Done",
        "Theme: Needs a fix",
      ]),
    );
    expect(within(within(settings()).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Theme" })).toBeDefined();
  });
});

describe("a result this window did not ask for", () => {
  it("turns the rail's dot, the pane's row and the header's line as the environment publishes it, with no call and no pending, the row saying since when it is unchanged", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"], setup: onlySteps(PASSING) }] });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    const pane = await setupPane(app);
    await waitFor(() => expect(railDots()).toContain("Permissions: Done"));
    expect(await within(pane).findByText("6 done, 0 need attention, 0 skipped")).toBeDefined();
    const asked = desk.requests("setup.check").length;

    // Another client's check, or the environment's own pass: its result arrives as a notice.
    desk.setSetup({ permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] } });
    act(() => app.clock.advance(SETUP_PENDING_MS));
    desk.passSetup(["permissions"]);
    const passed = clockTime(app.clock.now().toISOString());
    await waitFor(() => expect(railDots()).toContain("Permissions: Needs a fix"));
    expect(railDots()[0]).toBe("Set up: Needs a fix");
    expect(await within(pane).findByText("5 done, 1 needs attention, 0 skipped")).toBeDefined();
    // A re-check that finds nothing new is never heard, so the line says since when it is unchanged rather than how old it is.
    expect(paneSteps(pane)).toContainEqual(["Permissions", "Needs a fix", `The denylist lost 2 presets. (unchanged since ${passed})`]);
    // The header continues to update behind Settings, which hides background controls from assistive technology.
    expect(screen.getByText("Set up: 1 needs attention")).toBeDefined();
    expect(screen.queryByText("Checking…")).toBeNull();
    expect(desk.requests("setup.check")).toHaveLength(asked);
  });

  it("shows no pending while it is awaited, and this window's Check now pending after half a second on its step alone", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"], setup: onlySteps(PASSING) }] });
    await screen.findByText(NO_SESSION);
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    expect(await within(permissions).findByText(/^Set\./)).toBeDefined();
    const release = desk.holdSetupChecks();

    await app.user.click(within(permissions).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "permissions" }));
    act(() => app.clock.advance(SETUP_PENDING_MS - 1));
    expect(within(permissions).queryByText("Checking…")).toBeNull();
    act(() => app.clock.advance(1));
    expect(await within(permissions).findByText("Checking…")).toBeDefined();
    await app.user.click(within(steps()).getByRole("button", { name: "Appearance" }));
    expect(within(within(checklist() as HTMLElement).getByRole("region", { name: "Appearance" })).getByText(/^Your theme is easy to read\./)).toBeDefined();

    await app.user.click(within(steps()).getByRole("button", { name: "Permissions" }));
    release();
    const again = within(checklist() as HTMLElement).getByRole("region", { name: "Permissions" });
    expect(await within(again).findByText(/^Set\./)).toBeDefined();
    expect(within(again).queryByText("Checking…")).toBeNull();
  });
});

describe("the header's Set up line", () => {
  it("shows in amber alone while a step needs attention on the home environment, opens the Set up pane on it, and goes once none does", async () => {
    const app = await twoEnvironments();
    const header = screen.getByRole("banner");
    const line = await within(header).findByRole("button", { name: "Set up: 1 needs attention" });
    // Tailwind's stylesheet order, rather than className order, decides between conflicting colours.
    expect([...line.classList].filter((name) => TOKEN_NAMES.some((token) => name === `text-${token}`))).toEqual(["text-amber"]);
    // laptop's Appearance needs attention too, but laptop is not the home environment.
    expect(within(header).queryByText(/laptop/)).toBeNull();

    await app.user.click(line);
    const pane = within(settings()).getByRole("region", { name: "Set up" });
    expect(pickedIn(pane)).toBe("desk");
    app.environment("desk").setSetup({ permissions: {} });
    await app.user.click(within(pane).getByRole("button", { name: "Re-run" }));
    expect(await within(pane).findByText("Every step desk checks passes.")).toBeDefined();
    expect(within(header).queryByRole("button", { name: /^Set up:/ })).toBeNull();
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
    expect(paneSteps(pane)).toContainEqual(["Permissions", "Needs a fix", "The denylist lost 2 presets."]);

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(pane).findByText(/^laptop has not been reached since \d\d:\d\d: its results are from before\.$/)).toBeDefined();
    expect(within(pane).getByText("5 done, 1 needs attention, 0 skipped")).toBeDefined();
    expect(paneSteps(pane).filter(([, state]) => state !== null)).toEqual([
      ["Account", "Done", "All your accounts are signed in. (stale, checked just now)"],
      ["Your machines", "Done", "This computer is ready. (stale, checked just now)"],
      ["Forges", "Done", expect.stringMatching(/ \(stale, checked just now\)$/)],
      ["Browser", "Done", expect.stringMatching(/ \(stale, checked just now\)$/)],
      ["Permissions", "Needs a fix", "The denylist lost 2 presets. (stale, checked 10 min ago)"],
      ["Appearance", "Done", expect.stringMatching(/ \(stale, checked just now\)$/)],
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
    await waitFor(() => expect(railDots()).toContain("Permissions: Done"));
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
