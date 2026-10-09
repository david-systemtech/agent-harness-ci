import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished } from "vitest";
import { startWebWorld } from "../../gallery/world.js";
import { App } from "../app.js";

it.each([false, true])("keeps the restart command in the web client (container: %s)", async (container) => {
  const world = await startWebWorld({ environments: [{
    name: "desk", reach: "paired",
    containment: {
      mechanism: null,
      container: { declared: container, detected: container },
      levels: [
        { level: "off", available: true, reason: null, cause: null },
        { level: "workspace", available: false, reason: "bubblewrap is not installed.", cause: "binary_missing" },
        { level: "workspace-no-network", available: false, reason: "bubblewrap is not installed.", cause: "binary_missing" },
      ],
    },
    settings: { "permissions.containment.default": "workspace" },
    setup: { permissions: { state: "needs-attention", reason: "The sandbox you chose does not work on this computer yet.", failing: ["permissions.containment"], actions: ["turn-sandbox-off"] } },
  }] }, { firstLaunchDone: false });
  const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
  onTestFinished(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const rail = await screen.findByRole("navigation", { name: "Set up steps" });
  await within(rail).findByRole("button", { name: "Permissions", description: / Needs a fix / });
  await user.click(within(rail).getByRole("button", { name: "Permissions" }));
  const card = screen.getByRole("region", { name: "Permissions" });
  await user.click(within(card).getByRole("button", { name: "How to fix it" }));
  expect(within(card).getByText(container ? "docker compose restart environment" : "agent-harness service stop && agent-harness service start")).toBeDefined();
  expect(within(card).queryByRole("button", { name: "Restart agent-harness" })).toBeNull();
  const more = within(card).getByRole("button", { name: "More safety settings" });
  if (more.getAttribute("aria-expanded") !== "true") await user.click(more);
  const group = within(card).getByRole("group", { name: "Sandbox" });
  await user.click(within(group).getByRole("button", { name: "How to set it up" }));
  expect(within(group).getByText(container ? "docker compose restart environment" : "agent-harness service stop && agent-harness service start")).toBeDefined();
  await waitFor(() => expect(world.world.environment("desk").requests("environment.drain")).toEqual([]));
});
