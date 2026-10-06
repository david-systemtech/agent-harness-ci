// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
// jsdom has no bundled declarations; this test uses only its document and cleanup boundary.
const { JSDOM } = require("jsdom") as { readonly JSDOM: new (html: string) => { readonly window: { readonly document: Document; close(): void } } };

/**
 * The pairing form's line on a phone (#1739): the further-environment
 * refusal was squeezed into half the width beside its Browser origins
 * button, and its origins broke at their hyphens. jsdom lays nothing out,
 * so the rules are read from the stylesheet; the 390 px gallery scene
 * `phone-pairing-unlisted-origin` measures the layout they give.
 */
const rulesOf = (document: Document) => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("./phone-pairing.css", import.meta.url), "utf8");
  document.head.append(style);
  const rules = Array.from(style.sheet?.cssRules ?? []);
  const media = (condition: string) => rules.find((rule): rule is CSSMediaRule => "conditionText" in rule && (rule as CSSMediaRule).conditionText === condition);
  const styled = (list: readonly CSSRule[]) => list.filter((rule): rule is CSSStyleRule => "style" in rule && "selectorText" in rule);
  return { everywhere: styled(rules), phone: styled(Array.from(media("(max-width: 639px)")?.cssRules ?? [])), phoneLayout: styled(Array.from(media(PHONE_LAYOUT)?.cssRules ?? [])) };
};

const declared = (rules: readonly CSSStyleRule[], element: Element, property: string): string | undefined =>
  rules.filter((rule) => element.matches(rule.selectorText)).map((rule) => rule.style.getPropertyValue(property)).filter((value) => value !== "").at(-1);

/** The phone layout media (`phoneLayoutMedia`, src/frame/phone-frame.tsx): portrait phones, and short landscape touch screens. */
const PHONE_LAYOUT = "(width < 640px), (pointer: coarse) and (hover: none) and (640px <= width <= 960px) and (height <= 500px)";

const FORM = `<div data-phone-pairing><div role="status"><span>Not paired: This browser client may not contact <code data-pairing-origin>https://second-laptop.example.test:8444</code>.</span><button>Browser origins</button></div></div>`;

it("gives the line the full width in the phone layout, a phone held landscape too, and puts its actions below it", () => {
  const dom = new JSDOM(`<body>${FORM}</body>`);
  try {
    const { document } = dom.window;
    const { phoneLayout: phone } = rulesOf(document);
    const status = document.querySelector('[role="status"]')!;
    expect(declared(phone, status, "flex-wrap")).toBe("wrap");
    expect(declared(phone, status.querySelector("span")!, "flex-basis")).toBe("100%");
    expect(declared(phone, status.querySelector("button")!, "flex-basis")).toBeUndefined();
  } finally { dom.window.close(); }
});

it("keeps each origin in the line a run that wraps whole, at every width", () => {
  const dom = new JSDOM(`<body>${FORM}</body>`);
  try {
    const { document } = dom.window;
    const { everywhere, phone } = rulesOf(document);
    const origin = document.querySelector("[data-pairing-origin]")!;
    expect(declared(everywhere, origin, "display")).toBe("inline-block");
    expect(declared(everywhere, origin, "max-width")).toBe("100%");
    expect(declared(phone, origin, "display")).toBeUndefined();
  } finally { dom.window.close(); }
});
