import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { act, screen, within } from "@testing-library/react";
import { StoredCredentialUnavailableError } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { flush } from "@agent-harness/client-runtime/testing/fake-wire";
import { expect, it } from "vitest";
import { renderApp } from "./harness.js";

it("keeps the local window ready through credential recovery and the bundled server restart", async () => {
  const shell = fakeShell();
  shell.answer("installer.bundledServer", async () => ({ version: "0.6.0", path: "/opt/agent-harness/resources/server.tar.gz" }));
  const first = await renderApp({ environments: [{ name: "desk", reach: "local", settings: { "updates.autoUpdate": false } }, { name: "laptop", reach: "paired" }] }, { shell, macOS: true, version: "0.6.0" });
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

  const desk = replaced.environment("desk");
  const firstSession = replaced.runtime.connections.list.read().find(view => view.kind === "local")?.clientSessionId;
  const firstToken = desk.wire.credential()?.token;
  const openedBefore = desk.wire.opened();
  await replaced.user.click(within(local).getByRole("button", { name: "Install the bundled 0.6.0" }));
  expect(replaced.runtime.desktopUpdate.view.read().bundledServer).toMatchObject({ state: "handed-over", version: "0.6.0" });
  await act(async () => {
    desk.notice("environment.draining", { drainingSince: replaced.clock.now().toISOString() });
    desk.autoAccept(false);
    desk.bye("updating");
    await flush();
    desk.discovery({ harnessVersion: "0.6.0" });
    desk.setUpdates({ status: { version: "0.6.0" } });
    replaced.clock.advance(10_000);
    for (let turn = 0; turn < 100 && desk.wire.opened() === openedBefore; turn++) await flush();
    expect(desk.wire.opened()).toBeGreaterThan(openedBefore);
    const auth = await desk.server.expect("auth");
    desk.autoAccept(true);
    if (auth.token === firstToken) desk.bye("revoked");
    else desk.server.hello({ harnessVersion: "0.6.0" });
    for (let turn = 0; turn < 100 && replaced.runtime.connections.list.read().find(view => view.kind === "local")?.phase !== "ready"; turn++) await flush();
    if (replaced.runtime.connections.list.read().find(view => view.kind === "local")?.phase === "ready") {
      desk.notice("environment.started", { harnessVersion: "0.6.0", protocolVersion: PROTOCOL_VERSION });
      desk.notice("environment.updated", { fromVersion: "0.0.0-fake", toVersion: "0.6.0" });
      await flush();
    }
  });

  expect(replaced.runtime.connections.list.read().find(view => view.kind === "local")).toMatchObject({ phase: "ready", blocked: null });
  expect(replaced.runtime.connections.list.read().find(view => view.kind === "local")?.clientSessionId).not.toBe(firstSession);
  expect(within(screen.getByRole("region", { name: "desk" })).getByText("Ready")).toBeDefined();
  expect(replaced.runtime.connections.list.read().find(view => view.kind === "paired")).toMatchObject({ phase: "blocked", blocked: "credential-unavailable", action: "re-pair" });
  expect(screen.getByText(/Stored credentials from the previous build could not be read/)).toBeDefined();
  expect(within(screen.getByRole("region", { name: "Credential access" })).getByRole("button", { name: "Pair again" })).toBeDefined();
});
