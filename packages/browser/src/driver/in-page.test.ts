import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { locateElement, readStorage, selectFieldContents, showsText } from "./in-page.js";

/**
 * The in-page functions, run as the driver runs them: from their own source
 * text, inside the page's realm, so a function that reached for anything but
 * the page's DOM and its arguments would fail here as it would in a page.
 * jsdom has no layout, so a test gives an element its box.
 */

const pageWith = (html: string): Window & typeof globalThis => {
  const { window } = new JSDOM(html, { url: "https://example.com/app", runScripts: "outside-only", pretendToBeVisual: true });
  // jsdom scrolls nothing; the stub records how it was asked.
  window.Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    this.setAttribute("data-scrolled", JSON.stringify(options));
  };
  return window;
};

/** Runs `fn` in the page's realm from its source text, as `Runtime.callFunctionOn` does. */
const runIn = <A extends unknown[], R>(window: Window, fn: (...args: A) => R, ...args: A): R =>
  (window as unknown as { eval(source: string): (...args: A) => R }).eval(`(${fn.toString()})`)(...args);

/** Gives an element a box in the viewport (jsdom's is 1024 by 768). */
const boxed = (element: Element | null, left: number, top: number, width: number, height: number): void => {
  (element as Element).getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });
};

describe("locateElement", () => {
  it("scrolls the first match into the middle of the viewport and answers the centre of its box", () => {
    const window = pageWith(`<button id="go">Go</button><button>Other</button>`);
    boxed(window.document.querySelector("#go"), 100, 50, 200, 40);
    expect(runIn(window, locateElement, "button")).toEqual({ kind: "found", x: 200, y: 70, editable: false });
    expect(JSON.parse(window.document.querySelector("#go")?.getAttribute("data-scrolled") ?? "null")).toEqual({ block: "center", inline: "center", behavior: "instant" });
  });

  it("answers the centre of the part inside the viewport, for an element larger than it or cut off by its edge", () => {
    const window = pageWith(`<div id="tall"></div>`);
    boxed(window.document.querySelector("#tall"), -100, -200, 400, 2_000);
    expect(runIn(window, locateElement, "#tall")).toMatchObject({ x: 150, y: 384 });
  });

  it("says a field takes typed text: a text-like input, a textarea, an editable element; not a button, a checkbox, or one disabled or read-only", () => {
    const window = pageWith(`
      <input id="text"><input id="password" type="password"><input id="email" type="email"><textarea id="area"></textarea>
      <div id="editable" contenteditable="true"></div>
      <input id="box" type="checkbox"><input id="off" disabled><input id="fixed" readonly><textarea id="fixed-area" readonly></textarea><div id="plain"></div>`);
    for (const element of Array.from(window.document.querySelectorAll("[id]"))) boxed(element, 0, 0, 10, 10);
    const editable = (id: string) => (runIn(window, locateElement, `#${id}`) as { editable?: boolean }).editable;
    for (const id of ["text", "password", "email", "area"]) expect(editable(id), id).toBe(true);
    for (const id of ["box", "off", "fixed", "fixed-area", "plain"]) expect(editable(id), id).toBe(false);
    // jsdom computes no contenteditable; the property is what the browser answers.
    Object.defineProperty(window.document.querySelector("#editable"), "isContentEditable", { value: true });
    expect(editable("editable")).toBe(true);
  });

  it("answers hidden for an element the browser reports not visible, though it has a box", () => {
    const window = pageWith(`<button id="ghost" style="visibility: hidden">Go</button>`);
    const ghost = window.document.querySelector("#ghost") as Element & { checkVisibility?: () => boolean };
    boxed(ghost, 10, 10, 80, 30);
    ghost.checkVisibility = () => false;
    expect(runIn(window, locateElement, "#ghost")).toEqual({ kind: "hidden" });
  });

  it("answers covered, naming what takes a click at the element's centre, when that is neither it nor inside it", () => {
    const window = pageWith(`<button id="buy">Buy <b id="label">now</b></button><div id="banner" class="cookie consent"></div>`);
    boxed(window.document.querySelector("#buy"), 100, 100, 200, 40);
    let hit: Element | null = window.document.querySelector("#banner");
    window.document.elementFromPoint = () => hit;
    expect(runIn(window, locateElement, "#buy")).toEqual({ kind: "covered", by: "div#banner.cookie.consent" });
    hit = window.document.querySelector("#label");
    expect(runIn(window, locateElement, "#buy")).toMatchObject({ kind: "found", x: 200, y: 120 });
  });

  it("answers none for a selector that matches nothing, hidden for an element with no visible part, and invalid with why", () => {
    const window = pageWith(`<p id="gone"></p><p id="away"></p>`);
    boxed(window.document.querySelector("#gone"), 10, 10, 0, 0);
    boxed(window.document.querySelector("#away"), 2_000, 10, 50, 50);
    expect(runIn(window, locateElement, "#nothing")).toEqual({ kind: "none" });
    expect(runIn(window, locateElement, "#gone")).toEqual({ kind: "hidden" });
    expect(runIn(window, locateElement, "#away")).toEqual({ kind: "hidden" });
    expect(runIn(window, locateElement, "p[")).toMatchObject({ kind: "invalid", message: expect.stringContaining("p[") });
  });
});

