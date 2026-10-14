import { describe, expect, it } from "vitest";
import {
  COMPUTER_MEMBERS,
  COMPUTER_MEMBER_ABILITY,
  COMPUTER_MEMBER_CATEGORY,
  COMPUTER_MEMBER_INPUTS,
  DESKTOP_OPERATIONS,
  DESKTOP_OPERATION_SCHEMAS,
  DesktopCommand,
  DesktopOutcome,
  MODES,
  RunDesktopResolution,
  SessionDesktop,
  computerModeRuling,
  keyCombination,
  keySequence,
} from "./index.js";

/**
 * The desktop-driver contract (computer spec, "Driver and tool surface";
 * #2161): the toolset's members with the reference's input shapes, the
 * driver's operations in physical pixels, a refusal as a sentence, the
 * session's desktop and a run's resolution, and the mode table.
 */

const accepts = (member: keyof typeof COMPUTER_MEMBER_INPUTS, input: unknown): boolean => COMPUTER_MEMBER_INPUTS[member].safeParse(input).success;

describe("the computer toolset's members", () => {
  it("are the reference's seventeen, each with an input schema, a category and the ability it needs", () => {
    expect(COMPUTER_MEMBERS).toHaveLength(17);
    for (const member of COMPUTER_MEMBERS) {
      expect(COMPUTER_MEMBER_INPUTS[member]).toBeDefined();
      expect(COMPUTER_MEMBER_CATEGORY[member]).toBeDefined();
      expect(COMPUTER_MEMBER_ABILITY[member]).toBeDefined();
    }
  });

  it("take the reference's input shapes and refuse anything else", () => {
    expect(accepts("screenshot", {})).toBe(true);
    expect(accepts("screenshot", { coordinate: [1, 2] })).toBe(false);
    expect(accepts("zoom", { region: [0, 0, 100, 50] })).toBe(true);
    expect(accepts("left_click", {})).toBe(true);
    expect(accepts("left_click", { coordinate: [10, 20], text: "shift" })).toBe(true);
    expect(accepts("left_click", { coordinate: [-1, 20] })).toBe(false);
    expect(accepts("double_click", { coordinate: [1.5, 2] })).toBe(false);
    expect(accepts("left_click_drag", { start_coordinate: [0, 0], coordinate: [5, 5] })).toBe(true);
    expect(accepts("left_click_drag", { coordinate: [5, 5] })).toBe(false);
    expect(accepts("mouse_move", {})).toBe(false);
    expect(accepts("scroll", { scroll_direction: "down", scroll_amount: 3 })).toBe(true);
    expect(accepts("scroll", { scroll_direction: "sideways", scroll_amount: 3 })).toBe(false);
    expect(accepts("type", { text: "hello" })).toBe(true);
    expect(accepts("key", { text: "ctrl+s", repeat: 100 })).toBe(true);
    expect(accepts("key", { text: "ctrl+s", repeat: 101 })).toBe(false);
    expect(accepts("hold_key", { text: "shift", duration: 300 })).toBe(true);
    expect(accepts("hold_key", { text: "shift", duration: 301 })).toBe(false);
    expect(accepts("wait", { duration: 2 })).toBe(true);
    expect(accepts("left_mouse_down", {})).toBe(true);
  });
});

describe("the driver's operations", () => {
  it("each have arguments and a value, and a command names one", () => {
    expect(DESKTOP_OPERATIONS).toContain("capture");
    expect(DesktopCommand.safeParse({ operation: "click", args: { button: "left", count: 2, at: { x: 3, y: 4 }, modifiers: ["shift"] } }).success).toBe(true);
    expect(DesktopCommand.safeParse({ operation: "click", args: { button: "left", count: 4, modifiers: [] } }).success).toBe(false);
    expect(DesktopCommand.safeParse({ operation: "teleport", args: {} }).success).toBe(false);
    expect(DESKTOP_OPERATION_SCHEMAS.capture.value.safeParse({ image: { mimeType: "image/png", width: 1280, height: 800, data: "iVBORw0K" }, geometry: { displayId: "main", width: 2560, height: 1600, originX: 0, originY: 0 } }).success).toBe(true);
  });

  it("answer a value or a refusal with a code and a sentence", () => {
    expect(DesktopOutcome.safeParse({ ok: true, value: {} }).success).toBe(true);
    expect(DesktopOutcome.safeParse({ ok: false, code: "unavailable", reason: "No contained desktop is configured here." }).success).toBe(true);
    expect(DesktopOutcome.safeParse({ ok: false, code: "unavailable", reason: "" }).success).toBe(false);
  });
});

describe("the session's desktop and a run's resolution", () => {
  it("is none, contained or local, resolved with a reason and a message", () => {
    expect(SessionDesktop.safeParse({ kind: "contained" }).success).toBe(true);
    expect(SessionDesktop.safeParse({ kind: "vnc" }).success).toBe(false);
    expect(RunDesktopResolution.safeParse({ requested: { kind: "local" }, desktop: { kind: "none" }, reason: "unattended", message: "A live desktop needs an attended run." }).success).toBe(true);
  });
});

describe("the mode table", () => {
  it("lets plan observe only, asks for keyboard under acceptEdits, reviews input under auto and allows everything under bypass", () => {
    const table = Object.fromEntries(MODES.map((mode) => [mode, Object.fromEntries((["screenshot", "left_click", "type"] as const).map((member) => [member, computerModeRuling(mode, member)]))]));
    expect(table).toEqual({
      plan: { screenshot: "allow", left_click: "deny", type: "deny" },
      acceptEdits: { screenshot: "allow", left_click: "allow", type: "ask" },
      auto: { screenshot: "allow", left_click: "review", type: "review" },
      bypassPermissions: { screenshot: "allow", left_click: "allow", type: "allow" },
    });
    expect(computerModeRuling("plan", "wait")).toBe("allow");
    expect(computerModeRuling("acceptEdits", "hold_key")).toBe("ask");
  });

  it("splits a combination at its pluses, a lone plus being the plus key", () => {
    expect(keyCombination("ctrl+shift+t")).toEqual(["ctrl", "shift", "t"]);
    expect(keyCombination("Return")).toEqual(["Return"]);
    expect(keyCombination("+")).toEqual(["+"]);
    expect(keyCombination("ctrl++")).toEqual(["ctrl", "+"]);
    expect(keySequence("ctrl+a  Delete")).toEqual([["ctrl", "a"], ["Delete"]]);
  });
});
