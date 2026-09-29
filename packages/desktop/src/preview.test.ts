import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";
import { startDesktop } from "./desktop.js";
import { PREVIEWS_KEPT } from "./preview.js";

afterEach(cleanUp);

/**
 * The preview scheme (docs/specs/gui.md, "The desktop shell": the shell's
 * `preview`; #410): `preview.grant` takes bytes and a media type from the
 * app's page and answers a URL on `agent-harness-preview:` that serves them
 * from memory, a snapshot, under a policy allowing no network; any other
 * URL answers nothing. Driven with Electron's modules faked.
 */

const PAGE = new TextEncoder().encode('<!doctype html><h1>Receipts</h1><script>document.body.append("ran")</script>');
const DRAWING = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');

/** A content policy as its directives, each with its sources. */
const directives = (policy: string | null): Record<string, string[]> =>
  Object.fromEntries(
    (policy ?? "")
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );

describe("the preview scheme", () => {
  it("is registered standard and secure before the app is ready, in the one registration beside the app scheme", async () => {
    const electron = fakeElectron({ ready: false });
    const started = startDesktop(electron, platformOn("linux"));
    expect(electron.protocol.privileged).toEqual([
      { scheme: "agent-harness", privileges: expect.objectContaining({ standard: true, secure: true }) },
      { scheme: "agent-harness-preview", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } },
    ]);
    electron.app.becomeReady();
    await started;
  });

  it("answers each grant with a URL of its own that serves the bytes and media type granted, as they were when granted", async () => {
    const { electron, shell } = await start();
    const bytes = new Uint8Array(PAGE);
    const page = await shell().preview.grant({ bytes, mediaType: "text/html; charset=utf-8" });
    const drawing = await shell().preview.grant({ bytes: DRAWING, mediaType: "image/svg+xml" });
    expect(page).toMatch(/^agent-harness-preview:\/\/[0-9a-f]{32}\/$/);
    expect(drawing).toMatch(/^agent-harness-preview:\/\/[0-9a-f]{32}\/$/);
    expect(drawing).not.toBe(page);
    // What the page's bytes become after the grant is not what the preview shows: it serves a snapshot.
    bytes.fill(0);

    const served = await electron.protocol.load(page);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PAGE);
    const svg = await electron.protocol.load(drawing);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(new Uint8Array(await svg.arrayBuffer())).toEqual(DRAWING);
    // Twice: a frame loaded again is answered again.
    expect(new Uint8Array(await (await electron.protocol.load(page)).arrayBuffer())).toEqual(PAGE);
  });

  it("serves what it grants under a policy with no network: inline scripts and styles run, sandboxed, and nothing loads from anywhere", async () => {
    const { electron, shell } = await start();
    const url = await shell().preview.grant({ bytes: PAGE, mediaType: "text/html" });
    const answer = await electron.protocol.load(url);
    const policy = directives(answer.headers.get("content-security-policy"));
    expect(policy["default-src"]).toEqual(["'none'"]);
    expect(policy["connect-src"]).toEqual(["'none'"]);
    expect(policy["script-src"]).toEqual(["'unsafe-inline'", "'unsafe-eval'"]);
    expect(policy["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(policy["form-action"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'none'"]);
    // Sandboxed with scripts and without same-origin, however it is loaded.
    expect(policy["sandbox"]).toEqual(["allow-scripts"]);
    // No source anywhere names a place to fetch from: only the page's own inline text and data: or blob: URLs it makes.
    const sources = Object.entries(policy)
      .filter(([name]) => name !== "sandbox")
      .flatMap(([, list]) => list);
    expect(sources.filter((source) => !["'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:"].includes(source))).toEqual([]);
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  it("answers nothing for any URL it did not grant: another token, another path or query of a granted one", async () => {
    const { electron, shell } = await start();
    const url = await shell().preview.grant({ bytes: PAGE, mediaType: "text/html" });
    const token = new URL(url).host;
    for (const other of [
      "agent-harness-preview://aa/",
      `agent-harness-preview://${token}/style.css`,
      `agent-harness-preview://${token}/?again`,
      `agent-harness-preview://${token}/..%2f`,
    ]) {
      const answer = await electron.protocol.load(other);
      expect({ other, status: answer.status, body: await answer.text() }).toEqual({ other, status: 404, body: "" });
      expect(directives(answer.headers.get("content-security-policy"))["default-src"]).toEqual(["'none'"]);
    }
  });

  it(`keeps the latest ${PREVIEWS_KEPT} grants: an older one answers nothing`, async () => {
    const { electron, shell } = await start();
    const urls: string[] = [];
    for (let i = 0; i <= PREVIEWS_KEPT; i++) urls.push(await shell().preview.grant({ bytes: new TextEncoder().encode(`<p>${i}</p>`), mediaType: "text/html" }));
    expect((await electron.protocol.load(urls[0]!)).status).toBe(404);
    expect(await (await electron.protocol.load(urls[1]!)).text()).toBe("<p>1</p>");
    expect(await (await electron.protocol.load(urls.at(-1)!)).text()).toBe(`<p>${PREVIEWS_KEPT}</p>`);
  });

  it("refuses a grant that is not bytes with a media type, one too large, and one asked from anything but the app's page", async () => {
    const { shell } = await start();
    await expect(shell().preview.grant({ bytes: "<h1>text</h1>" as unknown as Uint8Array, mediaType: "text/html" })).rejects.toThrow(/bytes/);
    // Nothing that could end the header, next to a parameter's semicolon either.
    for (const mediaType of ["text/html\r\nx-other: 1", "text/html\r\n;x=1", "text/html;\r\nx=1", "text/html; charset=utf-8\n"]) {
      await expect(shell().preview.grant({ bytes: PAGE, mediaType })).rejects.toThrow(/media type/);
    }
    await expect(shell().preview.grant({ bytes: new Uint8Array(8 * 1024 * 1024 + 1), mediaType: "text/html" })).rejects.toThrow(/8 MiB/);
    await expect(shell("agent-harness-preview://aa/").preview.grant({ bytes: PAGE, mediaType: "text/html" })).rejects.toThrow(/the app's own page only/);
  });

  it("is framed by the app's page alone: the app scheme's policy lets frames load from the preview scheme and nowhere else", async () => {
    const { electron } = await start();
    const policy = directives((await electron.protocol.load("agent-harness://app/")).headers.get("content-security-policy"));
    expect(policy["frame-src"]).toEqual(["agent-harness-preview:"]);
  });
});
