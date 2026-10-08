// @vitest-environment jsdom-on-node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { captureCases, sceneFiles } from "../gallery/capture-plan.js";
import { accessSettingsDetails, detailGeometry } from "../gallery/access-settings-details.js";
import { measureSceneGeometry } from "../gallery/geometry.js";
import { galleryOrigin, serveGallery } from "../gallery/serve.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("finds added scene files without loading renderer code and plans both ladders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gallery-scenes-"));
  try {
    await writeFile(join(directory, "window-empty.tsx"), "export const script = {};");
    await writeFile(join(directory, "primitives.tsx"), "throw new Error('Renderer modules must stay in the browser');");
    await writeFile(join(directory, "phone-overlay-workspace.tsx"), "throw new Error('Renderer modules must stay in the browser');");
    await writeFile(join(directory, "notes.md"), "Scene notes");
    await mkdir(join(directory, "ignored.tsx"));
    const names = await sceneFiles(directory);
    expect(names).toEqual(["phone-overlay-workspace", "primitives", "window-empty"]);
    expect(captureCases(names)).toEqual([
      { scene: "primitives", ladder: "light", name: "primitives.light" },
      { scene: "primitives", ladder: "dark", name: "primitives.dark" },
      { scene: "window-empty", ladder: "light", name: "window-empty.light" },
      { scene: "window-empty", ladder: "dark", name: "window-empty.dark" },
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("checks every control and fails missing geometry selectors", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", height: 32 }, { selector: "input", height: 32 }]);
  root.innerHTML = "<button>First</button><button>Second</button><input />";
  document.body.append(root);
  const rects = [new DOMRect(0, 0, 80, 32.4), new DOMRect(0, 0, 80, 36), new DOMRect(0, 0, 160, 32)];
  Array.from(root.children).forEach((element, index) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rects[index]!));
  expect(measureSceneGeometry()).toEqual(["button[1].height: got 36, expected 32 ±0.5"]);
  root.querySelector("input")?.remove();
  expect(measureSceneGeometry()).toContain("input: no matching elements");
});

it("checks computed padding, type size and reading caps as well as outer bounds", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "article", paddingLeft: 20, paddingTop: 16, fontSize: 12, maxWidth: 768, maxHeight: 416 }]);
  root.innerHTML = '<article style="padding: 16px 20px; font-size: 13px; max-width: 768px; max-height: 416px">Preview</article>';
  document.body.append(root);
  expect(measureSceneGeometry()).toEqual(["article[0].fontSize: got 13, expected 12 ±0.5"]);
  root.querySelector("article")!.style.fontSize = "12px";
  expect(measureSceneGeometry()).toEqual([]);
  root.querySelector("article")!.style.maxHeight = "500px";
  expect(measureSceneGeometry()).toEqual(["article[0].maxHeight: got 500, expected 416 ±0.5"]);
});

it("checks a content height floor with tolerance and rejects non-finite readings", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "main", minimumHeight: 768, tolerance: 0.1 }]);
  root.innerHTML = "<main></main>";
  document.body.append(root);
  const bounds = vi.spyOn(root.firstElementChild!, "getBoundingClientRect");
  for (const height of [767.9, 768, 869.75]) {
    bounds.mockReturnValue(new DOMRect(0, 0, 1024, height));
    expect(measureSceneGeometry()).toEqual([]);
  }
  for (const height of [767.8, Number.NaN, Number.POSITIVE_INFINITY]) {
    bounds.mockReturnValue(new DOMRect(0, 0, 1024, height));
    expect(measureSceneGeometry()).toEqual([`main[0].height: got ${height}, expected at least 768 ±0.1`]);
  }
});

it.each([[1400, 920], [1024, 777]])("checks responsive scene geometry at viewport %i", (viewport, width) => {
  vi.stubGlobal("innerWidth", viewport);
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([
    { selector: "button", width: 920, viewport: 1400 },
    { selector: "button", width: 777, viewport: 1024 },
    { selector: "button", height: 28 },
  ]);
  root.innerHTML = "<button>Send</button>";
  document.body.append(root);
  const button = root.querySelector("button")!;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 28));
  expect(measureSceneGeometry()).toEqual([]);
  button.remove();
  expect(measureSceneGeometry()).toEqual(["button: no matching elements", "button: no matching elements"]);
});

