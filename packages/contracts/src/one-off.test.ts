import { describe, expect, it } from "vitest";
import { oneOffOutput } from "./one-off.js";

describe("a one-off's output", () => {
  it("keeps all output, including text that used to resemble a marker", () => {
    const heard = oneOffOutput();
    heard.take("agent-harness-one-off-t1\n");
    heard.take("hi\n");
    expect(heard.said()).toEqual({ text: "agent-harness-one-off-t1\nhi\n", cut: false, dropped: false });
  });
  it("bounds output and keeps the cut after a snapshot replaces it", () => {
    const heard = oneOffOutput(4);
    heard.take("abcdef");
    expect(heard.said()).toEqual({ text: "abcd", cut: true, dropped: false });
    heard.reset("tail", true);
    expect(heard.said()).toEqual({ text: "tail", cut: true, dropped: true });
    heard.reset("end");
    expect(heard.said().dropped).toBe(true);
  });
});
