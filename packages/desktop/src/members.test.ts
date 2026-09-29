import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THEME, type Theme } from "@agent-harness/contracts";
import { derive, windowBackground } from "@agent-harness/theme";
import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, scratch, start } from "../test/harness.js";

afterEach(cleanUp);

/** Lets a told member, which the renderer does not await, reach the main process. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Canvas colour of a theme other than the preset, as the renderer would set it. */
const slate: Theme = { ...DEFAULT_THEME, name: "Slate", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250, chroma: 0.02 } } };
const slateCanvas = windowBackground(derive(slate).dark);

describe("window", () => {
  it("sets the window's title and brings it forward, restoring it when minimised", async () => {
    const { electron, shell } = await start();
    const window = electron.window();
    window.minimized = true;
    shell().window.setTitle("desk — agent-harness");
    shell().window.focus();
    await settle();
    expect(window.calls).toEqual(expect.arrayContaining([["setTitle", "desk — agent-harness"], ["restore"], ["show"], ["focus"]]));
  });

  it("shows a badge on macOS's Dock as a count or a text, and clears it", async () => {
    const { electron, shell } = await start({ electron: fakeElectron({ os: "darwin" }), platform: platformOn("darwin") });
    shell().window.setBadge(3);
    shell().window.setBadge("!");
    shell().window.setBadge(undefined);
    await settle();
    expect(electron.app.calls.filter(([method]) => method === "dock.setBadge")).toEqual([
      ["dock.setBadge", "3"],
      ["dock.setBadge", "!"],
      ["dock.setBadge", ""],
    ]);
  });

  it("shows a count on Linux's launcher, where a text cannot show, and clears it", async () => {
    const { electron, shell } = await start({ electron: fakeElectron({ os: "linux" }), platform: platformOn("linux") });
    shell().window.setBadge(2);
    shell().window.setBadge(undefined);
    await settle();
    expect(electron.app.calls.filter(([method]) => method === "setBadgeCount")).toEqual([
      ["setBadgeCount", 2],
      ["setBadgeCount", 0],
    ]);
  });

  it("on Windows, which draws no badge, has the taskbar button ask for attention while one is set", async () => {
    const { electron, shell } = await start({ electron: fakeElectron({ os: "win32" }), platform: platformOn("win32") });
    shell().window.setBadge(4);
    shell().window.setBadge(0);
    await settle();
    expect(electron.window().calls.filter(([method]) => method === "flashFrame")).toEqual([
      ["flashFrame", true],
      ["flashFrame", false],
    ]);
    expect(electron.app.calls.map(([method]) => method)).not.toContain("setBadgeCount");
  });

  it("opens on the preset's Canvas from the theme package on first launch, in the ladder the OS prefers, never the OS's colour", async () => {
    const dark = await start({ electron: fakeElectron({ dark: true }) });
    expect(dark.electron.window().options.backgroundColor).toBe(windowBackground(derive(DEFAULT_THEME).dark));
    const light = await start({ electron: fakeElectron({ dark: false }) });
    expect(light.electron.window().options.backgroundColor).toBe(windowBackground(derive(DEFAULT_THEME).light));
  });

  it("paints the Canvas colour the renderer sets behind the page, and opens the next launch on it", async () => {
    const platform = platformOn("linux");
    const first = await start({ platform });
    first.shell().window.setBackgroundColour(slateCanvas);
    await settle();
    expect(first.electron.window().calls).toContainEqual(["setBackgroundColor", slateCanvas]);

    const next = await start({ platform, electron: fakeElectron({ dark: false }) });
    expect(next.electron.window().options.backgroundColor).toBe(slateCanvas);
  });

  it("refuses a background colour that is not #rrggbb, and keeps the last one", async () => {
    const platform = platformOn("linux");
    const errors: unknown[] = [];
    const first = await start({ platform, reportError: (error) => errors.push(error) });
    first.shell().window.setBackgroundColour(slateCanvas);
    first.shell().window.setBackgroundColour("red");
    await settle();
    expect(first.electron.window().calls.filter(([method]) => method === "setBackgroundColor")).toEqual([["setBackgroundColor", slateCanvas]]);
    expect(String(errors[0])).toMatch(/#rrggbb/);

    const next = await start({ platform });
    expect(next.electron.window().options.backgroundColor).toBe(slateCanvas);
  });

  it("opens on the preset's Canvas when what it kept is not a colour", async () => {
    const platform = platformOn("linux");
    writeFileSync(join(platform.paths.data, "window.json"), '{"canvas":"url(evil)"}');
    const { electron } = await start({ platform });
    expect(electron.window().options.backgroundColor).toBe(windowBackground(derive(DEFAULT_THEME).dark));
  });
});

describe("dialogs", () => {
  it("opens files modal to the window, one or several, and answers their paths, or none when cancelled", async () => {
    const { electron, shell } = await start();
    electron.dialog.opens.push(["/home/seth/notes.md"], ["/home/seth/a.png", "/home/seth/b.png"], undefined);

    expect(await shell().dialogs.openFile({ title: "Open", filters: [{ name: "Markdown", extensions: ["md"] }] })).toEqual(["/home/seth/notes.md"]);
    expect(await shell().dialogs.openFile({ multiple: true })).toEqual(["/home/seth/a.png", "/home/seth/b.png"]);
    expect(await shell().dialogs.openFile()).toEqual([]);

    const window = electron.window();
    expect(electron.dialog.calls).toEqual([
      ["showOpenDialog", window, { title: "Open", filters: [{ name: "Markdown", extensions: ["md"] }], properties: ["openFile"] }],
      ["showOpenDialog", window, { properties: ["openFile", "multiSelections"] }],
      ["showOpenDialog", window, { properties: ["openFile"] }],
    ]);
  });

  it("answers the files chosen for their contents by name, size and bytes, one larger than maxBytes unread, none when cancelled", async () => {
    const { electron, shell } = await start();
    const folder = scratch();
    writeFileSync(join(folder, "notes.md"), "# Notes\n");
    writeFileSync(join(folder, "disk.img"), Buffer.alloc(4096));
    electron.dialog.opens.push([join(folder, "notes.md"), join(folder, "disk.img")], undefined);

    const files = await shell().dialogs.openFileContents({ multiple: true, maxBytes: 1024 });
    expect(files).toEqual([
      { name: "notes.md", size: 8, bytes: new Uint8Array(Buffer.from("# Notes\n")) },
      { name: "disk.img", size: 4096, bytes: null },
    ]);
    expect(await shell().dialogs.openFileContents()).toEqual([]);
  });

  it("chooses a directory, and a place to save, each undefined when cancelled", async () => {
    const { electron, shell } = await start();
    electron.dialog.opens.push(["/home/seth/code/harness"], undefined);
    electron.dialog.saves.push("/home/seth/transcript.md", undefined);

    expect(await shell().dialogs.openDirectory({ title: "Workspace" })).toBe("/home/seth/code/harness");
    expect(await shell().dialogs.openDirectory()).toBeUndefined();
    expect(await shell().dialogs.save({ defaultPath: "transcript.md", filters: [{ name: "Markdown", extensions: ["md"] }] })).toBe("/home/seth/transcript.md");
    expect(await shell().dialogs.save()).toBeUndefined();

    const window = electron.window();
    expect(electron.dialog.calls).toEqual([
      ["showOpenDialog", window, { title: "Workspace", properties: ["openDirectory"] }],
      ["showOpenDialog", window, { properties: ["openDirectory"] }],
      ["showSaveDialog", window, { defaultPath: "transcript.md", filters: [{ name: "Markdown", extensions: ["md"] }] }],
      ["showSaveDialog", window, {}],
    ]);
  });

  it("refuses options the shell interface does not allow, before any dialog opens", async () => {
    const { electron, shell } = await start();
    const dialogs = shell().dialogs as unknown as Record<string, (options: unknown) => Promise<unknown>>;
    await expect(dialogs["openFile"]?.({ title: 7 })).rejects.toThrow(/title must be text/);
    await expect(dialogs["openFileContents"]?.({ maxBytes: -1 })).rejects.toThrow(/maxBytes/);
    await expect(dialogs["save"]?.({ filters: "md" })).rejects.toThrow(/filters/);
    expect(electron.dialog.calls).toEqual([]);
  });
});

describe("clipboard", () => {
  it("reads and writes text", async () => {
    const { electron, shell } = await start();
    await shell().clipboard.writeText("git status");
    expect(electron.clipboard.text).toBe("git status");
    electron.clipboard.text = "pnpm test";
    expect(await shell().clipboard.readText()).toBe("pnpm test");
  });

  it("reads the picture the clipboard holds for pasting, and nothing when it holds none", async () => {
    const { electron, shell } = await start();
    electron.clipboard.text = "caption";
    expect(await shell().clipboard.readImage()).toBeUndefined();

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    electron.clipboard.image = { bytes: png, mediaType: "image/png" };
    expect(await shell().clipboard.readImage()).toEqual({ bytes: png, mediaType: "image/png" });
  });
});

describe("openExternal", () => {
  it("opens an http or https link in the OS's browser, and refuses any other", async () => {
    const { electron, shell } = await start();
    await shell().openExternal("https://github.com/david/agent-harness/issues/394");
    await expect(shell().openExternal("file:///etc/passwd")).rejects.toThrow(/http and https/);
    await expect(shell().openExternal("ms-settings:privacy")).rejects.toThrow(/http and https/);
    expect(electron.shell.opened).toEqual(["https://github.com/david/agent-harness/issues/394"]);
  });
});

describe("system", () => {
  it("answers the platform, architecture, hostname and user the desktop runs as, by Node's names", async () => {
    const { shell } = await start({
      electron: fakeElectron({ os: "win32" }),
      platform: platformOn("win32", { architecture: "x64", hostname: "STUDIO", user: "seth" }),
    });
    expect(await shell().system()).toEqual({ platform: "win32", architecture: "x64", hostname: "STUDIO", user: "seth" });
  });
});

/** An environment's HTTP routes on loopback, answering with no cross-origin headers, recording what it heard. */
const environment = async (): Promise<{ readonly origin: string; readonly heard: IncomingMessage[]; readonly bodies: string[]; readonly server: Server }> => {
  const heard: IncomingMessage[] = [];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    heard.push(request);
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      bodies.push(body);
      if (request.url === "/api/update") {
        response.writeHead(302, { location: "http://elsewhere.example.org/api/update" }).end();
        return;
      }
      response.writeHead(request.url === "/api/pair" ? 401 : 200, { "content-type": "application/json" });
      response.end(request.url === "/api/pair" ? '{"code":"pairing_code_unknown"}' : '{"protocol":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard, bodies, server };
};

describe("http", () => {
  it("reads discovery and makes the pairing exchange from the main process, needing no cross-origin headers", async () => {
    const env = await environment();
    try {
      const { shell } = await start();
      const discovery = await shell().http(`${env.origin}/.well-known/agent-harness/environment`, { method: "GET" });
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toEqual({ protocol: 1 });

      const exchange = await shell().http(`${env.origin}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"code":"K7Q2MXH4RT"}',
      });
      expect(exchange.status).toBe(401);
      expect(await exchange.json()).toEqual({ code: "pairing_code_unknown" });
      expect(env.heard[1]?.method).toBe("POST");
      expect(env.heard[1]?.headers["content-type"]).toBe("application/json");
      expect(env.bodies[1]).toBe('{"code":"K7Q2MXH4RT"}');
      // Made outside the page, it carries no Origin for the environment to check.
      expect(env.heard.map((request) => request.headers.origin)).toEqual([undefined, undefined]);
    } finally {
      env.server.close();
    }
  });

  it("answers a redirect as it is, and does not follow it", async () => {
    const env = await environment();
    try {
      const { shell } = await start();
      const answer = await shell().http(`${env.origin}/api/update`, { method: "POST", body: "{}" });
      expect(answer.status).toBe(302);
      expect(env.heard).toHaveLength(1);
    } finally {
      env.server.close();
    }
  });

  it("reaches discovery, the pairing and bootstrap exchanges and the update route only, over http or https", async () => {
    const { shell } = await start();
    await expect(shell().http("http://127.0.0.1:4777/api/sessions")).rejects.toThrow(/discovery, pairing, bootstrap and update routes only/);
    await expect(shell().http("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/routes only/);
    await expect(shell().http("file:///api/pair")).rejects.toThrow(/http and https/);
    await expect(shell().http("http://seth:password-for-tests@127.0.0.1:4777/api/bootstrap")).rejects.toThrow(/credentials/);
    await expect(shell().http("http://127.0.0.1:4777/api/pair", { method: "DELETE" } as never)).rejects.toThrow(/GET and POST/);
  });
});

describe("the shell's callers", () => {
  it("answers the app's own page only: a frame elsewhere, or one gone, is refused and changes nothing", async () => {
    const refused: unknown[] = [];
    const { electron, shell } = await start({ reportError: (error) => refused.push(error) });
    for (const from of ["https://evil.example.org/", "agent-harness-preview://grant/1", "file:///tmp/page.html", null]) {
      await expect(shell(from).system()).rejects.toThrow(/app's own page/);
      await expect(shell(from).clipboard.writeText("stolen")).rejects.toThrow(/app's own page/);
      shell(from).window.setTitle("hijacked");
    }
    await settle();
    expect(electron.clipboard.text).toBe("");
    expect(electron.window().calls.map(([method]) => method)).not.toContain("setTitle");
    expect(refused.map(String)).toEqual(Array(4).fill("Error: The desktop shell answers the app's own page only."));
  });
});
