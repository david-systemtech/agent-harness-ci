import { describe, expect, it } from "vitest";
import { shellLine } from "./shell-line.js";

describe("a shell line", () => {
  it("is ! and a command to run, !! and a command whose output goes to the agent, the command as typed", () => {
    expect(shellLine("!git status")).toEqual({ send: false, command: "git status" });
    expect(shellLine("!! ls -la | head ")).toEqual({ send: true, command: "ls -la | head" });
    expect(shellLine("!")).toEqual({ send: false, command: "" });
    expect(shellLine("!!")).toEqual({ send: true, command: "" });
    expect(shellLine("hello !")).toBeNull();
  });
});