it("fails a word that wraps mid-word onto another line and accepts wraps between words or at hyphens", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "article", wordsIntact: true }]);
  root.innerHTML = "<article><h3>push-cf5fe456-a941-d86cfaf95cf2</h3><p>Web Push · This client</p></article>";
  document.body.append(root);
  let broken = "d86cfaf95cf2";
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value(this: Range) {
    return this.toString() === broken ? [new DOMRect(0, 0, 300, 20), new DOMRect(0, 20, 20, 20)] : [new DOMRect(0, 0, 40, 20)];
  } });
  onTestFinished(() => { delete (Range.prototype as Partial<Range>).getClientRects; });
  expect(measureSceneGeometry()).toEqual(['article[0]: "d86cfaf95cf2" breaks mid-word across lines']);
  broken = "";
  expect(measureSceneGeometry()).toEqual([]);
});

it("fails a run that must wrap whole when it breaks inside, even at a hyphen, and accepts it moved whole to the next line (ticket 1739)", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "code", unbroken: true }]);
  root.innerHTML = "<p>Not paired: may not contact <code>https://second-laptop.example.test:8444</code>.</p>";
  document.body.append(root);
  let lines = [new DOMRect(0, 0, 60, 20), new DOMRect(0, 20, 200, 20)];
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => lines });
  onTestFinished(() => { delete (Range.prototype as Partial<Range>).getClientRects; });
  expect(measureSceneGeometry()).toEqual(["code[0]: breaks across lines; it must wrap whole"]);
  lines = [new DOMRect(0, 20, 260, 20)];
  expect(measureSceneGeometry()).toEqual([]);
});

it("fails a row of a list that grows taller than the first row, so rows with long and short text keep one shape (ticket 1895)", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "li", sameHeight: true }]);
  root.innerHTML = "<ul><li>first</li><li>second</li><li>third</li></ul>";
  document.body.append(root);
  const heights = [54, 54, 72];
  root.querySelectorAll("li").forEach((row, index) => vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 200, heights[index]!)));
  expect(measureSceneGeometry()).toEqual(["li[2].height: got 72, expected 54 like li[0] ±0.5"]);
  heights[2] = 54.3;
  expect(measureSceneGeometry()).toEqual([]);
});


it("serves the built gallery at the same origin on every run, so a scene that shows the page's origin captures the same pixels (ticket 1763)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gallery-dist-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "gallery.html"), "<p>gallery</p>");
  const origins: string[] = [];
  for (const run of [1, 2]) {
    const server = await serveGallery(directory);
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error(`Run ${run} has no address.`);
      origins.push(`http://${address.address}:${address.port}`);
      const page = await fetch(`${galleryOrigin}/gallery.html`);
      expect([page.status, page.headers.get("content-type"), await page.text()]).toEqual([200, "text/html", "<p>gallery</p>"]);
    } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  }
  expect(origins).toEqual([galleryOrigin, galleryOrigin]);
});

it("captures every scene in dark and the specified light subset without exceeding the report budget", () => {
  expect(captureCases(["settings-accounts", "settings-permissions", "settings-theme", "setup-account", "setup-appearance", "settings-banks", "dock-files"])).toEqual([
    { scene: "settings-accounts", ladder: "light", name: "settings-accounts.light" }, { scene: "settings-accounts", ladder: "dark", name: "settings-accounts.dark" },
    { scene: "settings-permissions", ladder: "light", name: "settings-permissions.light" }, { scene: "settings-permissions", ladder: "dark", name: "settings-permissions.dark" },
    { scene: "settings-theme", ladder: "light", name: "settings-theme.light" }, { scene: "settings-theme", ladder: "dark", name: "settings-theme.dark" },
    { scene: "setup-account", ladder: "light", name: "setup-account.light" }, { scene: "setup-account", ladder: "dark", name: "setup-account.dark" },
    { scene: "setup-appearance", ladder: "light", name: "setup-appearance.light" }, { scene: "setup-appearance", ladder: "dark", name: "setup-appearance.dark" },
    { scene: "settings-banks", ladder: "dark", name: "settings-banks.dark" }, { scene: "dock-files", ladder: "dark", name: "dock-files.dark" },
  ]);
});

it("rejects a correctly sized control clipped by its scrolling pane", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", height: 32, visibleWithin: "section" }]);
  root.innerHTML = "<section><button>Stop</button></section>";
  document.body.append(root);
  vi.spyOn(root.querySelector("section")!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 100, 500, 400));
  const button = vi.spyOn(root.querySelector("button")!, "getBoundingClientRect");
  button.mockReturnValue(new DOMRect(20, 490, 80, 32));
  expect(measureSceneGeometry()).toEqual(["button[0]: clipped outside section"]);
  button.mockReturnValue(new DOMRect(20, 450, 80, 32));
  expect(measureSceneGeometry()).toEqual([]);
  button.mockReturnValue(new DOMRect(20, 110, 0, 0));
  expect(measureSceneGeometry()).toContain("button[0]: clipped outside section");
});


