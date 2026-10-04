import { describe, expect, it } from "vitest";
import { webPreview } from "./web-preview.js";

describe("static browser document previews", () => {
  it("keeps document content and styles while removing active content, navigation and network paths", () => {
    const snapshot = webPreview(`<!doctype html><html><head><base href="https://example.test"><meta http-equiv="refresh" content="0;url=https://example.test"><style>h1 { font-size: 24px }</style></head><body><h1 onclick="parent.alert(1)">Receipts</h1><script>fetch('https://example.test')</script><form action="https://example.test"><input></form><iframe src="https://example.test"></iframe><object data="https://example.test"></object><a href="https://example.test" ping="https://example.test">Visit</a><img src="https://example.test/pixel"><svg><a href="https://example.test"><text>Drawing</text></a></svg></body></html>`);
    const doc = new DOMParser().parseFromString(snapshot, "text/html");
    expect(doc.querySelector("h1")?.textContent).toBe("Receipts");
    expect(doc.querySelector("style")?.textContent).toContain("font-size: 24px");
    expect(doc.querySelector("script, form, iframe, object, base, meta[http-equiv=refresh]")).toBeNull();
    expect(doc.querySelector("[onclick], [href], [ping], img[src]")).toBeNull();
    expect(doc.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain("default-src 'none'");
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain("form-action 'none'");
  });
  it("preserves SVG geometry while rejecting event handlers, animation and external references", () => {
    const snapshot = webPreview('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="parent.alert(1)"><circle cx="50" cy="50" r="20"/><script>fetch("https://example.test")</script><foreignObject><iframe src="https://example.test"></iframe></foreignObject><image href="https://example.test/pixel"/><a href="https://example.test"><text>Drawing</text></a><set attributeName="href" to="https://example.test"/></svg>');
    const doc = new DOMParser().parseFromString(snapshot, "text/html");
    expect(doc.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(doc.querySelector("circle")?.getAttribute("r")).toBe("20");
    expect(doc.querySelector("script, foreignObject, iframe, set, [onload], [href]")).toBeNull();
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain("connect-src 'none'");
  });

});
