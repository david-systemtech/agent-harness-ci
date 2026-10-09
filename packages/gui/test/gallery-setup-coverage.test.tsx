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

// setup-copy.md §5.4: the Your machines question in its three states, only this computer, reachable through Tailscale and not reachable (#1846).
it.each([
  ["your-machines", "Only on this computer", undefined],
  ["machines-tailscale", "Also from my other devices", "Your devices can reach this computer through Tailscale."],
  ["machines-unreachable", "Also from my other devices", "Your other devices cannot reach this computer yet. Install Tailscale here and on your other devices."],
] as const)("captures Your machines' %s scene with its answer chosen and its reach said", async (kind, answer, verdict) => {
  const Scene = setupRegionScene(kind);
  const view = render(<Scene ladder="dark" />);
  try {
    const machines = await screen.findByRole("region", { name: "Your machines" });
    const question = await within(machines).findByRole("radiogroup", { name: "Use agent-harness from other devices?" });
    await waitFor(() => expect(within(question).getByRole("radio", { name: answer }).getAttribute("aria-checked")).toBe("true"));
    if (verdict === undefined) expect(within(machines).queryByRole("region", { name: "How your devices reach this computer" })).toBeNull();
    else expect(await within(within(machines).getByRole("region", { name: "How your devices reach this computer" })).findByText(verdict)).toBeDefined();
    if (kind === "machines-unreachable") expect(within(machines).getByRole("button", { name: "Get Tailscale" })).toBeDefined();
    if (kind === "machines-tailscale") expect(within(machines).getByRole("region", { name: "Add a device" })).toBeDefined();
  } finally { view.unmount(); }
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
