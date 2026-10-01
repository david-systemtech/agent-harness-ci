import { afterEach, expect, it } from "vitest";
import { cleanUp, start, platformOn } from "../test/harness.js";
import { APP_URL } from "./schemes.js";

afterEach(cleanUp);

it.each(["darwin", "win32", "linux"] as const)("allows camera video only for the app window's own main frame on %s", async (os) => {
  const { electron } = await start({ platform: platformOn(os) });
  const page = electron.window().webContents;
  const frame = { isMainFrame: true, requestingUrl: APP_URL };
  expect(page.checkPermission("media", { ...frame, mediaType: "video" })).toBe(true);
  expect(page.requestPermission("media", { ...frame, mediaTypes: ["video"] })).toBe(true);
  for (const details of [
    { ...frame, mediaType: "audio", mediaTypes: ["audio"] },
    { ...frame, mediaType: "unknown", mediaTypes: [] },
    { ...frame, mediaType: "video", mediaTypes: ["video", "audio"] },
    { ...frame, isMainFrame: false, mediaType: "video", mediaTypes: ["video"] },
    { ...frame, requestingUrl: "https://other.test", mediaType: "video", mediaTypes: ["video"] },
  ]) {
    // The mixed request's video check is permitted; its combined access request must be refused.
    if (details.mediaTypes.length !== 2) expect(page.checkPermission("media", details)).toBe(false);
    expect(page.requestPermission("media", details)).toBe(false);
  }
  expect(page.checkPermission("media", { ...frame, mediaType: "video" }, "https://other.test")).toBe(false);
  expect(page.checkPermission("media", { ...frame, mediaType: "video" }, APP_URL, null)).toBe(false);
  const dock = electron.openWebView({ webPreferences: { partition: "dock", sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
  expect(page.checkPermission("media", { ...frame, mediaType: "video" }, APP_URL, dock.webContents)).toBe(false);
  expect(page.requestPermission("media", { ...frame, mediaTypes: ["video"] }, dock.webContents)).toBe(false);
  expect(page.checkPermission("geolocation", frame)).toBe(false);
  expect(page.requestPermission("display-capture", frame)).toBe(false);
});
