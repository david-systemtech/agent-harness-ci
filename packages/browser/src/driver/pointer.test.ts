import { describe, expect, it } from "vitest";
import { driven } from "../../test/driven.js";
import { CdpFailure } from "../testing/index.js";

const coordinate = (x = 100, y = 200) => ({ type: "coordinate", x, y } as const);

describe("pointer input over the scripted CDP peer", () => {
  it.each([
    ["left_click", "left", 1, 1], ["right_click", "right", 2, 1], ["middle_click", "middle", 4, 1],
    ["double_click", "left", 1, 2], ["triple_click", "left", 1, 3],
  ] as const)("%s dispatches the button and click count with held modifiers", async (verb, button, buttons, count) => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform(verb, { target: coordinate(), modifiers: "ctrl+shift" })).toMatchObject({ ok: true });
    const mouse = peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params);
    expect(mouse[0]).toMatchObject({ type: "mouseMoved", x: 100, y: 200, modifiers: 10 });
    expect(mouse.slice(1)).toEqual(Array.from({ length: count }, (_, index) => [
      { type: "mousePressed", x: 100, y: 200, button, buttons, clickCount: index + 1, modifiers: 10 },
      { type: "mouseReleased", x: 100, y: 200, button, buttons: 0, clickCount: index + 1, modifiers: 10 },
    ]).flat());
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => [params.key, params.type, params.modifiers])).toEqual([
      ["Control", "keyDown", 2], ["Shift", "keyDown", 10], ["Shift", "keyUp", 2], ["Control", "keyUp", 0],
    ]);
  });
});

describe("hover and dragging", () => {
  it("hovers a ref at the frame-adjusted centre without pressing a button", async () => {
    const { peer, perform } = await driven();
    peer.inPage("locateElement", () => ({ kind: "found", x: 320, y: 240, editable: false }));
    peer.inPage("snapshotFrame", () => ({ nodes: [], lastRef: 1 }));
    await perform("open", { url: "https://example.com/" });
    await perform("snapshot", {});
    expect(await perform("hover", { target: { type: "ref", ref: "e1" } })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params)).toEqual([{ type: "mouseMoved", x: 320, y: 240, buttons: 0 }]);
  });

  it("keeps the left button held across down, move and up calls", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("left_mouse_down", { target: coordinate() })).toMatchObject({ ok: true });
    expect(await perform("mouse_move", { target: coordinate(400, 200) })).toMatchObject({ ok: true });
    expect(await perform("left_mouse_up", { target: coordinate(400, 200) })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params)).toEqual([
      { type: "mouseMoved", x: 100, y: 200, buttons: 0 },
      { type: "mousePressed", x: 100, y: 200, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseMoved", x: 400, y: 200, button: "left", buttons: 1 },
      { type: "mouseReleased", x: 400, y: 200, button: "left", buttons: 0, clickCount: 1 },
    ]);
  });

  it("drags through intermediate points with the button held, then releases", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("left_click_drag", { from: coordinate(), target: coordinate(400, 200) })).toMatchObject({ ok: true });
    const mouse = peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params);
    expect(mouse[1]).toMatchObject({ type: "mousePressed", x: 100, y: 200, buttons: 1 });
    expect(mouse.slice(2, -1)).toHaveLength(10);
    expect(mouse.slice(2, -1).every((event) => event.type === "mouseMoved" && event.buttons === 1)).toBe(true);
    expect(mouse.at(-2)).toMatchObject({ x: 400, y: 200 });
    expect(mouse.at(-1)).toMatchObject({ type: "mouseReleased", x: 400, y: 200, buttons: 0 });
  });

  it("releases a drag after a failed move and refuses bad endpoints before pressing", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("left_click_drag", { from: coordinate(), target: coordinate(1280, 200) })).toMatchObject({ ok: false });
    expect(peer.sentOf("Input.dispatchMouseEvent")).toHaveLength(0);
    peer.answer("Input.dispatchMouseEvent", ({ params }) => {
      if (params.type === "mouseMoved" && params.buttons === 1) throw new CdpFailure("move failed");
      return {};
    });
    expect(await perform("left_click_drag", { from: coordinate(), target: coordinate(400, 200) })).toMatchObject({ ok: false });
    expect(peer.sentOf("Input.dispatchMouseEvent").at(-1)?.params).toMatchObject({ type: "mouseReleased", buttons: 0 });
  });
});

describe("releasing a session's pointer", () => {
  it("releases a held button before letting go of the session's page", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    await perform("left_mouse_down", { target: coordinate() });
    expect(await perform("close", {})).toEqual({ ok: true, value: null });
    expect(peer.sentOf("Input.dispatchMouseEvent").at(-1)?.params).toMatchObject({ type: "mouseReleased", x: 100, y: 200, buttons: 0 });
  });
});
