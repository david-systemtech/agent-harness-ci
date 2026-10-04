import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type ScriptedReceipt } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { browserPlatform } from "../platform/browser-platform.js";
import { openPresentation } from "../presentation.js";

const open = async (receipts: Record<string, ScriptedReceipt> = {}) => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(original(query), { matches: query === "(width < 640px)" }));
  onTestFinished(() => media.mockRestore());
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", receipts, scopes: ["read", "sessions:write", "runs:drive"], accounts: [{ id: "account-1", label: "Work", identity: { provider: "claude", email: "dev@work.test", organisation: null } }], models: [{ accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] }], sessions: [{ title: "Notes", workspace: { kind: "directory", path: "/work/notes" } }] }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const env = world.environment("desk");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: env.wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); history.replaceState(null, "", "/"); });
  await screen.findByRole("option", { name: "Notes" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New session" }));
  const surface = await screen.findByRole("region", { name: "New session" });
  const box = within(surface).getByRole("textbox", { name: "Message" });
  return { user, env, surface, box, platform };
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
