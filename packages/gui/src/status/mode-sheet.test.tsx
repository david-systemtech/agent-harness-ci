import { useToastTimers } from "../../test/toast-timers.js";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../../test/harness.js";

useToastTimers();

const openMode = async (extra: Partial<ScriptedEnvironment> = {}) => {
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  onTestFinished(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", hello: { ceiling: "acceptEdits" }, sessions: [{ title: "Receipts", mode: "acceptEdits" }], ...extra }] });
  app.open("desk");
  await screen.findByText("Nothing said yet.");
  const trigger = await screen.findByRole("button", { name: /^Mode:/ });
  await app.user.click(trigger);
  const sheet = await screen.findByRole("dialog", { name: "Mode" });
  return { app, env: app.environment("desk"), trigger, sheet };
};

it("shows the current mode and ceiling reason, then sets an allowed mode once and closes", async () => {
  const { app, env, sheet, trigger } = await openMode();
  expect(within(sheet).getByRole("button", { name: "accept edits" }).getAttribute("aria-pressed")).toBe("true");
  const bypass = within(sheet).getByRole("button", { name: "BYPASS" });
  expect(bypass.getAttribute("disabled")).not.toBeNull();
  expect(bypass.textContent).toContain("above this connection's ceiling (acceptEdits)");
  await app.user.click(bypass);
  expect(env.requests("permissions.mode.set")).toHaveLength(0);
  await app.user.click(within(sheet).getByRole("button", { name: "plan" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mode" })).toBeNull());
  expect(env.requests("permissions.mode.set").map(request => request.params)).toEqual([expect.objectContaining({ sessionId: env.sessionId(), mode: "plan" })]);
  expect(trigger.getAttribute("aria-label")).toBe("Mode: plan");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("keeps a failed selection actionable and leaves the current mode unchanged", async () => {
  const { app, env, sheet, trigger } = await openMode({ receipts: { "permissions.mode.set": { rejected: "forbidden", message: "Reconnect to try again." } } });
  await app.user.click(within(sheet).getByRole("button", { name: "plan" }));
  expect((await within(sheet).findByRole("alert")).textContent).toContain("Reconnect to try again.");
  expect(trigger.getAttribute("aria-label")).toBe("Mode: accept edits");
  expect(within(sheet).getByRole("button", { name: "accept edits" }).getAttribute("aria-pressed")).toBe("true");
  await app.user.click(within(sheet).getByRole("button", { name: "plan" }));
  await waitFor(() => expect(env.requests("permissions.mode.set")).toHaveLength(2));
});

it("traps Tab and dismisses with Close or Escape without changing the draft, session or transcript scroll", async () => {
  const { app, env, trigger, sheet } = await openMode();
  const close = within(sheet).getByRole("button", { name: "Close mode picker" });
  close.focus();
  await app.user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "accept edits" }));
  await app.user.keyboard("{Tab}");
  expect(document.activeElement).toBe(close);
  await app.user.click(close);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  const field = screen.getByRole("textbox", { name: "Message" });
  await app.user.type(field, "Keep my draft");
  const shown = app.shown();
  const transcript = screen.getByRole("region", { name: "Transcript" });
  transcript.scrollTop = 125;
  await app.user.click(trigger);
  await screen.findByRole("dialog", { name: "Mode" });
  await app.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mode" })).toBeNull());
  expect((field as HTMLTextAreaElement).value).toBe("Keep my draft");
  expect(app.shown()).toEqual(shown);
  expect(transcript.scrollTop).toBe(125);
  expect(env.requests("permissions.mode.set")).toHaveLength(0);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("focuses an enabled fallback when the stored selection is above the ceiling, and recovers focus from the outer sheet", async () => {
  const { app, sheet } = await openMode({ sessions: [{ title: "Receipts", mode: "bypassPermissions" }] });
  const close = within(sheet).getByRole("button", { name: "Close mode picker" });
  expect(document.activeElement).toBe(close);
  act(() => sheet.focus());
  expect(document.activeElement).toBe(close);
  await app.user.keyboard("{Tab}");
  expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "plan" }));
  act(() => sheet.focus());
  await app.user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "accept edits" }));
});

it("keeps a reopened sheet and its retry alert when a dismissed opening completes", async () => {
  const { app, env, sheet, trigger } = await openMode();
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const dispatch = app.runtime.commands.dispatch.bind(app.runtime.commands);
  const pending = vi.spyOn(app.runtime.commands, "dispatch")
    .mockReturnValueOnce(first.then(() => dispatch(env.environmentId, "permissions.mode.set", { sessionId: env.sessionId(), mode: "plan" })))
    .mockReturnValueOnce(second.then(() => ({ ok: false, commandId: null, error: { code: "forbidden", message: "Reconnect to try again." } })));
  onTestFinished(() => { pending.mockRestore(); });
  await app.user.click(within(sheet).getByRole("button", { name: "plan" }));
  await app.user.click(within(sheet).getByRole("button", { name: "Close mode picker" }));
  await app.user.click(trigger);
  const reopened = await screen.findByRole("dialog", { name: "Mode" });
  await app.user.click(within(reopened).getByRole("button", { name: "accept edits" }));
  expect(pending).toHaveBeenCalledTimes(2);
  await act(async () => { releaseFirst(); await pending.mock.results[0]?.value; });
  await waitFor(() => expect(trigger.getAttribute("aria-label")).toBe("Mode: plan"));
  expect(screen.getByRole("dialog", { name: "Mode" })).toBe(reopened);
  act(() => releaseSecond());
  expect((await within(reopened).findByRole("alert")).textContent).toContain("Reconnect to try again.");
  await app.user.click(within(reopened).getByRole("button", { name: "accept edits" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mode" })).toBeNull());
});
