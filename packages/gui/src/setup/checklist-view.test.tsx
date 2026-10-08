import { act, screen, waitFor, within } from "@testing-library/react";
import { STEP_HINTS, STEP_LABELS, STEP_ORDER } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../../test/harness.js";
import { STEP_WORDS } from "./step-words.js";

/**
 * The Set up checklist's frame (docs/specs/setup-copy.md §3 "Step page" and
 * §4.4; #1839): the header naming the computer it sets up, the rail's rows
 * with their state words, each card's head, the footer with its reasons as
 * visible text, and the lines while there is no computer or no result yet.
 */

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The rail of steps. */
const rail = () => within(checklist()).getByRole("navigation", { name: "Set up steps" });

/** The card of the step shown, named by the step's label. */
const card = (label: string) => within(checklist()).getByRole("region", { name: label });

/** The footer under the card. */
const footer = () => within(checklist()).getByRole("navigation", { name: "Step navigation" });

/** A first launch on this machine's environment, `desk`, as `given` scripts it, with Set up open over the window. */
const firstLaunch = async (given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

describe("the header", () => {
  it("says Set up, Setting up: with the computer picker in place of Environment, and Close", async () => {
    await firstLaunch();
    const header = checklist().querySelector(":scope > header") as HTMLElement;
    expect(within(header).getByRole("heading", { name: "Set up", level: 1 })).toBeDefined();
    expect(within(header).getByText("Setting up:")).toBeDefined();
    expect(within(within(header).getByRole("combobox", { name: "Setting up" })).getByRole("option", { selected: true }).textContent).toBe("desk");
    expect(within(header).queryByText("Environment")).toBeNull();
    expect(within(header).getByRole("button", { name: "Close Set up" }).textContent).toBe("Close");
  });
});

describe("the rail", () => {
  it("gives each row its number, label, hint, state word and Required or Optional tag, the button described by them", async () => {
    await firstLaunch({ capabilities: ["setup"], setup: {
      "carry-over": { state: "needs-attention", reason: "2 chats could not be read." },
      "your-machines": { state: "skipped", reason: "Only on this computer." },
      forges: { state: "pending", reason: "Waiting for the first read." },
      "key-manager": null,
    } });
    const words = ["Done", "Needs a fix", "Not set up", "Checking", "Not available", "Done", "Done", "Done", "Done", "Done", "Done"];
    await within(rail()).findByRole("button", { name: "Key manager", description: "Use your key manager Not available Optional" });
    const rows = within(rail()).getAllByRole("listitem");
    expect(rows).toHaveLength(11);
    for (const [index, step] of STEP_ORDER.entries()) {
      const row = rows[index] as HTMLElement;
      const tag = index === 0 ? "Required" : "Optional";
      expect(within(row).getByText(String(index + 1))).toBeDefined();
      expect(within(row).getByRole("button", { name: STEP_LABELS[step], description: `${STEP_HINTS[step]} ${words[index]} ${tag}` })).toBeDefined();
      expect(row.querySelector("[data-state-word]")?.textContent).toBe(words[index]);
    }
  });

  it("reads Not checked yet on every row before the computer has given any result", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    const release = app.environment("desk").holdSetupChecks();
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await screen.findByRole("region", { name: "Set up" });
    expect([...rail().querySelectorAll("[data-state-word]")].map((word) => word.textContent)).toEqual(Array(11).fill("Not checked yet"));
    release();
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Account", description: /Done/ })).toBeDefined());
  });
});

describe("a step the computer's version does not have", () => {
  it("reads Not available, and its card says to update the computer in place of the step's controls", async () => {
    const app = await firstLaunch({ capabilities: ["setup"], setup: { "key-manager": null } });
    await app.user.click(await within(rail()).findByRole("button", { name: "Key manager", description: /Not available/ }));
    const shown = card("Key manager");
    expect(within(shown).getByRole("heading", { name: "Use a key manager?", level: 2 })).toBeDefined();
    expect(within(shown).getByText("desk runs an older agent-harness without this step. Update desk to set it up.")).toBeDefined();
    expect(within(shown).getByText("Not available")).toBeDefined();
    expect(within(shown).queryByRole("button", { name: "Check now" })).toBeNull();
    expect(within(footer()).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
  });

  it("is not a step whose result is still on its way while other steps have theirs, which reads Done once it lands", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"], setup: { "key-manager": null } }] }, { firstLaunch: true });
    const release = app.environment("desk").holdSetupChecks();
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Account", description: /Done/ })).toBeDefined());
    const keyManager = () => within(rail()).getByRole("button", { name: "Key manager" });
    expect(keyManager().querySelector("[data-state-word]")?.textContent).not.toBe("Not available");
    await app.user.click(keyManager());
    expect(within(card("Key manager")).queryByText("desk runs an older agent-harness without this step. Update desk to set it up.")).toBeNull();
    app.environment("desk").setSetup({ "key-manager": {} });
    release();
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Key manager", description: /Done/ })).toBeDefined());
  });
});

