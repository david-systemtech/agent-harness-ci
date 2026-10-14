import { COMPUTER_MEMBERS, type JsonObject, type RunDesktopResolution, type SessionDesktop } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { scriptedDesktop, type ScriptedDesktop } from "../../test/scripted-desktop.js";
import type { HostToolResult } from "../adapter/contract.js";
import { COMPUTER_TOOL_SERVER, FRAMES_KEPT, createComputerToolServers, type DesktopDrivers } from "./tool-server.js";
import { containedDesktopDriver } from "./unavailable.js";

/**
 * The `computer` tool server over a scripted desktop (computer spec, "Driver
 * and tool surface"; #2161): each member makes the driver calls it should,
 * in physical pixels, and answers what the model reads; coordinates are
 * refused outside the screenshot or after the display changed; a kind with
 * no driver, or the contained stub, answers why.
 */

const CONTAINED: SessionDesktop = { kind: "contained" };
const resolved = (desktop: SessionDesktop): RunDesktopResolution => ({ requested: desktop, desktop, reason: desktop.kind === "none" ? "none" : "selected", message: desktop.kind === "none" ? "No desktop was chosen." : "The session's field names it." });

const serversWith = (options: { readonly drivers?: DesktopDrivers; readonly desktop?: SessionDesktop; readonly live?: boolean; readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) => {
  const desktop = scriptedDesktop();
  const runDesktop = options.desktop ?? CONTAINED;
  let runId = "run-1";
  const serverFor = createComputerToolServers({
    live: () => (options.live === false ? null : { runId, desktop: resolved(runDesktop) }),
    drivers: options.drivers ?? { contained: () => desktop },
    ...(options.sleep !== undefined && { sleep: options.sleep }),
  });
  const call = (name: string, input: JsonObject = {}, signal?: AbortSignal): Promise<HostToolResult> => {
    const tool = serverFor({ sessionId: "session-1", desktop: CONTAINED })?.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.call(input, { toolCallId: "toolu_1", ...(signal !== undefined && { signal }) });
  };
  return { desktop, call, serverFor, nextRun: () => (runId = "run-2") };
};

/** The log after the screenshot that establishes the frame. */
const after = (desktop: ScriptedDesktop, from = 1) => desktop.log.slice(from);

describe("the computer tool server", () => {
  it("is offered under the server name computer with the toolset's members, and not on a run without a desktop", () => {
    const { serverFor } = serversWith();
    const server = serverFor({ sessionId: "session-1", desktop: CONTAINED });
    expect(server?.name).toBe(COMPUTER_TOOL_SERVER);
    expect(server?.tools.map((tool) => tool.name)).toEqual([...COMPUTER_MEMBERS]);
    expect(server?.tools.find((tool) => tool.name === "left_click")?.inputSchema).toMatchObject({ type: "object", properties: { coordinate: { type: "array" }, text: { type: "string" } }, additionalProperties: false });
    // Observation is read-only to the provider's mode; pointer and keyboard members are not.
    expect(server?.tools.filter((tool) => tool.readOnly === true).map((tool) => tool.name)).toEqual(["screenshot", "zoom", "cursor_position", "wait"]);
    expect(serverFor({ sessionId: "session-1", desktop: { kind: "none" } })).toBeNull();
  });

  it("answers a screenshot as an image with its size, and keeps its frame for coordinates", async () => {
    const { desktop, call } = serversWith();
    const shot = await call("screenshot");
    expect(shot.isError).toBe(false);
    expect(shot.text).toContain("1280×800 screenshot pixels (display 2560×1600)");
    expect(shot.images?.[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(shot.images?.[0]?.data ?? []).toString()).toBe("scripted screen");
    expect(desktop.log).toEqual([{ operation: "capture", args: { longEdge: 1280 } }]);
  });

  it("maps every pointer member's screenshot pixels to physical ones, with its button, count and modifiers", async () => {
    const { desktop, call } = serversWith();
    await call("screenshot");
    expect((await call("left_click", { coordinate: [100, 50] })).text).toBe("Clicked (left_click) at [100, 50].");
    await call("right_click", { coordinate: [10, 10], text: "ctrl+shift" });
    await call("middle_click");
    await call("double_click", { coordinate: [1, 1] });
    await call("triple_click", { coordinate: [2, 2] });
    await call("left_click_drag", { start_coordinate: [0, 0], coordinate: [640, 400], text: "alt" });
    await call("mouse_move", { coordinate: [5, 6] });
    await call("scroll", { scroll_direction: "down", scroll_amount: 3, coordinate: [7, 8] });
    await call("left_mouse_down");
    await call("left_mouse_up");
    expect(after(desktop).filter((command) => command.operation !== "geometry")).toEqual([
      { operation: "click", args: { button: "left", count: 1, at: { x: 200, y: 100 }, modifiers: [] } },
      { operation: "click", args: { button: "right", count: 1, at: { x: 20, y: 20 }, modifiers: ["ctrl", "shift"] } },
      { operation: "click", args: { button: "middle", count: 1, modifiers: [] } },
      { operation: "click", args: { button: "left", count: 2, at: { x: 2, y: 2 }, modifiers: [] } },
      { operation: "click", args: { button: "left", count: 3, at: { x: 4, y: 4 }, modifiers: [] } },
      { operation: "drag", args: { from: { x: 0, y: 0 }, to: { x: 1280, y: 800 }, modifiers: ["alt"] } },
      { operation: "move", args: { to: { x: 10, y: 12 } } },
      { operation: "scroll", args: { direction: "down", amount: 3, at: { x: 14, y: 16 }, modifiers: [] } },
      { operation: "mouse_down", args: { button: "left" } },
      { operation: "mouse_up", args: { button: "left" } },
    ]);
  });

  it("types, presses a key sequence repeated, and holds a key, which need no screenshot", async () => {
    const { desktop, call } = serversWith();
    expect((await call("type", { text: "hello" })).text).toBe("Typed 5 characters.");
    expect((await call("key", { text: "ctrl+a Delete", repeat: 2 })).text).toBe("Pressed ctrl+a Delete 2 times.");
    expect((await call("hold_key", { text: "shift", duration: 1.5 })).isError).toBe(false);
    expect(desktop.log).toEqual([
      { operation: "type", args: { text: "hello" } },
      { operation: "key", args: { chords: [["ctrl", "a"], ["Delete"]], repeat: 2 } },
      { operation: "hold_key", args: { keys: ["shift"], durationMs: 1500 } },
    ]);
  });

  it("answers the cursor and zooms in screenshot pixels, the zoom region mapped to physical ones", async () => {
    const { desktop, call } = serversWith();
    await call("screenshot");
    await call("mouse_move", { coordinate: [300, 200] });
    expect((await call("cursor_position")).text).toBe("The pointer is at [300, 200].");
    const zoomed = await call("zoom", { region: [100, 100, 200, 150] });
    expect(zoomed.images).toHaveLength(1);
    expect(desktop.log.at(-1)).toEqual({ operation: "zoom", args: { region: { x0: 200, y0: 200, x1: 400, y1: 300 }, longEdge: 1280 } });
  });

  it("waits on its clock and then takes a screenshot", async () => {
    const waited: number[] = [];
    const { desktop, call } = serversWith({ sleep: async (ms) => void waited.push(ms) });
    const result = await call("wait", { duration: 2 });
    expect(waited).toEqual([2000]);
    expect(result.images).toHaveLength(1);
    expect(desktop.log).toEqual([{ operation: "capture", args: { longEdge: 1280 } }]);
  });

  it("refuses coordinates before a screenshot, outside it, or after the display changed, never clamping", async () => {
    const { desktop, call } = serversWith();
    expect(await call("left_click", { coordinate: [1, 1] })).toEqual({ text: expect.stringContaining("Take a screenshot first") as string, isError: true });
    await call("screenshot");
    expect(await call("left_click", { coordinate: [1280, 10] })).toEqual({ text: "The coordinate [1280, 10] is outside the screenshot, which is 1280×800.", isError: true });
    expect((await call("left_click_drag", { start_coordinate: [0, 900], coordinate: [1, 1] })).text).toContain("start_coordinate [0, 900] is outside");
    expect((await call("zoom", { region: [0, 0, 1300, 10] })).isError).toBe(true);
    expect((await call("zoom", { region: [10, 10, 10, 20] })).text).toContain("is empty");
    desktop.setGeometry({ displayId: "scripted", width: 1920, height: 1080, originX: 0, originY: 0 });
    expect((await call("left_click", { coordinate: [1, 1] })).text).toContain("The display changed");
    expect((await call("left_click", { coordinate: [1, 1] })).text).toContain("Take a screenshot first");
    expect(desktop.log.some((command) => command.operation === "click")).toBe(false);
  });

  it("forgets the frame when the session's run changes", async () => {
    const { call, nextRun } = serversWith();
    await call("screenshot");
    nextRun();
    expect((await call("mouse_move", { coordinate: [1, 1] })).text).toContain("Take a screenshot first");
  });

  it("keeps the frames of the most recently captured sessions only", async () => {
    const desktop = scriptedDesktop();
    const serverFor = createComputerToolServers({ live: (sessionId) => ({ runId: `run-of-${sessionId}`, desktop: resolved(CONTAINED) }), drivers: { contained: () => desktop } });
    const tool = (sessionId: string, name: string) => serverFor({ sessionId, desktop: CONTAINED })?.tools.find((candidate) => candidate.name === name);
    for (let index = 0; index <= FRAMES_KEPT; index += 1) await tool(`session-${index}`, "screenshot")?.call({}, { toolCallId: null });
    expect((await tool("session-0", "mouse_move")?.call({ coordinate: [1, 1] }, { toolCallId: null }))?.text).toContain("Take a screenshot first");
    expect((await tool("session-1", "mouse_move")?.call({ coordinate: [1, 1] }, { toolCallId: null }))?.isError).toBe(false);
  });

  it("refuses input it does not take, and answers a driver's refusal or failure as an error result", async () => {
    const { desktop, call } = serversWith();
    expect((await call("left_click", { coordinate: [-1, 0] })).text).toMatch(/^left_click was given input it does not take/);
    desktop.refuseNext("type", { code: "locked", reason: "The desktop is locked." });
    expect(await call("type", { text: "x" })).toEqual({ text: "The desktop is locked.", isError: true });
    const throwing = serversWith({ drivers: { contained: () => ({ kind: "scripted", abilities: ["keyboard"], perform: () => Promise.reject(new Error("socket closed")) }) } });
    expect(await throwing.call("type", { text: "x" })).toEqual({ text: "The desktop failed: socket closed", isError: true });
  });

  it("reports a member the driver cannot do as unavailable rather than faking it", async () => {
    const { call } = serversWith({ drivers: { contained: () => scriptedDesktop({ abilities: ["capture", "pointer"] }) } });
    expect(await call("zoom", { region: [0, 0, 10, 10] })).toEqual({ text: "This desktop cannot zoom, so zoom is unavailable.", isError: true });
    expect((await call("type", { text: "x" })).text).toBe("This desktop cannot type or press keys, so type is unavailable.");
  });

  it("releases every held key when a hold_key call is cancelled", async () => {
    const { desktop, call } = serversWith();
    desktop.holdUntilReleased();
    const controller = new AbortController();
    const held = call("hold_key", { text: "shift", duration: 300 }, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await held).toEqual({ text: "The call was cancelled; every held key was released.", isError: true });
    expect(desktop.log.map((command) => command.operation)).toEqual(["hold_key", "release"]);
  });

  it("runs one session's calls one at a time", async () => {
    const { desktop, call } = serversWith();
    desktop.holdUntilReleased();
    const controller = new AbortController();
    const held = call("hold_key", { text: "shift", duration: 300 }, controller.signal);
    const typed = call("type", { text: "after" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(desktop.log.map((command) => command.operation)).toEqual(["hold_key"]);
    controller.abort();
    await Promise.all([held, typed]);
    expect(desktop.log.map((command) => command.operation)).toEqual(["hold_key", "release", "type"]);
  });

  it("answers why when there is no run, no desktop, no driver for the kind, or only the contained stub", async () => {
    expect((await serversWith({ live: false }).call("screenshot")).text).toBe("This session has no run in progress, so there is no desktop to drive.");
    expect((await serversWith({ desktop: { kind: "none" } }).call("screenshot")).text).toBe("This run has no desktop: No desktop was chosen.");
    expect((await serversWith({ drivers: {} }).call("screenshot")).text).toBe("This environment cannot drive a contained desktop yet.");
    const stub = serversWith({ drivers: { contained: () => containedDesktopDriver(null) } });
    expect(await stub.call("screenshot")).toEqual({ text: expect.stringContaining("The contained desktop is not available on this environment: none is configured.") as string, isError: true });
    expect((await serversWith({ drivers: { contained: () => containedDesktopDriver({ host: "desktop", port: 5900 }) } }).call("type", { text: "x" })).text).toContain("cannot connect to desktop:5900");
  });
});
