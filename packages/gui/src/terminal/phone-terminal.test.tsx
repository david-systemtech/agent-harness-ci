import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { chooseHeaderAction } from "../../test/header-actions.js";
import { sideColumnKey } from "../presentation.js";
import { renderApp } from "../../test/harness.js";

const TERMINAL = "7e000000-0000-4000-8000-000000000001";

const phone = async (terminalScope = true) => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(max-width: 639px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined })
    : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "paired", scopes: terminalScope ? ["read", "sessions:write", "runs:drive", "terminal"] : ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Receipts" }], terminals: [{ id: TERMINAL, output: "receipt total: 42\r\n$ " }] }] });
  app.open("desk");
  await screen.findByRole("textbox", { name: "Message" });
  if (terminalScope) await chooseHeaderAction(app, "Terminal");
  else act(() => app.presentation.set("sideColumns", { [sideColumnKey(app.shown()!)]: { open: ["terminal"], shown: "terminal", hidden: false } }));
  const pane = within(screen.getByRole("region", { name: "Terminal" }));
  if (terminalScope) await waitFor(() => expect(pane.getByLabelText("Terminal screen").textContent).toContain("receipt total: 42"));
  return { app, pane, env: app.environment("desk") };
};

it("sends phone Ctrl, Escape and Tab to the environment terminal and restores input focus", async () => {
  const { app, pane, env } = await phone();
  const ctrl = pane.getByRole("button", { name: "Ctrl" });
  await app.user.click(ctrl);
  expect(ctrl.getAttribute("aria-pressed")).toBe("true");
  await app.user.keyboard("c");
  await waitFor(() => expect(env.terminal(TERMINAL).writes).toEqual(["\x03"]));
  expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  await app.user.click(pane.getByRole("button", { name: "Esc" }));
  await waitFor(() => expect(env.terminal(TERMINAL).writes).toEqual(["\x03", "\x1b"]));
  await app.user.click(pane.getByRole("button", { name: "Tab" }));
  await waitFor(() => expect(env.terminal(TERMINAL).writes).toEqual(["\x03", "\x1b", "\t"]));
  expect(document.activeElement).toBe(pane.getByLabelText("Terminal screen").querySelector("textarea"));
  expect(env.requests("terminals.open")).toEqual([]);
});

it("selects terminal output by touch and adds it to the session without losing its draft or selection", async () => {
  const { app, pane, env } = await phone();
  const message = screen.getByRole("textbox", { name: "Message" });
  await app.user.type(message, "Explain this:");
  const terminalScreen = pane.getByLabelText("Terminal screen").querySelector(".xterm-screen") as HTMLElement;
  vi.spyOn(terminalScreen, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 240, width: 800, height: 240, toJSON: () => ({}) });
  await app.user.click(pane.getByRole("button", { name: "Select" }));
  const selection = pane.getByLabelText("Select terminal text");
  const touch = (type: string, x: number) => act(() => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 5 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    selection.dispatchEvent(event);
  });
  touch("pointerdown", 0);
  touch("pointermove", 65);
  touch("pointerup", 65);
  await app.user.click(pane.getByRole("button", { name: "Add to session" }));
  await waitFor(() => expect((message as HTMLTextAreaElement).value).toBe("Explain this:\n\nreceipt"));
  expect(pane.getByRole("button", { name: "Add to session" })).toBeDefined();
  expect(env.requests("runs.start")).toEqual([]);
  expect(env.terminal(TERMINAL).writes).toEqual([]);
});

it("fits the keyboard viewport, retains the hidden PTY and closes it only from Close", async () => {
  const viewport = new EventTarget();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  onTestFinished(() => { delete (window as { visualViewport?: unknown }).visualViewport; });
  const { app, pane, env } = await phone();
  const { FitAddon } = await import("@xterm/addon-fit");
  vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({ cols: 32, rows: 10 });
  act(() => viewport.dispatchEvent(new Event("resize")));
  await waitFor(() => expect(env.terminal(TERMINAL).resizes).toContainEqual({ cols: 32, rows: 10 }));
  await chooseHeaderAction(app, "Terminal");
  expect(env.terminal(TERMINAL).closed).toBe(false);
  await chooseHeaderAction(app, "Terminal");
  await app.user.click(pane.getByRole("button", { name: "Close terminal" }));
  await waitFor(() => expect(env.terminal(TERMINAL).closed).toBe(true));
  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
});

it("explains deliberate re-pairing without terminal authority and sends no terminal requests", async () => {
  const { app, pane, env } = await phone(false);
  expect(pane.getByText(/Custom pairing code with terminal scope/)).toBeDefined();
  expect(pane.getByText(/without the terminal scope/)).toBeDefined();
  expect((pane.getByRole("button", { name: "Ctrl" }) as HTMLButtonElement).disabled).toBe(true);
  await app.user.click(pane.getByRole("button", { name: "Tab" }));
  for (const method of ["terminals.open", "terminals.list", "terminals.subscribe", "terminals.write"] as const) expect(env.requests(method)).toEqual([]);
});
