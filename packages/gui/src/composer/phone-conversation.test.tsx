// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { mountGallery } from "../../gallery/mount.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { route } from "../../gallery/scenes/phone-gallery-conversation.js";

it("keeps the composing draft until the input method commits, including an Enter without isComposing", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  const field = await screen.findByRole("textbox", { name: "Message" });
  act(() => field.focus());
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: "確認" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: false, keyCode: 229 });
  expect(app.environment("desk").requests("runs.start")).toHaveLength(0);
  expect(field).toHaveProperty("value", "確認");
  fireEvent.compositionEnd(field);
  await app.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(app.environment("desk").requests("runs.start")).toHaveLength(1));
});

it("fits the web conversation to the visual viewport and leaves pinch zoom alone", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 480, width: 390, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root";
  document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
  viewport.height = 400;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
  viewport.scale = 2;
  viewport.height = 200;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
  await gallery.close();
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("");
});

it("fits a missing-workspace conversation before and after its message field returns", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 480, width: 390, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-missing-workspace", "light", {
    "phone-missing-workspace": {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: Array.from({ length: 1 }, () => ({ title: "Receipts", workspaceMissingSince: "2026-01-01T00:00:00Z" })) }] },
      readySelector: '[aria-label="The workspace is gone"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
  const env = gallery.world.world.environment("desk");
  await act(async () => {
    await gallery.world.runtime.commands.dispatch(env.environmentId, "sessions.setWorkspace", { sessionId: env.sessionId(), workspace: { kind: "directory", path: "/work/receipts" } });
  });
  await screen.findByRole("textbox", { name: "Message" });
  viewport.height = 400;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
});

it("opens the phone run settings by tap without taking space from the waiting card initially", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-permission");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const toggle = screen.getByRole("button", { name: "Run settings" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDefined();
});

it("answers a phone prompt once after the connection drops with its answer in flight", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-permission");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const env = gallery.world.world.environment("desk");
  env.holdAnswers(true);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(env.requests("permissions.prompts.answer")).toHaveLength(1));
  const commandId = env.requests("permissions.prompts.answer")[0]!.params["commandId"];
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  env.holdAnswers(false);
  act(() => env.server.drop());
  await screen.findByText("Locked: desk cannot be reached.");
  await act(async () => gallery.world.clock.advance(2_000));
  await waitFor(() => expect(env.answered()).toHaveLength(1));
  expect(env.requests("permissions.prompts.answer").every(request => request.params["commandId"] === commandId)).toBe(true);
  expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
});

it.each(["long", "question", "plan"])("mounts the phone-conversation-%s surface with measurable touch and keyboard actions", async kind => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, `phone-conversation-${kind}`, "light", undefined, { platform: "web", textSize: 20 });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  expect(gallery.world.shell).toBeUndefined();
  const decision = kind === "plan" ? "Approve · continue in acceptEdits" : kind === "question" ? "Send answer" : "Send";
  expect(screen.getByRole("button", { name: decision })).toBeDefined();
  if (kind === "long") {
    expect(screen.getByRole("list", { name: "Attachments" }).textContent).toContain("unusually-long-receipt-filename-for-the-quarter.txt");
    expect(screen.getAllByRole("button", { name: /^Remove unusually-long-receipt-filename/ })).toHaveLength(20);
    expect(screen.getByRole("region", { name: "Queued messages" }).textContent).toContain("1 message queued");
    await waitFor(() => expect([...root.querySelectorAll("[data-tool-raw]")].map(element => element.textContent).join("\n")).toContain("All receipt totals match."));
  }
  if (kind === "question") {
    const own = screen.getByRole("textbox", { name: "Your own answer" });
    act(() => own.focus());
    fireEvent.compositionStart(own);
    fireEvent.change(own, { target: { value: "確認" } });
    fireEvent.keyDown(own, { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 229 });
    expect(gallery.world.world.environment("desk").requests("permissions.prompts.answer")).toHaveLength(0);
    fireEvent.compositionEnd(own);
    fireEvent.click(screen.getByRole("button", { name: decision }));
    await waitFor(() => expect(gallery.world.world.environment("desk").answered()).toHaveLength(1));
  }
  const geometry = JSON.parse(root.dataset["galleryGeometry"]!);
  expect(geometry).toContainEqual({ selector: "[data-web-client]", contentFits: true });
  expect(geometry).toContainEqual({ selector: '[aria-label="Transcript"]', minimumHeight: 44, visibleWithin: "[data-web-client]" });
  expect(geometry).toContainEqual({ selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" });
});

it("lets a phone user scroll the refused draft, remedy and Run settings in the composer region", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const refusal = "The account personal is not signed in on this environment, so no run can start. Sign in in Settings, Accounts.";
  const gallery = await mountGallery(root, "phone-refusal", "dark", {
    "phone-refusal": {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, accounts: [{ label: "personal" }], sessions: [{ title: "Receipts" }], receipts: { "runs.start": { rejected: "account_unavailable", message: refusal } } }] },
      readySelector: '[aria-label="Message"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Explain the receipt totals.\n".repeat(6) } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const line = await screen.findByText(`Not sent: ${refusal}`);
  expect(input).toHaveProperty("value", "Explain the receipt totals.\n".repeat(6));
  const column = line.closest("[data-composer-column]")!;
  expect(column.contains(screen.getByRole("button", { name: "Run settings" }))).toBe(true);
  const style = document.createElement("style"); style.textContent = readFileSync(new URL("./phone-conversation.css", import.meta.url), "utf8"); document.head.append(style);
  onTestFinished(() => style.remove());
  // jsdom has no layout: check the actual phone rule matching the rendered refusal's scroll owner.
  const media = Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSMediaRule => rule.type === 4).filter(rule => rule.conditionText === "(max-width: 639px)");
  const rules = media.flatMap(rule => Array.from(rule.cssRules)).filter((rule): rule is CSSStyleRule => rule.type === 1).filter(rule => column.matches(rule.selectorText));
  expect(rules.some(rule => ["auto", "scroll"].includes(rule.style.getPropertyValue("overflow-y")))).toBe(true);
});

it("lets a phone user scroll away from the focused input without the viewport pulling it back", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, width: 360, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const field = screen.getByRole("textbox", { name: "Message" });
  const scroll = vi.spyOn(field, "scrollIntoView");
  onTestFinished(() => scroll.mockRestore());
  act(() => field.focus());
  expect(scroll).toHaveBeenCalled();
  scroll.mockClear();
  // Scrolling to a refusal/Send can move the visual viewport while focus remains in the field.
  viewport.offsetTop = 30;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(scroll).not.toHaveBeenCalled();
  viewport.height = 480;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(scroll).toHaveBeenCalled();
  expect(root.querySelector<HTMLElement>("[data-web-client]")!.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
});
