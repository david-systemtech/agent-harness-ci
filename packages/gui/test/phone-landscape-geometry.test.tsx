import { act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { verifyLandscapeOverlay } from "../gallery/phone-landscape-geometry.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(["phone-composer-sheet", "phone-prompt-sheet"])("accepts bounded %s but rejects a clipped, notch-covered or unfocused Close", className => {
  vi.stubGlobal("innerWidth", 844);
  const frame = document.createElement("div"); frame.dataset["webClient"] = "";
  frame.style.padding = "0px 44px 21px";
  const sheet = document.createElement("div"); sheet.className = className;
  const close = document.createElement("button");
  if (className === "phone-composer-sheet") { close.setAttribute("aria-label", "Close dialog"); sheet.append(close); }
  else { const header = document.createElement("header"); close.textContent = "Close"; header.append(close); sheet.append(header); } document.body.append(frame, sheet);
  vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue(new DOMRect(182, 16, 480, 260));
  let left = 600, top = 24;
  vi.spyOn(close, "getBoundingClientRect").mockImplementation(() => new DOMRect(left, top, 44, 44));
  act(() => close.focus());
  expect(() => verifyLandscapeOverlay(`.${className}`, 300, 8)).not.toThrow();
  top = 280;
  expect(() => verifyLandscapeOverlay(`.${className}`, 300, 8)).toThrow("clips Close");
  top = 24; left = 0;
  expect(() => verifyLandscapeOverlay(`.${className}`, 300, 8)).toThrow("side safe areas");
  left = 600;
  const outside = document.createElement("button"); document.body.append(outside);
  act(() => outside.focus());
  expect(() => verifyLandscapeOverlay(`.${className}`, 300, 8)).toThrow("lost focus");
});

it("keeps a failed landscape proof blocking even when its diagnostic capture is preserved", async () => {
  const { landscapeScene } = await import("../gallery/phone-landscape-scene.js");
  const { measureSceneGeometry } = await import("../gallery/geometry.js");
  const geometry = landscapeScene("keyboard").geometry;
  const checks = typeof geometry === "function" ? geometry({ width: 844, height: 390 }) : geometry ?? [];
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify(checks.filter(check => check.selector.includes("data-landscape-proof")));
  const frame = document.createElement("div"); frame.dataset["landscapeProof"] = "failed";
  root.append(frame); document.body.append(root);
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("no matching elements")]);
  frame.dataset["landscapeProof"] = "passed";
  expect(measureSceneGeometry()).toEqual([]);
});
