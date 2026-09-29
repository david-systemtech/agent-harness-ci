import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, start } from "../test/harness.js";

afterEach(cleanUp);

describe("the navigation lockdown", () => {
  it("lets the window navigate within the app scheme's pages", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    expect(contents.navigate("agent-harness://app/").prevented).toBe(false);
    expect(contents.navigate("agent-harness://app/index.html#settings").prevented).toBe(false);
    expect(electron.shell.opened).toEqual([]);
  });

  it("keeps the window on the app scheme and hands an http or https link to the OS's browser", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    expect(contents.navigate("https://docs.example.org/guide").prevented).toBe(true);
    expect(contents.navigate("http://desk.lan:4777/pair#K7Q2MXH4RT").prevented).toBe(true);
    await Promise.resolve();
    expect(electron.shell.opened).toEqual(["https://docs.example.org/guide", "http://desk.lan:4777/pair#K7Q2MXH4RT"]);
  });

  it("drops a link to any other scheme: not followed, not opened", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://desk.lan", "agent-harness://pair?code=K7Q2MXH4RT", "agent-harness-preview://grant/1"]) {
      expect({ url, prevented: contents.navigate(url).prevented }).toEqual({ url, prevented: true });
    }
    await Promise.resolve();
    expect(electron.shell.opened).toEqual([]);
  });

  it("opens no second window: a new window's http or https link goes to the OS's browser, any other nowhere", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    expect(contents.openWindow("https://github.com/david/agent-harness")).toEqual({ action: "deny" });
    expect(contents.openWindow("agent-harness://app/")).toEqual({ action: "deny" });
    expect(contents.openWindow("file:///etc/passwd")).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(electron.shell.opened).toEqual(["https://github.com/david/agent-harness"]);
    expect(electron.windows).toHaveLength(1);
  });
});

describe("the network lockdown", () => {
  it("lets the app scheme's pages and the preview scheme load", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    expect(contents.cancels("agent-harness://app/")).toBe(false);
    expect(contents.cancels("agent-harness://app/assets/index.js")).toBe(false);
    expect(contents.cancels("agent-harness-preview://grant/3")).toBe(false);
  });

  it("lets DevTools' own frontend load, which runs in the window's profile and which no page can reach", async () => {
    const { electron } = await start();
    expect(electron.window().webContents.cancels("devtools://devtools/bundled/devtools_app.html")).toBe(false);
  });

  it("cancels every request elsewhere: the web, files, and the app scheme's other hosts", async () => {
    const { electron, shell } = await start();
    await shell().network.allow(["http://desk.lan:4777"]);
    const contents = electron.window().webContents;
    for (const url of [
      "https://cdn.example.org/font.woff2",
      "http://desk.lan:4777/.well-known/agent-harness/environment",
      "http://127.0.0.1:4777/api/pair",
      "file:///etc/passwd",
      "agent-harness://pair?code=K7Q2MXH4RT",
      "chrome-extension://abcdefghijklmnop/page.html",
    ]) {
      expect({ url, cancelled: contents.cancels(url) }).toEqual({ url, cancelled: true });
    }
  });

  it("lets a WebSocket through to an address the renderer declared, ws for http and wss for https, and no other", async () => {
    const { electron, shell } = await start();
    const contents = electron.window().webContents;
    expect(contents.cancels("ws://desk.lan:4777/ws")).toBe(true);

    await shell().network.allow(["http://desk.lan:4777", "https://studio.example.org"]);
    expect(contents.cancels("ws://desk.lan:4777/ws")).toBe(false);
    expect(contents.cancels("wss://studio.example.org/ws")).toBe(false);
    expect(contents.cancels("wss://studio.example.org:443/ws")).toBe(false);
    expect(contents.cancels("wss://desk.lan:4777/ws")).toBe(true);
    expect(contents.cancels("ws://studio.example.org/ws")).toBe(true);
    expect(contents.cancels("ws://desk.lan:4778/ws")).toBe(true);
    expect(contents.cancels("ws://evil.example.org/ws")).toBe(true);
  });

  it("takes each declaration as the whole list, so an address left out is closed again", async () => {
    const { electron, shell } = await start();
    const contents = electron.window().webContents;
    await shell().network.allow(["http://desk.lan:4777", "http://laptop.lan:4777"]);
    await shell().network.allow(["http://laptop.lan:4777"]);
    expect(contents.cancels("ws://desk.lan:4777/ws")).toBe(true);
    expect(contents.cancels("ws://laptop.lan:4777/ws")).toBe(false);
  });

  it("always lets a WebSocket through to loopback, where this machine's environment listens", async () => {
    const { electron } = await start();
    const contents = electron.window().webContents;
    expect(contents.cancels("ws://127.0.0.1:4777/ws")).toBe(false);
    expect(contents.cancels("ws://localhost:51234/ws")).toBe(false);
    expect(contents.cancels("ws://[::1]:4777/ws")).toBe(false);
    expect(contents.cancels("ws://127.0.0.1.evil.example.org/ws")).toBe(true);
  });

  it("refuses a declaration that is not an http or https address, keeping the list it had", async () => {
    const { electron, shell } = await start();
    const contents = electron.window().webContents;
    await shell().network.allow(["http://desk.lan:4777"]);
    await expect(shell().network.allow(["ws://laptop.lan:4777"])).rejects.toThrow(/http and https addresses/);
    await expect(shell().network.allow(["desk.lan"])).rejects.toThrow(/http and https addresses/);
    expect(contents.cancels("ws://desk.lan:4777/ws")).toBe(false);
  });
});
