// @vitest-environment jsdom-on-node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureCases, sceneFiles } from "../gallery/capture-plan.js";
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
