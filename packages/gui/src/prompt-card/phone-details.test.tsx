// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { phoneLayoutMedia } from "../frame/phone-frame.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DATA_DIRECTORY_PRESET_ID, describeDenylistMatch, type DenylistMatch, type PromptKind } from "@agent-harness/contracts";
import type { ScriptedPrompt } from "@agent-harness/client-runtime/testing/scripted-environment";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import type { SceneModule } from "../../gallery/scene-registry.js";
import { platform, script, route } from "../../gallery/scenes/phone-gallery-conversation.js";

async function phone(kind: PromptKind = "permission", width = 390, more: ScriptedPrompt = {}) {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => (width < 640 ? query === "(width < 640px)" : query.includes("pointer: coarse"))
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  vi.stubGlobal("innerWidth", width);
  if (width >= 640) vi.stubGlobal("innerHeight", 390);
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { height: width < 640 ? 480 : 330, width, scale: 1, offsetTop: width < 640 ? 120 : 8 }));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const scene: SceneModule = { platform, ...(script && { script }), route, readySelector: '[aria-label="Parked prompt"]', arrangeWeb: world => {
    const env = world.environment("desk"), sessionId = env.sessionId();
    env.startRun(sessionId, "Check receipts");
    env.openPrompt(sessionId, { promptId: "long-request", kind, ceiling: "acceptEdits", mode: "plan", summary: "Review receipts", toolName: "Bash", reason: "Explain the full reason. ".repeat(50), input: { command: "printf receipts\n".repeat(80) }, plan: "Check every receipt.\n\n".repeat(80), questions: [{ header: "Checks", question: "Which checks?", multiSelect: true, options: [{ label: "Totals", description: "Compare every receipt total. ".repeat(50) }] }], ...more });
  } };
  const gallery = await mountGallery(root, "phone-long-test", "light", { "phone-long-test": scene }, { platform: "web", textSize: 20 });
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  await gallery.ready;
  return gallery;
}

