// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const block = (opening: string) => {
  const start = stylesheet.indexOf(opening);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = stylesheet.indexOf("{", start); index < stylesheet.length; index++) {
    if (stylesheet[index] === "{") depth++;
    else if (stylesheet[index] === "}" && --depth === 0) return stylesheet.slice(start, index + 1);
  }
  throw new Error(`unclosed ${opening}`);
};
const declarations = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]);

// #2179: the working seam's beam animated left and right, layout properties, so every frame of every running pane forced layout.
it("moves the working seam's beam by transform alone, never by a layout property", () => {
  const keyframes = block("@keyframes shuttle");
  const animated = new Set(declarations(keyframes).filter(name => name !== "animation-timing-function"));
  expect([...animated]).toEqual(["transform"]);
  expect(keyframes).not.toMatch(/\b(left|right|width|inset[a-z-]*|margin[a-z-]*)\s*:/);
  // The same travel, cycle and easing as before: it grows from the left edge, holds full width, then runs out to the right.
  expect(keyframes).toMatch(/0% \{ transform: translateX\(0\) scaleX\(0\); animation-timing-function: cubic-bezier\(0\.3, 0, 0\.15, 1\); \}/);
  expect(keyframes).toMatch(/46% \{ transform: translateX\(0\) scaleX\(1\); animation-timing-function: linear; \}/);
  expect(keyframes).toMatch(/56% \{ transform: translateX\(0\) scaleX\(1\); animation-timing-function: cubic-bezier\(0\.55, 0, 0\.2, 1\); \}/);
  expect(keyframes).toMatch(/100% \{ transform: translateX\(100%\) scaleX\(0\); \}/);
  const beam = block(".shuttle::after {");
  expect(beam).toMatch(/animation: shuttle 1\.9s infinite;/);
  expect(beam).toMatch(/will-change: transform;/);
  expect(beam).toMatch(/transform-origin: left center;/);
  expect(beam).toMatch(/inset: 0;/);
});

it("keeps the reduced-motion seam still, at the same three quarters, with no layer held for it", () => {
  const reduced = block("@media (prefers-reduced-motion: reduce)");
  expect(reduced).toMatch(/\.shuttle::after \{ animation: none; will-change: auto; transform: none; right: 25%; \}/);
});

// #2201: composer/sweep.ts marks an off-screen seam and the hidden document; the beam is held still under either.
it("pauses the beam of an off-screen seam and of every seam while the window is hidden", () => {
  expect(stylesheet).toMatch(/\.shuttle\[data-sweep-offscreen\]::after, :root\[data-sweep-hidden\] \.shuttle::after \{ animation-play-state: paused; \}/);
});