it("measures only the headless switch in the Browser defaults capture", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify(detailGeometry(accessSettingsDetails.defaults, { width: 1400, height: 900 }).filter((check) => check.selector.includes("[role=switch]")));
  root.innerHTML = '<button role="switch">Window control</button><section aria-label="Headless browser"><button role="switch">Allow runs</button></section>';
  document.body.append(root);
  const buttons = root.querySelectorAll("button");
  vi.spyOn(buttons[0]!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 24, 24));
  vi.spyOn(buttons[1]!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 32, 18.4));
  expect(measureSceneGeometry()).toEqual([]);
});


it.each([11, 20])("measures text size %i with the preset root scale and fixed desktop frame", async (size) => {
  const { geometry } = size === 11 ? await import("../gallery/scenes/window-scale-11.js") : await import("../gallery/scenes/window-scale-20.js");
  expect(geometry.find((check) => check.selector === "html")).toEqual({ selector: "html", fontSize: 16 * size / 14 });
  expect(geometry.find((check) => check.selector === "[data-window-header]")).toEqual({ selector: "[data-window-header]", height: 44 });
});

it("requires a 44px touch target in both dimensions and a visible Continue above the keyboard", () => {
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 480);
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: 'button[aria-label="Continue"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "section" }]);
  root.innerHTML = '<section><button aria-label="Continue">Continue</button></section>'; document.body.append(root);
  vi.spyOn(root.querySelector("section")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 480));
  const button = vi.spyOn(root.querySelector("button")!, "getBoundingClientRect");
  button.mockReturnValue(new DOMRect(10, 430, 30, 44));
  expect(measureSceneGeometry()).toEqual(['button[aria-label="Continue"][0].width: got 30, expected at least 44 ±0.5']);
  button.mockReturnValue(new DOMRect(10, 450, 44, 44));
  expect(measureSceneGeometry()).toEqual(['button[aria-label="Continue"][0]: clipped outside section']);
  button.mockReturnValue(new DOMRect(10, 430, 44, 44));
  expect(measureSceneGeometry()).toEqual([]);
});


it("measures rendered touch targets while excluding hidden controls and hidden ancestors", () => {
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", renderedOnly: true, minimumWidth: 44, minimumHeight: 44 }]);
  root.innerHTML = '<button>Send</button><button hidden>Hidden</button><div style="display:none"><button>Inside hidden pane</button></div>';
  document.body.append(root);
  const button = root.querySelector("button")!;
  const rect = new DOMRect(0, 0, 44, 44);
  vi.spyOn(button, "getClientRects").mockReturnValue(Object.assign([rect], { item: (index: number) => index === 0 ? rect : null }));
  const bounds = vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 30, 44));
  expect(measureSceneGeometry()).toEqual(["button[0].width: got 30, expected at least 44 ±0.5"]);
  bounds.mockReturnValue(new DOMRect(0, 0, 44, 44));
  expect(measureSceneGeometry()).toEqual([]);
  button.remove();
  expect(measureSceneGeometry()).toEqual(["button: no matching elements"]);
});


it.each(["Send", "Allow once", "Continue"])("rejects a hidden %s action even when its bounds fit the viewport", action => {
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", minimumWidth: 44, minimumHeight: 44, visibleWithin: "section" }]);
  root.innerHTML = `<section><button style="visibility:hidden">${action}</button></section>`;
  document.body.append(root);
  vi.spyOn(root.querySelector("section")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 480));
  const button = root.querySelector("button")!;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 44, 44));
  expect(measureSceneGeometry()).toEqual(["button[0]: hidden inside section"]);
  button.style.visibility = "visible";
  expect(measureSceneGeometry()).toEqual([]);
});

it("rejects a visible decision that an overlay intercepts", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", hitTestable: true }]);
  root.innerHTML = '<button><span>Send answers</span></button><div data-cover></div>';
  document.body.append(root);
  const button = root.querySelector("button")!;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 40, 120, 32));
  const hit = vi.fn(() => root.querySelector("[data-cover]"));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  expect(measureSceneGeometry()).toEqual(["button[0]: not hit-testable at its centre"]);
  hit.mockReturnValue(button.querySelector("span"));
  expect(measureSceneGeometry()).toEqual([]);
  hit.mockReturnValue(null);
  expect(measureSceneGeometry()).toHaveLength(1);
});