it.each([
  { key: "Enter", code: "Enter", ctrlKey: true },
  { key: "Escape", code: "Escape" },
])("restores Message without scrolling after answering the closed summary with $key", async keys => {
  const gallery = await phone();
  const summary = screen.getByRole("region", { name: "Parked prompt" });
  const message = screen.getByRole("textbox", { name: "Message" });
  const focus = vi.spyOn(message, "focus");
  act(() => summary.focus());
  fireEvent.keyDown(summary, keys);
  await waitFor(() => expect(gallery.world.world.environment("desk").answered()).toHaveLength(1));
  expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
  expect(document.activeElement).toBe(message);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("answers with the approval shortcut immediately after opening Details", async () => {
  const gallery = await phone();
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Permission" });
  await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter", ctrlKey: true });
  await waitFor(() => expect(gallery.world.world.environment("desk").answered()).toHaveLength(1));
  expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" })));
});

it("keeps the full permission and denial note in Details, preserving them on Close", async () => {
  const gallery = await phone();
  const summary = screen.getByRole("region", { name: "Parked prompt" });
  expect(within(summary).queryByRole("textbox", { name: "Note" })).toBeNull();
  const details = within(summary).getByRole("button", { name: "Details" });
  fireEvent.click(details);
  const sheet = await screen.findByRole("dialog", { name: "Permission" });
  expect(sheet.closest("[data-web-client]")).not.toBeNull();
  expect(within(sheet).getByText("Explain the full reason. ".repeat(50).trim())).toBeDefined();
  fireEvent.change(within(sheet).getByRole("textbox", { name: "Note" }), { target: { value: "Keep the rounding rule" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(details);
  expect(gallery.world.world.environment("desk").requests("permissions.prompts.answer")).toHaveLength(0);
  fireEvent.click(details);
  const reopened = await screen.findByRole("dialog", { name: "Permission" });
  expect(within(reopened).getByRole("textbox", { name: "Note" })).toHaveProperty("value", "Keep the rounding rule");
  fireEvent.click(within(reopened).getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" })));
});

it("says a one-match denylist card's request, why and what instead once each in Details", async () => {
  // #1905: the phone's Details said the match's sentence three times.
  // As the environment's gate asks it: the summary and the reason both name the match as a sentence.
  const match: DenylistMatch = { section: "paths", entry: { id: DATA_DIRECTORY_PRESET_ID, pattern: "/srv/harness", note: "", enabled: true, preset: true }, matched: "/srv/harness/environment.json" };
  await phone("denylist", 390, { toolName: "Read", input: { file_path: match.matched }, summary: `Read: ${describeDenylistMatch(match)}`, reason: describeDenylistMatch(match), denylist: [match] });
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Denylist" });
  expect(sheet.textContent).not.toContain("is on the denylist");
  expect(within(sheet).getAllByText("Read: /srv/harness/environment.json")).toHaveLength(1);
  const entry = within(within(sheet).getByRole("list", { name: "On the denylist" })).getByRole("listitem");
  expect(entry.textContent).toBe("This is the environment's data directory: its event log, keys and accounts.Instead, the agent may work in its own working directory, and ask you for anything it needs from the environment's records.");
});

it("keeps question choices and IME words across dismissal and sends only after composition", async () => {
  const gallery = await phone("question");
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Question" });
  const words = within(sheet).getByRole("textbox", { name: "Your own answer" });
  fireEvent.click(within(sheet).getByRole("checkbox", { name: "Totals" }));
  act(() => words.focus());
  fireEvent.compositionStart(words);
  fireEvent.change(words, { target: { value: "確認" } });
  fireEvent.keyDown(words, { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 229 });
  const env = gallery.world.world.environment("desk");
  expect(env.requests("permissions.prompts.answer")).toHaveLength(0);
  fireEvent.compositionEnd(words);
  fireEvent.keyDown(words, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(env.requests("permissions.prompts.answer")).toHaveLength(0);
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const reopened = await screen.findByRole("dialog", { name: "Question" });
  expect(within(reopened).getByRole("checkbox", { name: "Totals" })).toHaveProperty("checked", true);
  const answer = within(reopened).getByRole("textbox", { name: "Your own answer" });
  expect(answer).toHaveProperty("value", "確認");
  fireEvent.keyDown(answer, { key: "Enter", code: "Enter", ctrlKey: true });
  await waitFor(() => expect(env.answered()).toHaveLength(1));
  expect(env.requests("permissions.prompts.answer")[0]!.params["answers"]).toEqual({ "Which checks?": "Totals, 確認" });
});

it("keeps one logical answer when two taps precede a disconnect and replay", async () => {
  const gallery = await phone();
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Permission" });
  const env = gallery.world.world.environment("desk");
  env.holdAnswers(true);
  const allow = within(sheet).getByRole("button", { name: "Allow once" });
  act(() => { allow.click(); allow.click(); });
  await waitFor(() => expect(env.requests("permissions.prompts.answer")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  const id = env.requests("permissions.prompts.answer")[0]!.params["commandId"];
  env.holdAnswers(false);
  act(() => env.server.drop());
  await screen.findByText("Locked: desk cannot be reached.");
  await act(async () => gallery.world.clock.advance(2_000));
  await waitFor(() => expect(env.answered()).toHaveLength(1));
  expect(env.requests("permissions.prompts.answer").every(request => request.params["commandId"] === id)).toBe(true);
  expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
});

it("offers every plan mode with its ceiling reason and leaves planning until explicitly answered", async () => {
  const gallery = await phone("plan");
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Plan to approve" });
  expect(within(sheet).getByRole("button", { name: "Keep planning" })).toBeDefined();
  expect(within(sheet).getByRole("button", { name: "Approve · continue in acceptEdits" }).textContent).toContain("Approve · acceptEdits");
  const bypass = within(sheet).getByRole("button", { name: /bypassPermissions/ });
  expect(bypass.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(bypass);
  expect(within(sheet).getAllByRole("status")[0]!.textContent).toMatch(/ceiling/);
  expect(gallery.world.world.environment("desk").requests("permissions.prompts.answer")).toHaveLength(0);
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("region", { name: "Parked prompt" })).toBeDefined();
});


it("uses the shared landscape media for a bounded request sheet with touch actions", async () => {
  await phone("permission", 844);
  fireEvent.click(within(screen.getByRole("region", { name: "Parked prompt" })).getByRole("button", { name: "Details" }));
  const sheet = await screen.findByRole("dialog", { name: "Permission" });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("./phone-details.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  try {
    const media = Array.from(stylesheet.sheet?.cssRules ?? []).find((rule): rule is CSSMediaRule => "conditionText" in rule);
    expect(media?.conditionText).toBe(phoneLayoutMedia().map(query => query.media).join(", "));
    // Activate the shipped media rules: jsdom cannot evaluate layout media.
    stylesheet.textContent = Array.from(media?.cssRules ?? []).map(rule => rule.cssText).join("\n");
    expect(getComputedStyle(sheet).position).toBe("absolute");
    expect(getComputedStyle(sheet).overflow).toBe("hidden");
    for (const name of ["Close", "Allow once"]) {
      const action = within(sheet).getByRole("button", { name });
      expect(getComputedStyle(action).minHeight).toBe("44px");
      expect(getComputedStyle(action).minWidth).toBe("44px");
    }
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally { stylesheet.remove(); }
});
