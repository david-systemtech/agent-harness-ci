import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { frameOwnerKey, snapshotFrame } from "./in-page.js";
import type { SnapshotGlobal } from "./world.js";

/**
 * The snapshot's in-page half, run as the driver runs it: from its source
 * text, inside the page's realm, so the vendored aria snapshot and the code
 * around it reach for nothing but the page's DOM and their arguments. jsdom
 * has no layout, so a page is laid out by giving every element a box; one
 * without a box is not visible, and takes no ref.
 */

const pageWith = (html: string, options: { readonly laidOut?: boolean } = {}): Window & typeof globalThis => {
  const { window } = new JSDOM(html, { url: "https://example.com/app", runScripts: "outside-only", pretendToBeVisual: true });
  // jsdom computes no pseudo-element's style, and says so on every call: an element's own style has no content either.
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element: Element) => computed(element);
  if (options.laidOut !== false) {
    window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) });
  }
  return window;
};

/** Runs an in-page source in the page's realm, as `Runtime.callFunctionOn` does. */
const runIn = <A extends unknown[], R>(window: Window, source: { readonly declaration: string; readonly signature?: (...args: A) => R }, ...args: A): R =>
  (window as unknown as { eval(source: string): (...args: A) => R }).eval(`(${source.declaration})`)(...args);

describe("snapshotFrame", () => {
  it("reads each element's role, name and state, with a ref on each that can be acted on, through open shadow roots and slotted nodes", () => {
    const window = pageWith(`
      <h1>Dashboard</h1>
      <ha-card><span slot="title">Living room</span></ha-card>
      <a href="/settings">Settings</a>
      <label><input type="checkbox" checked> Heating on</label>`);
    const card = window.document.querySelector("ha-card") as Element;
    card.attachShadow({ mode: "open" }).innerHTML = `<h2><slot name="title"></slot></h2><button>21.5 °C</button>`;

    const { nodes } = runIn(window, snapshotFrame, { prefix: "", firstRef: 1 });
    expect(nodes).toEqual([
      {
        role: "generic",
        ref: "e1",
        children: [
          { role: "heading", name: "Dashboard", level: 1, ref: "e2" },
          { role: "generic", ref: "e3", children: [{ role: "heading", name: "Living room", level: 2, ref: "e4" }, { role: "button", name: "21.5 °C", ref: "e5" }] },
          { role: "link", name: "Settings", ref: "e6", cursor: "pointer", url: "/settings" },
          {
            role: "generic",
            ref: "e7",
            children: [{ role: "checkbox", name: "Heating on", checked: true, ref: "e8", field: { type: "checkbox", autocomplete: null } }, "Heating on"],
          },
        ],
      },
    ]);
  });

  it("never reads the value of a password, card or one-time-code field: the field, and a name it is embedded in, show its marker", () => {
    const window = pageWith(`
      <input aria-label="Password" type="password" value="hunter2-for-tests">
      <input aria-label="Card number" autocomplete="cc-number" value="0000 1111 2222 3333">
      <select aria-label="Expiry month" autocomplete="cc-exp-month"><option>01</option><option selected>07</option></select>
      <input aria-label="Code" autocomplete="one-time-code" value="246810">
      <input aria-label="Email" type="email" value="person@example.com">
      <label><input type="checkbox"> Remember <input type="password" value="hunter2-for-tests"></label>`);
    // A field's value is never read: a page that reads it back is not asked.
    for (const field of Array.from(window.document.querySelectorAll("input[type=password], [autocomplete]"))) {
      Object.defineProperty(field, "value", { get: () => expect.unreachable("a field whose value is never read was read") });
    }
    const text = JSON.stringify(runIn(window, snapshotFrame, { prefix: "", firstRef: 1 }).nodes);
    expect(text).not.toMatch(/hunter2|0000 1111|246810|"07"/);
    expect(text).toContain(`"name":"Password","ref":"e2","field":{"type":"password","autocomplete":null},"text":"[redacted: a password]"`);
    expect(text).toContain(`"text":"[redacted: a payment card detail]"`);
    expect(text).toContain(`"name":"Expiry month","ref":"e4","field":{"type":"select-one","autocomplete":"cc-exp-month"},"text":"[redacted: a payment card detail]"`);
    expect(text).toContain(`"text":"[redacted: a one-time code]"`);
    expect(text).toContain(`"name":"Email","ref":"e8","field":{"type":"email","autocomplete":null},"text":"person@example.com"`);
    expect(text).toContain(`"name":"Remember [redacted: a password]"`);
  });

  it("prefixes a frame's refs, never gives a number below the first asked for, and keeps one element's ref while its role and name stay", () => {
    const window = pageWith(`<button>Save</button><button>Cancel</button>`);
    expect(runIn(window, snapshotFrame, { prefix: "f2", firstRef: 40 })).toMatchObject({
      nodes: [{ ref: "f2e40", children: [{ name: "Save", ref: "f2e41" }, { name: "Cancel", ref: "f2e42" }] }],
      lastRef: 42,
    });
    (window.document.querySelector("button") as Element).textContent = "Saved";
    expect(runIn(window, snapshotFrame, { prefix: "f2", firstRef: 1 })).toMatchObject({
      nodes: [{ ref: "f2e40", children: [{ name: "Saved", ref: "f2e43" }, { name: "Cancel", ref: "f2e42" }] }],
      lastRef: 43,
    });
  });

  it("gives an element no ref when it has no box, or takes no pointer events", () => {
    const window = pageWith(`<p>Read only</p><button style="pointer-events: none">Inert</button>`, { laidOut: false });
    expect(runIn(window, snapshotFrame, { prefix: "", firstRef: 1 }).nodes).toEqual([
      { role: "generic", children: [{ role: "paragraph", text: "Read only" }, { role: "button", name: "Inert" }] },
    ]);
  });

  it("keeps the latest snapshot's refs in the world's map, an element that left the page found no longer", () => {
    const window = pageWith(`<button id="save">Save</button><button id="cancel">Cancel</button>`);
    runIn(window, snapshotFrame, { prefix: "", firstRef: 1 });
    const world = () => (window as unknown as SnapshotGlobal).agentHarnessSnapshot;
    expect(world()?.element("e2")).toBe(window.document.querySelector("#save"));
    window.document.querySelector("#cancel")?.remove();
    expect(world()?.element("e3")).toBeUndefined();
    expect(world()?.element("e9")).toBeUndefined();
  });

  it("marks each iframe with its place among the frame owners, which the frame's owner element answers", () => {
    const window = pageWith(`<iframe title="Reviews"></iframe><div><iframe title="Payment"></iframe></div>`);
    expect(runIn(window, snapshotFrame, { prefix: "", firstRef: 1 }).nodes).toMatchObject([
      { children: [{ role: "iframe", ref: "e2", frame: 0 }, { role: "iframe", ref: "e4", frame: 1 }] },
    ]);
    const owners = Array.from(window.document.querySelectorAll("iframe"));
    const keyOf = (element: Element): number | null => (window as unknown as { eval(source: string): (this: Element) => number | null }).eval(`(${frameOwnerKey.toString()})`).call(element);
    expect(owners.map(keyOf)).toEqual([0, 1]);
    expect(keyOf(window.document.body)).toBeNull();
  });
});
