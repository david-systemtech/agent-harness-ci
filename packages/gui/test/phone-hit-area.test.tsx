// @vitest-environment jsdom-on-node
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

const target = (inset: number) => {
  document.body.innerHTML = '<div id="root"><button style="border: 0">More</button></div>';
  document.getElementById("root")!.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button", hitArea: 44 }]);
  const button = document.querySelector("button")!;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 20, 28, 28));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => pseudo
    ? { content: '""', position: "absolute", top: `${inset}px`, right: `${inset}px`, bottom: `${inset}px`, left: `${inset}px` } as CSSStyleDeclaration
    : computed(element));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => button) });
  return button;
};

it("rejects a small visible button without a 44px hit area", () => {
  target(0);
  expect(measureSceneGeometry()).toEqual(["button[0]: hit area 28×28 is smaller than 44px"]);
});

it("accepts a compact button whose transparent target expands to 44px", () => {
  target(-8);
  expect(measureSceneGeometry()).toEqual([]);
});

it("rejects a target clipped or covered at its expanded edge", () => {
  const button = target(-8);
  vi.mocked(document.elementFromPoint).mockImplementation((x) => x < 20 ? document.body : button);
  expect(measureSceneGeometry()).toEqual(["button[0]: hit area is clipped or covered"]);
});


it("measures expansion from the padding box of a bordered button", () => {
  const button = target(-9);
  button.style.border = "1px solid";
  expect(measureSceneGeometry()).toEqual([]);
});

it("checks a disabled control's target size without requiring pointer reception", () => {
  const button = target(-8); button.disabled = true;
  vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
  expect(measureSceneGeometry()).toEqual([]);
});

it("runs hosted hit-area geometry in a page without module helpers", () => {
  target(-8);
  const source = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import { measureSceneGeometry } from "./packages/gui/gallery/geometry.ts"; process.stdout.write(measureSceneGeometry.toString());',
  ], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  expect(new Script(`(${source})()`).runInNewContext({ document, window, getComputedStyle: window.getComputedStyle.bind(window) })).toEqual([]);
});
