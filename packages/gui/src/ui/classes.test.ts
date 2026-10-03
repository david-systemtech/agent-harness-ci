/* eslint-disable agent-harness/no-unmapped-colour-class -- text-2xs is the typography step declared in styles.css, not a colour. */
import { describe, expect, it } from "vitest";
import { cn, classes } from "./classes.js";

describe("primitive class overrides", () => {
  it("lets callers override utility groups while keeping the small text scale separate from colour", () => {
    expect(cn("h-8 text-sm text-ink", { "h-9": true }, ["text-2xs", "text-ink-muted"], false)).toBe("h-9 text-2xs text-ink-muted");
    expect(cn("text-2xs text-ink-muted", "text-xs")).toBe("text-ink-muted text-xs");
    expect(cn("px-3", undefined, "", "px-2")).toBe("px-2");
    expect(classes("px-3", false, "px-2")).toBe("px-2");
  });
});
