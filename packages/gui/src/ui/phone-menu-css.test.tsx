// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Menu, MenuContent, MenuItem, MenuShortcut, MenuTrigger } from "./menu.js";

it("lets phone menu explanations use the row width without a keyboard shortcut column", () => {
  render(<Menu open><MenuTrigger>More</MenuTrigger><MenuContent>
    <MenuItem aria-label="Terminal" disabled><span>Terminal<span>This client needs a deliberate re-pair with the terminal scope.</span></span><MenuShortcut>Ctrl+J</MenuShortcut></MenuItem>
    <MenuItem aria-label="Split right"><span>Split right</span><MenuShortcut>Ctrl+Shift+Enter</MenuShortcut></MenuItem>
  </MenuContent></Menu>);
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("./phone-overlays.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  try {
    expect(getComputedStyle(screen.getByText("Ctrl+J")).display).not.toBe("none");
    const frame = document.createElement("div"); frame.dataset["phoneFrame"] = ""; document.body.append(frame);
    try {
      for (const keys of ["Ctrl+J", "Ctrl+Shift+Enter"]) expect(getComputedStyle(screen.getByText(keys)).display).toBe("none");
      const row = screen.getByRole("menuitem", { name: "Terminal" });
      expect(getComputedStyle(row).minHeight).toBe("44px");
      expect(getComputedStyle(row).whiteSpace).toBe("normal");
      expect(row.textContent).toContain("deliberate re-pair");
    } finally { frame.remove(); }
  } finally { stylesheet.remove(); }
});
