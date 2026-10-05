import { act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { verifyLandscapeOverlay } from "../gallery/phone-landscape-geometry.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("accepts a bounded scrolling landscape sheet but rejects a clipped, notch-covered or unfocused Close", () => {
  vi.stubGlobal("innerWidth", 844);
  const frame = document.createElement("div"); frame.dataset["webClient"] = "";
  frame.style.padding = "0px 44px 21px";
  const sheet = document.createElement("div"); sheet.className = "phone-composer-sheet";
  const close = document.createElement("button"); close.setAttribute("aria-label", "Close dialog");
  sheet.append(close); document.body.append(frame, sheet);
  vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue(new DOMRect(182, 16, 480, 260));
  let left = 600, top = 24;
  vi.spyOn(close, "getBoundingClientRect").mockImplementation(() => new DOMRect(left, top, 44, 44));
  act(() => close.focus());
  expect(() => verifyLandscapeOverlay(".phone-composer-sheet", 300, 8)).not.toThrow();
  top = 280;
  expect(() => verifyLandscapeOverlay(".phone-composer-sheet", 300, 8)).toThrow("clips Close");
  top = 24; left = 0;
  expect(() => verifyLandscapeOverlay(".phone-composer-sheet", 300, 8)).toThrow("side safe areas");
  left = 600;
  const outside = document.createElement("button"); document.body.append(outside);
  act(() => outside.focus());
  expect(() => verifyLandscapeOverlay(".phone-composer-sheet", 300, 8)).toThrow("lost focus");
});
