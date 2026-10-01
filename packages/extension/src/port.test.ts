import { describe, expect, it } from "vitest";
import { fakeChrome } from "../test/fake-chrome.js";
import { extensionManifest } from "./manifest.js";
import { ownFileReader, readPortFile } from "./port.js";

const chrome = fakeChrome(extensionManifest("1.2.3"));

describe("Chrome's reader of the extension's own folder", () => {
  it("fetches the file's address in the extension skipping the cache, so a rewritten port file is read as it is now", async () => {
    const asked: [string, RequestInit][] = [];
    const read = ownFileReader(chrome, (url, init) => {
      asked.push([url, init]);
      return Promise.resolve(new Response('{"port":47615}'));
    });

    expect(await read("port.json")).toBe('{"port":47615}');
    expect(asked).toEqual([["chrome-extension://fnmgmfbcdmlefliicojlcpehmcieoajl/port.json", { cache: "no-store" }]]);
  });

  it("reads a file the folder does not hold as absent, whether Chrome answers it with a failed fetch or a 404", async () => {
    expect(await ownFileReader(chrome, () => Promise.reject(new TypeError("Failed to fetch")))("port.json")).toBeNull();
    expect(await ownFileReader(chrome, () => Promise.resolve(new Response("", { status: 404 })))("port.json")).toBeNull();
  });
});

describe("the port file", () => {
  const reading = (text: string | null) => readPortFile(() => Promise.resolve(text));

  it("is read as the environment writes it", async () => {
    const file = { port: 47616, environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", environmentName: "Laptop", harnessVersion: "1.2.3" };
    expect(await reading(JSON.stringify(file))).toEqual({ ok: true, file });
  });

  it("says why there is no port to read when the file is absent, not JSON, or names no port", async () => {
    expect(await reading(null)).toEqual({
      ok: false,
      problem: "This extension's folder holds no port file yet: the environment writes one once it listens. Start the environment; this updates by itself.",
    });
    expect(await reading("{")).toEqual({ ok: false, problem: "The port file in this extension's folder is not JSON. Restart the environment, which writes it again." });
    expect(await reading('{"port":0}')).toEqual({
      ok: false,
      problem: "The port file in this extension's folder does not name a port. Restart the environment, which writes it again.",
    });
  });
});
