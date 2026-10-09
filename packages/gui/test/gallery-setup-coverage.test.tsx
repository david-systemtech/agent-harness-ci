import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { StepId } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { setupRegionScene } from "../gallery/setup-regions-scene.js";

it("captures the real Account gate with disabled Skip and Continue", async () => {
  const Scene = setupRegionScene("account");
  const view = render(<Scene ladder="dark" />);
  try {
    await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 });
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    expect(within(footer).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(true);
    expect(within(footer).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(within(footer).getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
    expect(screen.getAllByText("Optional")).toHaveLength(10);
  } finally { view.unmount(); }
});

// setup-copy.md §4.4: every state the rail shows at once, as words, and the card of a step the computer's version lacks (#1839).
it("captures the rail with every state a computer's results give, on the card of a step its version does not have", async () => {
  const Scene = setupRegionScene("rail-states");
  const view = render(<Scene ladder="dark" />);
  try {
    const rail = await screen.findByRole("navigation", { name: "Set up steps" });
    await within(rail).findByRole("button", { name: "Key manager", description: / Not available / });
    expect([...rail.querySelectorAll("[data-state-word]")].map((word) => word.textContent)).toEqual([
      "Done", "Needs a fix", "Not set up", "Checking", "Not available", "Done", "Done", "Done", "Done", "Done", "Done",
    ]);
    const card = screen.getByRole("region", { name: "Key manager" });
    expect(within(card).getByText("desk runs an older agent-harness without this step. Update desk to set it up.")).toBeDefined();
    expect(within(screen.getByRole("navigation", { name: "Step navigation" })).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
  } finally { view.unmount(); }
});


// setup-copy.md §5.1's states (#1842): Claude Code found with no account yet, an account signed in, one signed out.
it("captures the Account question with this computer's Claude Code sign-in pre-selected and no account yet", async () => {
  const Scene = setupRegionScene("account-claude-code");
  const view = render(<Scene ladder="dark" />);
  try {
    const choice = await screen.findByRole("radio", { name: "Use the Claude Code sign-in on this computer (reader@example.test)" });
    expect(choice.getAttribute("aria-checked")).toBe("true");
    const question = screen.getByRole("group", { name: "How do you want to sign in?" });
    expect(within(question).getByRole("button", { name: "Use this sign-in" })).toBeDefined();
    expect(screen.getByText("Sign in to continue. Account is the one required step.")).toBeDefined();
  } finally { view.unmount(); }
});

it("captures an Account step with an account signed in, its row with its label, email and state, and Continue let go", async () => {
  const Scene = setupRegionScene("account-signed-in");
  const view = render(<Scene ladder="dark" />);
  try {
    const row = await screen.findByRole("region", { name: "reader@example.test" });
    expect(within(row).getByText("Signed in")).toBeDefined();
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    await waitFor(() => expect(within(footer).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/\/accounts\/reader/)).toBeNull();
  } finally { view.unmount(); }
});

it("captures an Account step with an account signed out and Claude Code on this computer signed out", async () => {
  const Scene = setupRegionScene("account-signed-out");
  const view = render(<Scene ladder="dark" />);
  try {
    expect(await screen.findByText("Claude Code is on this computer but not signed in. Sign in below instead.")).toBeDefined();
    const row = await screen.findByRole("region", { name: "Project" });
    expect(within(row).getByText("Signed out")).toBeDefined();
    expect(within(row).getByRole("button", { name: "Sign in again" })).toBeDefined();
    expect(screen.queryByRole("radio")).toBeNull();
  } finally { view.unmount(); }
});

// setup-copy.md §5.4's never-polled line with its How to set it up open beside it (#1883).
it("captures Your machines' never-polled container line with the host updater's setup open, its commands to copy", async () => {
  const Scene = setupRegionScene("host-updater");
  const view = render(<Scene ladder="dark" />);
  try {
    const machines = await screen.findByRole("region", { name: "Your machines" });
    expect(await within(machines).findByText("This container is not kept up to date yet. Set up the updater on the host computer.")).toBeDefined();
    const sheet = await within(machines).findByRole("region", { name: "Set up the updater on the host computer" });
    expect(sheet.hasAttribute("data-host-updater-setup")).toBe(true);
    expect([...sheet.querySelectorAll("pre")].map((command) => command.textContent)).toEqual([
      "cd /opt/agent-harness && docker compose up -d && chmod +x host-updater.sh",
      "*/5 * * * * /opt/agent-harness/host-updater.sh >>/opt/agent-harness/host-updater.log 2>&1",
    ]);
    expect(within(machines).getByRole("button", { name: "Check again" })).toBeDefined();
  } finally { view.unmount(); }
});

// setup-copy.md §5.11: the Browser card before anything is done, at step 5 with its code, and with its Chrome closed (#1857).
it("captures the Browser card's steps 1 to 4 with no code, step 5 with its code, and a closed Chrome with no Unpair beside its line", async () => {
  for (const [kind, check] of [
    ["browser-step-1", async (card: HTMLElement) => {
      await within(card).findByText("/extension/current");
      expect(within(card).getByRole("img", { name: "Step 1: not done yet" })).toBeDefined();
      expect(within(card).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
    }],
    ["browser-code", async (card: HTMLElement) => {
      expect(((await within(card).findByRole("textbox", { name: "Pairing code" })) as HTMLInputElement).value).toBe("TEST2345");
      expect(within(card).getByRole("timer").textContent).toBe("5 min left");
      expect(within(card).getByText("Chrome found the extension.")).toBeDefined();
    }],
    ["browser-closed", async (card: HTMLElement) => {
      expect(await within(card).findByText("Chrome is closed, so agents cannot use it. Open Chrome. This updates by itself.")).toBeDefined();
      await within(card).findByRole("img", { name: "Step 5: done" });
      expect(within(card).queryByRole("button", { name: /Unpair/ })).toBeNull();
    }],
  ] as const) {
    const Scene = setupRegionScene(kind);
    const view = render(<Scene ladder="dark" />);
    try {
      await check(await screen.findByRole("region", { name: "Browser" }));
    } finally { view.unmount(); }
  }
});

// setup-copy.md §5.10: the Instructions card's Your note, Suggestions and fold, and its unread line with Go to each step (#1856).
it("captures the Instructions card with Your note, Suggestions and Write your own, and its unread line naming the steps with Go to each", async () => {
  const Scene = setupRegionScene("instructions");
  const view = render(<Scene ladder="dark" />);
  try {
    const card = await screen.findByRole("region", { name: "Instructions" });
    const note = await within(card).findByRole("region", { name: "Your note" });
    expect(within(within(note).getByRole("region", { name: "About my setup" })).getByRole("button", { name: "Edit" })).toBeDefined();
    const suggestions = within(card).getByRole("region", { name: "Suggestions" });
    expect(suggestions.querySelector("[data-setup-suggestions]")).not.toBeNull();
    expect((within(suggestions).getByRole("checkbox", { name: "Read code from a fresh checkout" }) as HTMLInputElement).checked).toBe(true);
    expect(within(card).getByRole("button", { name: "Write your own" })).toBeDefined();
    expect(await within(card).findByRole("button", { name: "What agents are told about this computer" })).toBeDefined();
    expect(within(card).queryByRole("button", { name: /^Go to / })).toBeNull();
  } finally { view.unmount(); }
  const Unread = setupRegionScene("instructions-unread");
  const unread = render(<Unread ladder="dark" />);
  try {
    const card = await screen.findByRole("region", { name: "Instructions" });
    expect(await within(card).findByText("agent-harness could not read part of this computer's setup: Forges, Memory bank.")).toBeDefined();
    expect((await within(card).findAllByRole("button", { name: /^Go to / })).map((button) => button.textContent)).toEqual(["Go to Forges", "Go to Memory bank"]);
    expect(card.querySelector("[data-go-to-steps]")).not.toBeNull();
  } finally { unread.unmount(); }
});

it.each<[StepId, string]>([["your-machines", "Your machines"], ["forges", "Forges"], ["key-manager", "Key manager"], ["instructions", "Instructions"], ["permissions", "Permissions"], ["appearance", "Appearance"]])("captures the real %s card and its persistent footer", async (step, label) => {
  const Scene = setupRegionScene(step);
  const view = render(<Scene ladder="light" />);
  try {
    await screen.findByRole("region", { name: label });
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    expect(within(footer).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
    expect(within(footer).getByRole("button", { name: step === "appearance" ? "Finish set up" : "Continue" })).toBeTruthy();
  } finally { view.unmount(); }
});

it("captures the one-time close confirmation without completing set up", async () => {
  const Scene = setupRegionScene("close-confirmation");
  const view = render(<Scene ladder="dark" />);
  try {
    const dialog = await screen.findByRole("dialog", { name: "Leave set up without an account?" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep setting up" })));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Keep setting up" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to Claude", level: 2 })).toBeTruthy();
  } finally { view.unmount(); }
});

it("captures the ready introduction before the owner enters Account", async () => {
  const { default: Scene } = await import("../gallery/scenes/setup-introduction-ready.js");
  const view = render(<Scene ladder="light" />);
  try {
    expect((await screen.findByRole("button", { name: "Begin set up" })).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("agent-harness is ready on this computer.")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Step navigation" })).toBeNull();
  } finally { view.unmount(); }
});
