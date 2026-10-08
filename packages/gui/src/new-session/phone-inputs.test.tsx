import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type ScriptedReceipt, type Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { browserPlatform } from "../platform/browser-platform.js";
import { openPresentation } from "../presentation.js";

const open = async (receipts: Record<string, ScriptedReceipt> = {}, secondEnvironment = false) => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(original(query), { matches: query === "(width < 640px)" }));
  onTestFinished(() => media.mockRestore());
  const clock = manualClock();
  const desk: Script["environments"][number] = { name: "desk", reach: "unpaired", receipts, scopes: ["read", "sessions:write", "runs:drive"], accounts: [{ id: "account-1", label: "Work", identity: { provider: "claude", email: "dev@work.test", organisation: null } }], models: [{ accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: ["low", "high"], label: "Opus 5" }] }], sessions: [{ title: "Notes", workspace: { kind: "directory", path: "/work/notes" } }] };
  const world = scriptedWorld(clock, { environments: [desk, ...(secondEnvironment ? [{ ...desk, name: "backup", receipts: {} }] : [])] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const env = world.environment("desk");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: env.wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); history.replaceState(null, "", "/"); });
  const user = userEvent.setup();
  await screen.findByRole("note", { name: "Limited access" });
  await user.click(screen.getByRole("button", { name: "Show sessions" }));
  await within(screen.getByRole("dialog", { name: "Sessions" })).findByRole("button", { name: /desk Notes/ });
  await user.click(screen.getByRole("button", { name: "Close sessions" }));
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(await screen.findByRole("menuitem", { name: "New session" }));
  const surface = await screen.findByRole("region", { name: "New session" });
  const box = within(surface).getByRole("textbox", { name: "Message" });
  return { user, env, surface, box, platform, runtime, world };
};

const togglePairing = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(await screen.findByRole("menuitem", { name: "Pair with an environment" }));
};

it("attaches phone file contents to the first message and keeps the draft after picker cancellation", async () => {
  const { user, env, surface, box, platform } = await open();
  expect(platform.shell).toBeUndefined();
  await user.type(box, "Read this note");
  await user.click(within(surface).getByRole("button", { name: "Attach files" }));
  const picker = screen.getByLabelText("Files to attach");
  fireEvent.change(picker, { target: { files: [] } });
  expect((box as HTMLTextAreaElement).value).toBe("Read this note");
  await user.upload(picker, new File([new Uint8Array([137, 80, 78, 71])], "note.png", { type: "image/png" }));
  await within(surface).findByRole("list", { name: "Attachments" });
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(env.requests("runs.start").map(r => r.params)).toEqual([
    expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }),
  ]));
});

it("selects a directory on the environment by tap and restores focus after cancelling the picker", async () => {
  const { user, surface, box, env } = await open();
  await user.type(box, "Keep this draft");
  const trigger = within(surface).getByRole("button", { name: /^Workspace:/ });
  await user.click(trigger);
  const picker = await screen.findByRole("dialog", { name: "Where it works on desk" });
  expect(within(picker).queryByText("Pick on this computer…")).toBeNull();
  await user.tab();
  await user.tab();
  expect(picker.contains(document.activeElement)).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect((box as HTMLTextAreaElement).value).toBe("Keep this draft");
  await user.click(trigger);
  await user.type(screen.getByRole("textbox", { name: "A directory on desk" }), "/work/phone-project");
  await user.click(screen.getByRole("button", { name: "Use" }));
  await within(surface).findByRole("button", { name: "Workspace: directory phone-project" });
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(env.requests("sessions.create").map(r => r.params)).toEqual([
    expect.objectContaining({ workspace: { kind: "directory", path: "/work/phone-project" } }),
  ]));
});

