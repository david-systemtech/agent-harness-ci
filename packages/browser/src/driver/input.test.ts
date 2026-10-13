import { describe, expect, it } from "vitest";
import { CdpFailure } from "../testing/index.js";
import { driven, manualClock } from "../../test/driven.js";

describe("keyboard input over the scripted CDP peer", () => {
  it("presses Enter with a virtual key and text, then releases it", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("key", { text: "Enter" })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => params)).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", modifiers: 0 },
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
    ]);
  });
  it("repeats a chord sequence with modifier state and no literal text for shortcuts", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("key", { text: "ctrl+shift+a Tab", repeat: 2 })).toMatchObject({ ok: true });
    const keys = peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => params);
    expect(keys.map(({ key, type, modifiers }) => [key, type, modifiers])).toEqual([
      ["Control", "keyDown", 2], ["Shift", "keyDown", 10], ["A", "keyDown", 10],
      ["A", "keyUp", 10], ["Shift", "keyUp", 2], ["Control", "keyUp", 0],
      ["Tab", "keyDown", 0], ["Tab", "keyUp", 0],
      ["Control", "keyDown", 2], ["Shift", "keyDown", 10], ["A", "keyDown", 10],
      ["A", "keyUp", 10], ["Shift", "keyUp", 2], ["Control", "keyUp", 0],
      ["Tab", "keyDown", 0], ["Tab", "keyUp", 0],
    ]);
    expect(keys.every((key) => key.text === undefined)).toBe(true);
  });

  it("rejects a malformed sequence before pressing any key", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("key", { text: "Enter UnknownKey" })).toMatchObject({ ok: false, reason: expect.stringContaining("Unknown key") });
    expect(peer.sentOf("Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("releases keys after a failed dispatch", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.answer("Input.dispatchKeyEvent", ({ params }) => {
      if (params.type === "keyDown" && params.key === "a") throw new CdpFailure("input failed");
      return {};
    });
    expect(await perform("key", { text: "ctrl+a" })).toMatchObject({ ok: false });
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => [params.key, params.type])).toEqual([
      ["Control", "keyDown"], ["a", "keyDown"], ["a", "keyUp"], ["Control", "keyUp"],
    ]);
  });

  it("holds a chord on the driver's clock, then releases it in reverse order", async () => {
    const clock = manualClock();
    const { peer, perform } = await driven({ clock });
    await perform("open", { url: "https://example.com/" });
    const held = perform("hold_key", { text: "ctrl+a", duration: 30 });
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => params.type)).toEqual(["keyDown", "keyDown"]);
    clock.advance(30_000);
    await expect.poll(() => peer.sentOf("Input.dispatchKeyEvent").length, { timeout: 30_000 }).toBe(4);
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    clock.advance(250);
    expect(await held).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchKeyEvent").slice(2).map(({ params }) => [params.key, params.modifiers])).toEqual([["a", 2], ["Control", 0]]);
  });
});

describe("form input over the scripted CDP peer", () => {
  it("sets a ref's value in its isolated world and refuses stale or unsuitable controls", async () => {
    const { peer, perform } = await driven();
    peer.inPage("snapshotFrame", () => ({ nodes: [], lastRef: 1 }));
    peer.inPage("setFormValue", () => "set");
    await perform("open", { url: "https://example.com/" });
    await perform("snapshot", {});
    expect(await perform("form_input", { target: { type: "ref", ref: "e1" }, value: true })).toMatchObject({ ok: true });
    const calls = peer.sentOf("Runtime.callFunctionOn").filter(({ params }) => String(params.functionDeclaration).startsWith("function setFormValue("));
    expect(calls.at(-1)?.params.arguments).toEqual([{ value: "e1" }, { value: true }]);
    expect(calls.at(-1)?.params.executionContextId).toBe(1);
    peer.inPage("setFormValue", () => "gone");
    expect(await perform("form_input", { target: { type: "ref", ref: "e1" }, value: false })).toMatchObject({ ok: false, reason: expect.stringContaining("Take a new snapshot") });
    peer.inPage("setFormValue", () => "The form control is disabled.");
    expect(await perform("form_input", { target: { type: "ref", ref: "e1" }, value: true })).toEqual({ ok: false, reason: "The form control is disabled." });
  });
});

describe("keyboard policy interruption", () => {
  it("stops a sequence when Enter reaches a denylisted destination and still releases the key", async () => {
    const { peer, perform, page } = await driven({ policy: { devSites: [], deepReadEverywhere: false, evaluateEverywhere: false, browserDomains: [{ id: "blocked-for-tests", pattern: "blocked.example", note: "", enabled: true, preset: false }] } });
    await perform("open", { url: "https://example.com/" });
    peer.answer("Input.dispatchKeyEvent", ({ params }) => {
      if (params.type === "keyDown" && params.key === "Enter") page().navigate("https://blocked.example/");
      return {};
    });
    expect(await perform("key", { text: "Enter Tab", repeat: 2 })).toMatchObject({ ok: false, denylist: { frame: "top-level" } });
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => [params.key, params.type])).toEqual([["Enter", "keyDown"], ["Enter", "keyUp"]]);
  });
});

describe("printable keyboard keys", () => {
  it("types a shifted letter and punctuation with their physical key codes", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("key", { text: "shift+a /" })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchKeyEvent").filter(({ params }) => params.type === "keyDown").map(({ params }) => [params.key, params.code, params.text, params.modifiers])).toEqual([
      ["Shift", "ShiftLeft", undefined, 8], ["A", "KeyA", "A", 8], ["/", "Slash", "/", 0],
    ]);
  });
});
