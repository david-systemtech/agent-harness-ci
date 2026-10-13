import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePhoneSettings } from "./phone-navigation.js";

afterEach(() => vi.restoreAllMocks());

it("keeps Settings in the phone projection in short touch landscape and follows media changes", () => {
  const portrait = Object.assign(new EventTarget(), { matches: false, media: "(width < 640px)" });
  const landscape = Object.assign(new EventTarget(), { matches: true, media: "(pointer: coarse) and (hover: none) and (640px <= width <= 960px) and (height <= 500px)" });
  vi.spyOn(window, "matchMedia").mockImplementation(query => (query === portrait.media ? portrait : landscape) as MediaQueryList);
  const { result } = renderHook(usePhoneSettings);
  expect(result.current).toBe(true);
  act(() => { landscape.matches = false; landscape.dispatchEvent(new Event("change")); });
  expect(result.current).toBe(false);
  act(() => { portrait.matches = true; portrait.dispatchEvent(new Event("change")); });
  expect(result.current).toBe(true);
});
