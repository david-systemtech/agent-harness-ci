import { act, screen } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

it("keeps the introduction after the environment is ready until Begin set up opens Account", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true });
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Set up steps" })).toBeNull();
  expect(screen.getByText("The environment on this machine is ready")).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Begin set up" }));
  const card = screen.getByRole("region", { name: "Account" });
  expect(card.textContent).toContain("Your agent needs a signed-in coding account to start a session. We will help you connect it.");
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Sign in an account" })).toBeDefined();
});

it("keeps a failed start in the introduction, opens pairing, and retries to readiness", async () => {
  const shell = fakeShell();
  shell.answer("service.status", async () => { throw new Error("Error invoking remote method 'shell:service.status': Error: Could not read service status."); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] }, { firstLaunch: true, shell });
  expect(await screen.findByText("The environment could not start on this machine.")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(screen.queryByText("Could not read service status.")).toBeNull();
  await app.user.click(screen.getByRole("button", { name: "Start details" }));
  expect(screen.getByText("Could not read service status.")).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Pair instead" }));
  expect(screen.getByRole("dialog", { name: "Pair with an environment" })).toBeDefined();
  await app.user.keyboard("{Escape}");
  let started!: () => void;
  shell.answer("service.status", async () => ({ installed: true, running: false, ready: false }));
  shell.answer("service.start", () => new Promise<void>((resolve) => { started = resolve; }));
  await app.user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Starting the environment on this machine")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Waiting for this machine…" }).hasAttribute("disabled")).toBe(true);
  app.environment("desk").discovery("ready");
  await act(async () => started());
  const begin = await screen.findByRole("button", { name: "Begin set up" });
  expect(shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
  await app.user.click(begin);
  expect(screen.getByRole("region", { name: "Account" })).toBeDefined();
});

it("asks before leaving without an account and keeps setup available after relaunch", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true });
  await app.user.click(screen.getByRole("button", { name: "I’ll set up later" }));
  const confirmation = screen.getByRole("dialog", { name: "Leave set up without an account?" });
  expect(confirmation.textContent).toContain("Set up will be waiting in Settings.");
  await app.user.click(screen.getByRole("button", { name: "Keep setting up" }));
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Begin set up" }));
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Account" })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
  await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
  const again = await app.remount();
  expect(screen.queryByRole("heading", { name: "Welcome to agent-harness" })).toBeNull();
  await again.user.keyboard("{Control>},{/Control}");
  await again.user.click(screen.getByRole("button", { name: "Open the full checklist" }));
  await screen.findByRole("region", { name: "Account" });
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  await again.user.click(screen.getByRole("button", { name: "Appearance", exact: true }));
  expect(screen.getByRole("button", { name: "Finish" })).toBeDefined();
});

it("starts a known local environment when an unfinished first launch is opened again", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { firstLaunch: true });
  app.environment("desk").discovery("nothing");
  app.shell.answer("service.start", async () => app.environment("desk").discovery("ready"));
  const again = await app.remount();
  expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
  expect(await screen.findByRole("button", { name: "Begin set up" })).toBeDefined();
  expect(again.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
});
