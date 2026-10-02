import { describe, expect, it } from "vitest";
import { terminalAnswers } from "./answers.js";

describe("terminal startup answers", () => {
  it("answers the initial snapshot and live output for one second without focus, then only focused live output", () => {
    let now = 100;
    const answers = terminalAnswers(() => now);
    expect(answers.take("reset", false, false)).toBe(false);
    answers.start();
    expect(answers.take("reset", false, false)).toBe(true);
    expect(answers.take("reset", false, true)).toBe(false);
    expect(answers.take("output", true, false)).toBe(true);
    expect(answers.take("output", false, true)).toBe(false);
    now += 1000;
    expect(answers.take("output", true, false)).toBe(false);
    expect(answers.take("output", true, true)).toBe(true);
  });
});
