// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { LADDERS, SHIPPED_THEMES, contrastRatio, cssVariables, derive, readCssColour } from "@agent-harness/theme";
import { afterEach, expect, it } from "vitest";
import { paintLadder } from "./theme/paint.js";
import { Select } from "./ui/select.js";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
// jsdom does not apply cascade layers; the base rules themselves are ordinary CSS.
const base = /@layer base \{([\s\S]*?)\n\}/.exec(stylesheet)?.[1];
let style: HTMLStyleElement;

afterEach(() => {
  style?.remove();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset["ladder"];
});

it.each(LADDERS)("native dropdown rows have a theme background and readable text in %s", ladderName => {
  expect(base).toBeDefined();
  style = document.createElement("style");
  style.textContent = base!;
  document.head.append(style);
  render(<>
    <Select aria-label="Shared picker" defaultValue="one">
      <option value="one">One</option>
      <optgroup label="More"><option value="two">Two</option><option disabled>Unavailable</option></optgroup>
    </Select>
    <select aria-label="Plain picker" defaultValue="plain"><option value="plain">Plain</option></select>
  </>);

  for (const theme of SHIPPED_THEMES) {
    const ladder = derive(theme)[ladderName];
    paintLadder(document.documentElement, ladder, ladderName);
    expect(document.documentElement.style.colorScheme).toBe(ladderName);
    const variables = cssVariables(ladder);
    for (const picker of screen.getAllByRole("combobox")) {
      for (const row of picker.querySelectorAll("option, optgroup")) {
        const computed = getComputedStyle(row);
        expect(computed.color).toBe("var(--ink)");
        expect(computed.backgroundColor).toBe("var(--float)");
        const foreground = readCssColour(variables["--ink"]!);
        const background = readCssColour(variables["--float"]!);
        expect(foreground).toBeDefined();
        expect(background).toBeDefined();
        expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
