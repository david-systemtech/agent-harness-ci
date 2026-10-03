// @vitest-environment jsdom-on-node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureCases, sceneFiles } from "../gallery/capture-plan.js";
import { accessSettingsDetails, detailGeometry } from "../gallery/access-settings-details.js";
import { measureSceneGeometry } from "../gallery/geometry.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("finds added scene files without loading renderer code and plans both ladders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gallery-scenes-"));
  try {
    await writeFile(join(directory, "window-empty.tsx"), "export const script = {};");
    await writeFile(join(directory, "primitives.tsx"), "throw new Error('Renderer modules must stay in the browser');");
    await writeFile(join(directory, "notes.md"), "Scene notes");
    await mkdir(join(directory, "ignored.tsx"));
    const names = await sceneFiles(directory);
    expect(names).toEqual(["primitives", "window-empty"]);
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
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "article", paddingLeft: 20, paddingTop: 16, fontSize: 12, maxWidth: 768 }]);
  root.innerHTML = '<article style="padding: 16px 20px; font-size: 13px; max-width: 768px">Preview</article>';
  document.body.append(root);
  expect(measureSceneGeometry()).toEqual(["article[0].fontSize: got 13, expected 12 ±0.5"]);
  root.querySelector("article")!.style.fontSize = "12px";
  expect(measureSceneGeometry()).toEqual([]);
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
