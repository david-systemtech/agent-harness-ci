// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { phoneLayoutMedia } from "../frame/phone-frame.js";

const styles: HTMLStyleElement[] = [];
afterEach(() => { for (const style of styles.splice(0)) style.remove(); });

it("fixes phone layout units while scaling type, including portaled surfaces", () => {
  const style = document.createElement("style");
  styles.push(style);
  // Read the shipped media block: jsdom does not evaluate viewport queries.
  const source = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  style.textContent = source.slice(source.indexOf("@media"));
  document.head.append(style);
  const media = style.sheet!.cssRules[0] as CSSMediaRule;
  expect(media.conditionText).toBe(phoneLayoutMedia().map(query => query.media).join(", "));
  const root = Array.from(media.cssRules).find((rule): rule is CSSStyleRule => "selectorText" in rule && rule.selectorText === "html")!;
  expect(root.style.getPropertyValue("font-size")).toBe("16px");
  expect(root.style.getPropertyValue("--phone-space-2")).toBe("8px");
  expect(root.style.getPropertyValue("--phone-radius-control")).toBe("8px");
  expect(root.style.getPropertyValue("--phone-text-body").replace(/\s/g, "")).toBe("calc(14px*var(--font-scale,1.142857))");
  expect(root.style.getPropertyValue("--text-base")).toBe("var(--phone-text-body)");
  expect(root.style.getPropertyValue("--font-sans")).toContain("system-ui");
  expect(root.style.getPropertyValue("--font-sans")).not.toContain("Archivo");
  expect(root.style.getPropertyValue("--font-mono")).toContain("JetBrains Mono Variable");
});