it("keeps the selected phone files after a refused first send and retries on the same created session", async () => {
  const receipts: Record<string, ScriptedReceipt> = { "runs.start": { rejected: "unavailable", message: "The provider is temporarily unavailable." } };
  const { user, env, surface, box } = await open(receipts);
  await user.type(box, "Read this note");
  await user.upload(screen.getByLabelText("Files to attach"), new File([new Uint8Array([137, 80, 78, 71])], "note.png", { type: "image/png" }));
  await within(surface).findByRole("list", { name: "Attachments" });
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(within(surface).getByRole("status").textContent).toContain("The provider is temporarily unavailable."));
  expect(screen.getByRole("region", { name: "New session" })).toBe(surface);
  expect(box).toHaveProperty("value", "Read this note");
  expect(within(surface).getByRole("list", { name: "Attachments" }).textContent).toContain("note.png");
  expect(within(surface).getByRole("button", { name: /^Workspace:/ }).closest("fieldset")).toHaveProperty("disabled", true);
  receipts["runs.start"] = "accepted";
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(env.requests("runs.start")).toHaveLength(2));
  expect(env.requests("sessions.create")).toHaveLength(1);
  const messages = env.requests("runs.start").map(request => request.params);
  expect(messages[1]).toEqual(expect.objectContaining({ sessionId: messages[0]?.sessionId, text: messages[0]?.text, attachments: messages[0]?.attachments }));
  expect(messages[1]).toEqual(expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "New session" })).toBeNull());
});


it("keeps a refused first message's files and accepted session through the pairing view", async () => {
  const receipts: Record<string, ScriptedReceipt> = { "runs.start": { rejected: "unavailable", message: "Try again." } };
  const { user, env, surface, box } = await open(receipts);
  await user.type(box, "Read this note");
  await user.upload(screen.getByLabelText("Files to attach"), new File([new Uint8Array([137, 80, 78, 71])], "note.png", { type: "image/png" }));
  await within(surface).findByRole("list", { name: "Attachments" });
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await within(surface).findByText("Not sent: Try again.");
  await togglePairing(user);
  expect(screen.queryByRole("region", { name: "New session" })).toBeNull();
  await togglePairing(user);
  const restored = await screen.findByRole("region", { name: "New session" });
  expect(within(restored).getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Read this note");
  expect(within(restored).getByRole("list", { name: "Attachments" }).textContent).toContain("note.png");
  receipts["runs.start"] = "accepted";
  await user.click(within(restored).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "New session" })).toBeNull());
  expect(env.requests("sessions.create")).toHaveLength(1);
  expect(env.requests("runs.start").map(r => r.params)).toEqual([
    expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }),
    expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }),
  ]);
});


it("keeps a refused first message on its accepted environment when the default changes", async () => {
  const receipts: Record<string, ScriptedReceipt> = { "runs.start": { rejected: "unavailable", message: "Try again." } };
  const { user, env, surface, box, runtime, world } = await open(receipts, true);
  await user.type(box, "Read this note");
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await within(surface).findByText("Not sent: Try again.");
  const acceptedId = env.requests("runs.start")[0]?.params.sessionId;
  const backup = world.environment("backup");
  await runtime.connections.add({ link: backup.wire.link });
  await runtime.connections.setEnabled(env.environmentId, false);
  await waitFor(() => expect(runtime.projections.newSession({ focus: { kind: "none" } }).read().environment.value).toBe(backup.environmentId));
  await user.type(box, " revised");
  runtime.drafts.flush();
  expect(within(surface).getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  expect(backup.requests("sessions.setDraft")).toHaveLength(0);
  await runtime.connections.setEnabled(env.environmentId, true);
  receipts["runs.start"] = "accepted";
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "New session" })).toBeNull());
  expect(backup.requests("runs.start")).toHaveLength(0);
  expect(backup.requests("sessions.create")).toHaveLength(0);
  expect(env.requests("sessions.create")).toHaveLength(0);
  expect(env.requests("runs.start")[0]?.params.sessionId).toBe(acceptedId);
  expect(env.requests("runs.start")[0]?.params.text).toBe("Read this note revised");
});


