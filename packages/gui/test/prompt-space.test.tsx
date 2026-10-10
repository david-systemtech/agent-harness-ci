// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderApp } from "./harness.js";
import { mountGallery } from "../gallery/mount.js";

it("keeps an unavailable Stop and its keyboard explanation visible in compact mode", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", scopes: ["read", "sessions:write"], sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  await screen.findByRole("region", { name: "Transcript" });
  const env = app.environment("desk"), session = env.sessionId();
  env.startRun(session, "Create a tag");
  env.openPrompt(session, { input: { command: "git tag qa-check" } });
  const prompt = await screen.findByRole("region", { name: "Parked prompt" });
  prompt.closest<HTMLElement>("[data-composer-above]")!.dataset["promptSpace"] = "compact";
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/composer/prompt-space.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    const stop = screen.getByRole("button", { name: /^Stop$/ });
    expect(stop).toHaveProperty("disabled", true);
    const explanation = stop.closest<HTMLElement>('span[role="group"]')!;
    expect(getComputedStyle(explanation).display).not.toBe("none");
    expect(explanation.tabIndex).toBe(0);
    expect(explanation.getAttribute("aria-label")).toContain("Pair again with full access");
  } finally { style.remove(); }
});

it("leaves embedded web permission decisions to the dock scroller, even under a wide outer viewport", async () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "prompt-phone-first-permission", "dark");
  try {
    expect(await gallery.ready).toBe(true);
    const transcript = screen.getByRole("region", { name: "Transcript" });
    transcript.style.lineHeight = "28px";
    act(() => { for (const callback of observers) callback([], {} as ResizeObserver); });
    const prompt = screen.getByRole("region", { name: "Parked prompt" });
    const above = prompt.closest<HTMLElement>("[data-composer-above]")!;
    expect(above.style.getPropertyValue("--session-prompt-height")).toBe("");
    expect(above.dataset["promptSpace"]).toBeUndefined();
    expect(prompt.style.maxHeight).toBe("");
    const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
    expect(geometry).toContainEqual({ selector: '[aria-label="Permission request"]', minimumHeight: 48, contentFits: true });
  } finally { await gallery.close(); container.remove(); vi.unstubAllGlobals(); }
});

it("keeps a compact request scrollport while notes and decisions share a row and Message stays beside Stop", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  const session = env.sessionId();
  env.startRun(session, "Create a tag");
  env.openPrompt(session, { input: { command: "git tag qa-check" } });
  const prompt = await screen.findByRole("region", { name: "Parked prompt" });
  prompt.closest<HTMLElement>("[data-composer-above]")!.dataset["promptSpace"] = "compact";
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/composer/prompt-space.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    const request = within(prompt).getByRole("region", { name: "Permission request" });
    const decisions = within(prompt).getByRole("group", { name: "Permission decision" });
    expect(getComputedStyle(request).minHeight).toBe("48px");
    expect(getComputedStyle(decisions).display).toBe("grid");
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(getComputedStyle(message.closest("[data-composer-card]")!).display).toBe("grid");
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeDefined();
    const above = prompt.closest<HTMLElement>("[data-composer-above]")!;
    above.dataset["promptOverflow"] = "";
    expect(getComputedStyle(prompt.closest("[data-composer-column]")!).overflowY).toBe("auto");
    delete above.dataset["promptOverflow"];
    await app.user.type(within(decisions).getByRole("textbox", { name: "Note" }), "Keep this tag local");
    await app.user.click(within(decisions).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(env.requests("permissions.prompts.answer")[0]?.params).toEqual(expect.objectContaining({ decision: "allow", message: "Keep this tag local" })));
  } finally { style.remove(); }
});
