// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
// jsdom has no bundled declarations; this test uses only its document and cleanup boundary.
const { JSDOM } = require("jsdom") as { readonly JSDOM: new (html: string) => { readonly window: { readonly document: Document; close(): void } } };

it.each(["data-settings-dialog", "data-phone-setup"])("phone target sizing reaches portaled choices while %s is open", surface => {
  const dom = new JSDOM(`<body><section ${surface}></section><div role="dialog"><div role="menuitem">Unset</div></div><div role="menu"><div role="menuitemradio">Default</div><div role="menuitemcheckbox">Enabled</div></div></body>`);
  try {
    const { document } = dom.window;
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("./phone-settings.css", import.meta.url), "utf8");
    document.head.append(style);
    const media = Array.from(style.sheet?.cssRules ?? []).find((rule): rule is CSSMediaRule => "cssRules" in rule);
    expect(media?.conditionText).toBe("(max-width: 639px)");
    const styleRules = Array.from(media?.cssRules ?? []).filter((rule): rule is CSSStyleRule => "style" in rule);
    const touchRules = styleRules.filter(rule => rule.style.getPropertyValue("min-height") === "44px");
    for (const row of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')) {
      expect(touchRules.some(rule => row.matches(rule.selectorText))).toBe(true);
      document.querySelector("section")?.remove();
      expect(touchRules.some(rule => row.matches(rule.selectorText))).toBe(false);
      document.body.insertAdjacentHTML("afterbegin", `<section ${surface}></section>`);
    }
  } finally { dom.window.close(); }
});
