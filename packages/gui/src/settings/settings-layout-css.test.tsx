// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SettingsCardGrid, SettingsGroup, SettingsPane } from "./part.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { readonly JSDOM: new (html: string) => { readonly window: { readonly document: Document; getComputedStyle(element: Element): CSSStyleDeclaration; close(): void } } };

it("keeps a single form readable while letting its card collection fill the pane", () => {
  const markup = renderToStaticMarkup(<SettingsPane title="Example">
    <SettingsGroup title="Preferences"><label>Display name<input /></label></SettingsGroup>
    <SettingsCardGrid><section>First connection</section><section>Second connection</section></SettingsCardGrid>
  </SettingsPane>);
  const dom = new JSDOM(`<body>${markup}</body>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("./settings-layout.css", import.meta.url), "utf8");
    document.head.append(style);
    const form = document.querySelector("[data-settings-pane] > section")!;
    const grid = document.querySelector("[data-settings-card-grid]")!;
    expect(getComputedStyle(form).maxWidth).toBe("768px");
    expect(getComputedStyle(grid).display).toBe("grid");
    expect(getComputedStyle(grid).maxWidth).toBe("none");
    expect(getComputedStyle(grid).gridTemplateColumns).toBe("repeat(auto-fit, minmax(min(100%, 26rem), 1fr))");
  } finally { dom.window.close(); }
});

it("bounds non-collection groups nested beside grids in mixed panes", () => {
  const markup = renderToStaticMarkup(<SettingsPane title="Example">
    <div>
      <SettingsCardGrid><section>First machine</section><section>Second machine</section></SettingsCardGrid>
      <section aria-label="Add a machine"><p>Install on another machine</p><input /></section>
    </div>
    <SettingsGroup title="Program pairings">
      <ul data-settings-card-grid><li>Program connection</li></ul>
      <div role="group" aria-label="Pair a program"><label>Ceiling<select /></label></div>
    </SettingsGroup>
  </SettingsPane>);
  const dom = new JSDOM(`<body>${markup}</body>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("./settings-layout.css", import.meta.url), "utf8");
    document.head.append(style);
    for (const name of ["Add a machine", "Pair a program"]) {
      expect(getComputedStyle(document.querySelector(`[aria-label="${name}"]`)!).maxWidth, name).toBe("768px");
    }
    for (const grid of document.querySelectorAll("[data-settings-card-grid]")) {
      expect(getComputedStyle(grid).maxWidth).toBe("none");
      expect(getComputedStyle(grid).display).toBe("grid");
    }
  } finally { dom.window.close(); }
});
