import { describe, expect, it } from "vitest";
import { TERMINAL_WRITE_CAP, nextWrite } from "./writes.js";

describe("the next write to a terminal", () => {
  it("carries everything up to the cap, and never splits a character of two code units across two writes", () => {
    expect(nextWrite("ls\r")).toBe("ls\r");
    expect(nextWrite("a".repeat(TERMINAL_WRITE_CAP + 5))).toHaveLength(TERMINAL_WRITE_CAP);
    const straddling = `${"a".repeat(TERMINAL_WRITE_CAP - 1)}😀b`;
    expect(nextWrite(straddling)).toBe("a".repeat(TERMINAL_WRITE_CAP - 1));
  });
});
