import { describe, expect, it } from "vitest";
import { desktopLabel, desktopPicker } from "./desktops.js";

/** The desktop picker (#2161): three rows, the field marked (null as none), and why the latest run has none when it asked for one. */
describe("desktopPicker", () => {
  it("lists none, contained and local, marking the session's field and a null field as none", () => {
    expect(desktopPicker(null).rows.map((row) => [row.value.kind, row.label, row.selected])).toEqual([
      ["none", "No desktop", true],
      ["contained", "Contained desktop", false],
      ["local", "This computer's desktop", false],
    ]);
    expect(desktopPicker(undefined).chosen).toEqual({ kind: "none" });
    expect(desktopPicker({ kind: "contained" }).rows.filter((row) => row.selected).map((row) => row.value.kind)).toEqual(["contained"]);
    expect(desktopLabel("local")).toBe("This computer's desktop");
  });

  it("names the latest run's refusal only when it resolved to none for a reason other than none", () => {
    const refused = { requested: { kind: "contained" as const }, desktop: { kind: "none" as const }, reason: "operator-disabled" as const, message: "desktop.contained.allowRuns is off." };
    expect(desktopPicker({ kind: "contained" }, refused).refused).toEqual(refused);
    expect(desktopPicker(null, { requested: { kind: "none" }, desktop: { kind: "none" }, reason: "none", message: "No desktop requested." }).refused).toBeNull();
    expect(desktopPicker({ kind: "contained" }, { requested: { kind: "contained" }, desktop: { kind: "contained" }, reason: "selected", message: "The run drives the contained desktop." }).refused).toBeNull();
    expect(desktopPicker({ kind: "local" }).refused).toBeNull();
  });
});