it("observes pending creation and its refusal after pairing remounts the editor", async () => {
  const receipts: Record<string, ScriptedReceipt> = { "runs.start": { rejected: "unavailable", message: "Try again." } };
  const { user, env, surface, box } = await open(receipts);
  const release = env.list.hold("sessions.create");
  await user.type(box, "Read this note");
  await user.upload(screen.getByLabelText("Files to attach"), new File([new Uint8Array([137, 80, 78, 71])], "note.png", { type: "image/png" }));
  await within(surface).findByRole("list", { name: "Attachments" });
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(env.requests("sessions.create")).toHaveLength(1));
  await togglePairing(user);
  expect(screen.queryByRole("region", { name: "New session" })).toBeNull();
  await togglePairing(user);
  const restored = await screen.findByRole("region", { name: "New session" });
  expect(within(restored).getByRole("button", { name: "Starting…" })).toHaveProperty("disabled", true);
  release();
  await within(restored).findByText("Not sent: Try again.");
  receipts["runs.start"] = "accepted";
  await user.click(within(restored).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "New session" })).toBeNull());
  expect(env.requests("sessions.create")).toHaveLength(1);
  expect(env.requests("runs.start").map(r => r.params)).toEqual([
    expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }),
    expect.objectContaining({ text: "Read this note", attachments: [{ kind: "image", name: "note.png", mediaType: "image/png", data: "iVBORw==" }] }),
  ]);
});

it("chooses account, model and effort in separate phone steps and sends the chosen effort", async () => {
  const { user, surface, env, box } = await open();
  const trigger = within(surface).getByRole("button", { name: /^Account:/ });
  await user.pointer({ target: trigger, keys: "[TouchA>]" });
  expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull();
  await user.pointer({ target: trigger, keys: "[/TouchA]" });
  const sheet = await screen.findByRole("dialog", { name: "Run choices" });
  expect(sheet.hasAttribute("data-run-sheet")).toBe(true);
  expect(within(sheet).getByRole("group", { name: "Accounts" })).toBeDefined();
  expect(within(sheet).queryByRole("group", { name: "Models" })).toBeNull();
  expect(within(sheet).queryByRole("group", { name: "Effort" })).toBeNull();
  expect(within(sheet).queryByText("desk")).toBeNull();
  await user.click(within(sheet).getByRole("menuitem", { name: /^Work/ }));
  expect(within(sheet).getByRole("group", { name: "Models" })).toBeDefined();
  expect(within(sheet).queryByRole("group", { name: "Accounts" })).toBeNull();
  await user.click(within(sheet).getByRole("menuitem", { name: /^Opus 5/ }));
  expect(within(sheet).getByRole("group", { name: "Effort" })).toBeDefined();
  expect(within(sheet).queryByRole("group", { name: "Models" })).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "Back: Models" }));
  await user.click(within(sheet).getByRole("button", { name: "Next: Effort" }));
  await user.click(within(sheet).getByRole("menuitem", { name: "High" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.type(box, "Check the receipts");
  await user.click(within(surface).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(env.requests("runs.start")[0]?.params).toEqual(expect.objectContaining({ model: "claude-opus-5", effort: "high" })));
});

it("resizes the first message after width delivery without resizing it inside the observer cycle", async () => {
  const Original = globalThis.ResizeObserver;
  const deliveries = new Map<Element, (width: number) => void>();
  vi.stubGlobal("ResizeObserver", class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.callback = callback;
    }
    private readonly callback: ResizeObserverCallback;
    override observe(target: Element) {
      if (target.getAttribute("aria-label") !== "Message") return super.observe(target);
      deliveries.set(target, width => this.callback([{ target, contentRect: new DOMRect(0, 0, width, 44), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this));
    }
  });
  onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const { box } = await open();
  const deliver = deliveries.get(box);
  if (deliver === undefined) throw new Error("the first message box is not observed");
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const draw = () => act(() => { const due = [...frames.values()]; frames.clear(); due.forEach(callback => callback(0)); });
  vi.spyOn(box, "scrollHeight", "get").mockReturnValue(96);
  const height = box.style.height;
  act(() => deliver(318));
  expect(box.style.height).toBe(height);
  act(() => deliver(288));
  expect(box.style.height).toBe(height);
  draw();
  expect(box.style.height).toBe("96px");
});
