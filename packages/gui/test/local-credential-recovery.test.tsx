import { act, screen, within } from "@testing-library/react";
import { StoredCredentialUnavailableError } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { expect, it } from "vitest";
import { renderApp } from "./harness.js";

it("shows the local environment ready after replacement bootstraps again with unavailable paired credentials", async () => {
  const shell = fakeShell();
  const first = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] }, { shell, macOS: true });
  const grantsBefore = shell.calls.filter(call => call[0] === "localGrant.read").length;
  const fresh = new Map<string, string>();
  shell.answer("secrets.get", async (name) => {
    if (fresh.has(name)) return fresh.get(name);
    throw new StoredCredentialUnavailableError("OS approval was unavailable.");
  });
  shell.answer("secrets.set", async (name, value) => { fresh.set(name, value); });
  shell.changeSecretAccess("denied");
  const replaced = await first.remount();
  expect(shell.calls.filter(call => call[0] === "localGrant.read").length).toBeGreaterThan(grantsBefore);
  expect(replaced.runtime.connections.list.read().find(view => view.kind === "local")).toMatchObject({ phase: "ready" });
  expect(replaced.runtime.connections.list.read().find(view => view.kind === "paired")).toMatchObject({ phase: "blocked", blocked: "credential-unavailable" });
  const diagnostic = document.querySelector<HTMLElement>("[data-window-environments]");
  expect(JSON.parse(diagnostic?.dataset.windowEnvironments ?? "null")).toEqual([
    expect.objectContaining({ name: "desk", kind: "local", phase: "ready" }),
    expect.objectContaining({ name: "laptop", kind: "paired", phase: "blocked", blocked: "credential-unavailable", action: "re-pair" }),
  ]);
  await act(async () => {
    await shell.secrets.set("fresh-item-for-tests", "token-for-tests-fresh");
    expect(await shell.secrets.get("fresh-item-for-tests")).toBe("token-for-tests-fresh");
  });
  await replaced.user.click(screen.getByRole("button", { name: "Settings" }));
  await replaced.user.click(within(screen.getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Your machines" }));
  const local = screen.getByRole("region", { name: "desk" });
  expect(within(local).getByText("This machine")).toBeDefined();
  expect(within(local).getByText("Ready")).toBeDefined();
  expect(local.dataset.machineKind).toBe("local");
  expect(local.dataset.machinePhase).toBe("ready");
  expect(local.dataset.environmentId).toBe(replaced.environment("desk").environmentId);
  const paired = screen.getByRole("region", { name: "laptop" });
  expect(paired.dataset.machineKind).toBe("paired");
  expect(paired.dataset.machinePhase).toBe("blocked");
  expect(paired.dataset.machineBlocked).toBe("credential-unavailable");
  expect(paired.dataset.machineAction).toBe("re-pair");
  expect(screen.getByText(/Stored credentials from the previous build could not be read/)).toBeDefined();
});
