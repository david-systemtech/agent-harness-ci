import { mountGallery } from "../../gallery/mount.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { renderApp } from "../../test/harness.js";

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
  expect(geometry).toContainEqual({ selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" });
});