describe("a card's head", () => {
  it("says Step n of 11, the step's heading, its why line and its What is this? fold, never the rail's hint again", async () => {
    const app = await firstLaunch({ accounts: [{ label: "personal" }] });
    for (const [index, step] of STEP_ORDER.entries()) {
      await app.user.click(within(rail()).getByRole("button", { name: STEP_LABELS[step] }));
      const shown = card(STEP_LABELS[step]);
      const { heading, why, what } = STEP_WORDS[step];
      const intro = shown.querySelector("[data-step-intro]") as HTMLElement;
      expect(within(intro).getByText(`Step ${index + 1} of 11`)).toBeDefined();
      expect(within(intro).getByRole("heading", { name: heading, level: 2 })).toBeDefined();
      expect(within(intro).getByText(why)).toBeDefined();
      if (what === undefined) expect(within(intro).queryByText("What is this?")).toBeNull();
      else {
        await app.user.click(within(intro).getByText("What is this?"));
        expect(await within(intro).findByText(what)).toBeDefined();
      }
      if (STEP_HINTS[step] !== heading) expect(within(shown).queryByText(STEP_HINTS[step])).toBeNull();
    }
  });
});

describe("the footer", () => {
  it("on Account with no one signed in, holds Skip for now and Continue with the reason as visible text beside them", async () => {
    await firstLaunch();
    const reason = "Sign in to continue. Account is the one required step.";
    expect(within(footer()).getByText(reason)).toBeDefined();
    for (const name of ["Skip for now", "Continue"]) {
      const button = within(footer()).getByRole("button", { name, description: reason });
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    expect(within(footer()).getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

  it("on Account with an account signed in, lets Continue go and still says why Skip for now is held", async () => {
    await firstLaunch({ accounts: [{ label: "personal" }] });
    const reason = "Account is the one required step.";
    await waitFor(() => expect(within(footer()).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(within(footer()).getByText(reason)).toBeDefined();
    expect(within(footer()).getByRole("button", { name: "Skip for now", description: reason }).hasAttribute("disabled")).toBe(true);
    expect(within(footer()).queryByText(/Sign in to continue/)).toBeNull();
  });

  it("offers Back, Skip for now and Continue on an optional step with no line, and Finish set up on step 11", async () => {
    const app = await firstLaunch({ accounts: [{ label: "personal" }] });
    await app.user.click(within(rail()).getByRole("button", { name: "Forges" }));
    for (const name of ["Back", "Skip for now", "Continue"]) expect(within(footer()).getByRole("button", { name }).hasAttribute("disabled")).toBe(false);
    expect(within(footer()).queryByText(/required step/)).toBeNull();
    await app.user.click(within(rail()).getByRole("button", { name: "Appearance" }));
    expect(within(footer()).getByRole("button", { name: "Finish set up" })).toBeDefined();
    expect(within(footer()).queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("the lines before there is a step to show", () => {
  it("says it is reading the computer's setup until the first result comes", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
    const release = app.environment("desk").holdSetupChecks();
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    expect((await within(checklist()).findByText("Reading desk's setup…")).getAttribute("role")).toBe("status");
    release();
    await waitFor(() => expect(within(checklist()).queryByText("Reading desk's setup…")).toBeNull());
  });

  it("asks for a computer to set up once there is none", async () => {
    const app = await renderApp({ environments: [{ name: "laptop", reach: "paired" }] });
    await app.user.keyboard("{Control>},{/Control}");
    const settings = await screen.findByRole("region", { name: "Settings" });
    await app.user.click(within(within(settings).getByRole("region", { name: "Set up" })).getByRole("button", { name: "Open the full checklist" }));
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(11);
    await act(async () => { await app.runtime.connections.remove(app.environment("laptop").environmentId); });
    expect(await within(checklist()).findByText("Choose a computer to set up.")).toBeDefined();
    expect(within(checklist()).queryByRole("navigation", { name: "Step navigation" })).toBeNull();
  });
});
