import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { openStyled } from "./terminal/xterm-styles.js";
import { XTERM_FALLBACK_THEME } from "./terminal/xterm-fallback-theme.js";

/**
 * xterm.js under the window's content policy (#486; docs/specs/gui.md, "The
 * desktop shell"): the policy refuses the text of a `<style>` element a
 * script adds, and xterm.js styles itself with three, so the terminal pane
 * opens it with their text in stylesheets the document adopts, which the
 * policy does not cover. The policy the app scheme answers is held in
 * `packages/desktop/src/app-scheme.test.ts`.
 */

const opened: Terminal[] = [];
afterEach(() => {
  for (const terminal of opened.splice(0)) terminal.dispose();
  document.body.replaceChildren();
});

const terminalIn = (theme = { foreground: XTERM_FALLBACK_THEME.foreground }) => {
  const parent = document.body.appendChild(document.createElement("div"));
  const terminal = new Terminal({ cols: 20, rows: 4, theme });
  opened.push(terminal);
  return { parent, terminal };
};

/** Every rule the document's adopted stylesheets hold, as text. */
const adoptedRules = () =>
  document.adoptedStyleSheets
    .flatMap((sheet) => [...sheet.cssRules])
    .map((rule) => rule.cssText)
    .join("\n");

/** A colour as the stylesheet's rules write it back: the CSSOM's own spelling of it. */
const asWritten = (colour: string) => {
  const probe = document.createElement("span");
  probe.style.color = colour;
  return probe.style.color;
};

describe("xterm.js under the content policy", () => {
  it("adds <style> elements of its own when opened plainly, which the policy refuses", () => {
    const { parent, terminal } = terminalIn();
    terminal.open(parent);
    expect(document.querySelectorAll("style").length).toBeGreaterThan(0);
  });

  it("opens with no <style> element, its scroll bar's, colours' and cells' rules in stylesheets the document adopts", () => {
    const { parent, terminal } = terminalIn();
    openStyled(terminal, parent);
    expect(document.querySelectorAll("style")).toHaveLength(0);
    const rules = adoptedRules();
    expect(rules).toContain(".xterm-scrollable-element > .scrollbar > .slider");
    expect(rules).toContain(asWritten(XTERM_FALLBACK_THEME.foreground));
    expect(rules).toMatch(/\.xterm-rows span \{[^}]*display: inline-block/);
    // The document makes its own elements again once xterm.js is open.
    expect(document.createElement("style")).toBeInstanceOf(HTMLStyleElement);
  });

  it("rewrites the adopted rules when the theme changes, and lets them go when the terminal is disposed", () => {
    const { parent, terminal } = terminalIn();
    openStyled(terminal, parent);
    terminal.options.theme = { foreground: XTERM_FALLBACK_THEME.red };
    expect(adoptedRules()).toContain(asWritten(XTERM_FALLBACK_THEME.red));
    expect(adoptedRules()).not.toContain(asWritten(XTERM_FALLBACK_THEME.foreground));
    expect(document.querySelectorAll("style")).toHaveLength(0);

    opened.splice(0);
    terminal.dispose();
    expect(document.adoptedStyleSheets).toEqual([]);
  });
});
