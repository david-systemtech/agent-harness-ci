import { DEFAULT_THEME } from "@agent-harness/contracts";
import { cssVariables, derive, type LadderName } from "@agent-harness/theme";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { renderApp } from "../test/harness.js";

/**
 * The tokens on the root (ADR 0023): before anything else is known the
 * window paints the preset theme's tokens as CSS variables on the root, the
 * ladder the OS prefers, and the stylesheet's inline theme reads them.
 */

/** The OS's colour scheme, as the window's media query reports it. */
const preferring = (scheme: LadderName) => {
  const had = Object.getOwnPropertyDescriptor(window, "matchMedia");
  window.matchMedia = (query: string) => ({ matches: query === `(prefers-color-scheme: ${scheme})`, media: query }) as MediaQueryList;
  onTestFinished(() => {
    if (had) Object.defineProperty(window, "matchMedia", had);
    else Reflect.deleteProperty(window, "matchMedia");
  });
};

/** Every variable on the root the preset's `ladder` names, and the root's value for it. */
const painted = (ladder: LadderName) => {
  const expected = cssVariables(derive(DEFAULT_THEME)[ladder]);
  return {
    expected,
    actual: Object.fromEntries(Object.keys(expected).map((name) => [name, document.documentElement.style.getPropertyValue(name)])),
  };
};

beforeEach(() => document.documentElement.removeAttribute("style"));

describe("the tokens on the root", () => {
  it("are the preset theme's dark ladder when nothing else is known, the browser's own controls drawn dark", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const { expected, actual } = painted("dark");
    expect(actual).toEqual(expected);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("are the preset's light ladder when the OS prefers light", async () => {
    preferring("light");
    await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const { expected, actual } = painted("light");
    expect(actual).toEqual(expected);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});
