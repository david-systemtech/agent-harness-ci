import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";
import { startDesktop } from "./desktop.js";

afterEach(cleanUp);

/** A content policy as its directives, each with its sources. */
const directives = (policy: string | null): Record<string, string[]> =>
  Object.fromEntries(
    (policy ?? "")
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );

describe("the app scheme", () => {
  it("is registered standard and secure before the app is ready, so the renderer's storage has a stable origin", async () => {
    const electron = fakeElectron({ ready: false });
    const started = startDesktop(electron, platformOn("linux"));
    expect(electron.protocol.privileged).toEqual([
      { scheme: "agent-harness", privileges: expect.objectContaining({ standard: true, secure: true }) },
    ]);
    electron.app.becomeReady();
    await started;
  });

  it("serves the gui build's page at agent-harness://app/, and its script and stylesheet by their paths", async () => {
    const { electron } = await start();
    const page = await electron.protocol.load("agent-harness://app/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain('src="./assets/index.js"');

    const script = await electron.protocol.load("agent-harness://app/assets/index.js");
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    const stylesheet = await electron.protocol.load("agent-harness://app/assets/index.css");
    expect(stylesheet.headers.get("content-type")).toMatch(/^text\/css/);
  });

  it("answers every page and file with a policy of default-src 'none', scripts and styles from the app scheme only", async () => {
    const { electron } = await start();
    for (const url of ["agent-harness://app/", "agent-harness://app/assets/index.js", "agent-harness://app/missing.js"]) {
      const policy = directives((await electron.protocol.load(url)).headers.get("content-security-policy"));
      expect(policy["default-src"]).toEqual(["'none'"]);
      expect(policy["script-src"]).toEqual(["agent-harness://app"]);
      expect(policy["style-src"]).toEqual(["agent-harness://app"]);
      // Nothing inline, evaluated or from the web: WebSockets only, which the request lockdown narrows.
      expect(Object.values(policy).flat()).not.toEqual(expect.arrayContaining(["'unsafe-inline'"]));
      expect(Object.values(policy).flat()).not.toEqual(expect.arrayContaining(["'unsafe-eval'"]));
      expect(policy["connect-src"]).toEqual(["ws:", "wss:"]);
    }
  });

  it("refuses the text of a <style> element a script adds: no nonce, hash or 'unsafe-inline' admits one, so xterm.js's stylesheets go through the CSSOM (#486)", async () => {
    const { electron } = await start();
    const policy = directives((await electron.protocol.load("agent-harness://app/")).headers.get("content-security-policy"));
    // `style-src-elem` and `style-src-attr` would each stand in for `style-src` on their own; neither is sent.
    expect(Object.keys(policy).filter((name) => name.startsWith("style-src"))).toEqual(["style-src"]);
    expect(policy["style-src"]).toEqual(["agent-harness://app"]);
    expect(policy["style-src"]?.filter((source) => /^'(unsafe-inline|unsafe-hashes|nonce-|sha(256|384|512)-)/.test(source))).toEqual([]);
  });

  it("answers 404 for a file the build lacks, a path climbing out of it, and any host but app", async () => {
    const { electron, platform } = await start();
    writeFileSync(join(dirname(platform.paths.renderer), "secret.txt"), "not the renderer's");
    for (const url of [
      "agent-harness://app/missing.js",
      "agent-harness://app/..%2fsecret.txt",
      "agent-harness://app/assets/..%2f..%2fsecret.txt",
      "agent-harness://app/%E0%A4%A",
      "agent-harness://pair/index.html",
    ]) {
      const answer = await electron.protocol.load(url);
      expect({ url, status: answer.status }).toEqual({ url, status: 404 });
    }
  });
});