describe("selectFieldContents", () => {
  it("focuses an input or a textarea and selects all it holds, so typing replaces it", () => {
    const window = pageWith(`<input id="name" value="old value"><textarea id="note">line one\nline two</textarea>`);
    for (const id of ["name", "note"]) {
      expect(runIn(window, selectFieldContents, `#${id}`)).toBe("selected");
      const field = window.document.querySelector(`#${id}`) as HTMLInputElement;
      expect(window.document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    }
  });

  it("selects an editable element's contents", () => {
    const window = pageWith(`<div id="doc">some <b>rich</b> text</div>`);
    Object.defineProperty(window.document.querySelector("#doc"), "isContentEditable", { value: true });
    expect(runIn(window, selectFieldContents, "#doc")).toBe("selected");
    expect(window.getSelection()?.toString()).toBe("some rich text");
  });

  it("answers not-editable for an element that takes no text, and gone when nothing matches any more", () => {
    const window = pageWith(`<div id="plain">text</div>`);
    expect(runIn(window, selectFieldContents, "#plain")).toBe("not-editable");
    expect(runIn(window, selectFieldContents, "#nothing")).toBe("gone");
  });
});

describe("showsText", () => {
  it("finds words in the order shown, white space collapsed and case ignored, across inline elements", () => {
    const window = pageWith(`<p>Your   order  <b>has</b>\n shipped.</p>`);
    expect(runIn(window, showsText, "your ORDER has shipped")).toBe(true);
    expect(runIn(window, showsText, "order shipped")).toBe(false);
  });

  it("separates the words at a block's edge and a line break, as the screen does", () => {
    const window = pageWith(`<div>first</div><div>second</div><p>Order<br>placed</p>`);
    expect(runIn(window, showsText, "first second")).toBe(true);
    expect(runIn(window, showsText, "firstsecond")).toBe(false);
    expect(runIn(window, showsText, "Order placed")).toBe(true);
  });

  it("reads inside open shadow roots and the nodes slotted into them, as a Lit app renders", () => {
    const window = pageWith(`<ha-card><span slot="title">Living room</span></ha-card>`);
    const host = window.document.querySelector("ha-card") as Element;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<div class="state">21.5 °C</div><h2><slot name="title">Untitled</slot></h2>`;
    expect(runIn(window, showsText, "21.5 °C")).toBe(true);
    expect(runIn(window, showsText, "Living room")).toBe(true);
    expect(runIn(window, showsText, "Untitled")).toBe(false);
  });

  it("leaves out the fallback inside a frame, a canvas, a video or an object, which a page that shows them never shows", () => {
    const window = pageWith(`<body><iframe>frame fallback</iframe><canvas>canvas fallback</canvas><video>video fallback</video><object>object fallback</object><p>shown</p></body>`);
    for (const hidden of ["frame fallback", "canvas fallback", "video fallback", "object fallback"]) expect(runIn(window, showsText, hidden), hidden).toBe(false);
    expect(runIn(window, showsText, "shown")).toBe(true);
  });

  it("leaves out what no one sees: scripts, styles, templates and the noscript fallback", () => {
    const window = pageWith(`<body><script>var secret = "in a script";</script><style>.x{}</style><template>in a template</template><noscript>enable JavaScript</noscript><p>shown</p></body>`);
    for (const hidden of ["in a script", "in a template", "enable JavaScript", ".x{}"]) expect(runIn(window, showsText, hidden), hidden).toBe(false);
    expect(runIn(window, showsText, "shown")).toBe(true);
  });
});

describe("readStorage", () => {
  it("answers the origin and its local and session storage by key", () => {
    const window = pageWith(`<p></p>`);
    window.localStorage.setItem("theme", "dark");
    window.localStorage.setItem("cart", "[1,2]");
    window.sessionStorage.setItem("step", "3");
    expect(runIn(window, readStorage)).toEqual({ origin: "https://example.com", local: { theme: "dark", cart: "[1,2]" }, session: { step: "3" } });
  });
});
