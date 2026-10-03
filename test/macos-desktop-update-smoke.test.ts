import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildRelease } from "../packages/cli/scripts/release/build.js";
import { fixtureBuild } from "../packages/cli/test/release-fixtures.js";

const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-desktop-update-smoke.mjs")).href;
const { askForPackagedUpdate, packagedSettingsOpen, clickPackagedSettings, openPackagedSettings, stampPriorPackagedServer } = await import(script) as {
  askForPackagedUpdate: (evaluate: (expression: string) => Promise<unknown>, version: string) => Promise<void>;
  packagedSettingsOpen: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  clickPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  openPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>;
  stampPriorPackagedServer: (server: string, version: string) => void;
};

/** The smoke's CDP boundary evaluates in a page exposing the preload's shell; no Electron or service manager runs. */
const page = (token: string | undefined, status = 200, fromVersion = "0.0.0-0") => {
  const updates: { address: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const shell = {
    secrets: { get: async (name: string) => { expect(name).toBe("packaged-update-check"); return token; } },
    localGrant: { read: async () => ({ address: { host: "127.0.0.1", port: 4777 } }) },
    installer: { bundledServer: async () => ({ version: "0.2.0", path: "/fixture/app/server" }) },
    system: async () => ({ platform: "darwin" }),
    http: async (address: string, request?: { method: string; headers: Record<string, string>; body: string }) => {
      if (address.endsWith("/api/update")) {
        updates.push({ address, ...request! });
        return { status, json: async () => ({ toVersion: "0.2.0" }) };
      }
      return { status: 200, json: async () => ({ harnessVersion: fromVersion }) };
    },
  };
  return { updates, evaluate: async (expression: string): Promise<unknown> => runInNewContext(expression, { window: { desktopShell: shell } }) as Promise<unknown> };
};

describe("the packaged macOS update smoke", () => {
  it("prepares an older runtime in the release layout without changing dependencies or the replacement", async () => {
    const build = fixtureBuild({ host: "darwin-arm64" });
    try {
      await buildRelease(build.options({ platforms: ["darwin-arm64"] }), build.seams);
      const source = join(build.out, "source-server");
      const prior = join(build.out, "prior-server");
      mkdirSync(source);
      execFileSync("tar", ["-xf", join(build.out, "agent-harness-darwin-arm64.tar.gz"), "-C", source]);
      cpSync(source, prior, { recursive: true });
      const manifest = (root: string, path: string): unknown => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
      stampPriorPackagedServer(prior, "0.0.0-0");
      expect(manifest(prior, "node_modules/@agent-harness/environment")).toMatchObject({ version: "0.0.0-0" });
      expect(manifest(prior, "node_modules/@agent-harness/contracts")).toMatchObject({ version: "0.0.0-0" });
      expect(manifest(prior, "packages/cli")).toMatchObject({ version: "0.0.0-0", launcherProtocol: 1 });
      expect(manifest(prior, "node_modules/zod")).toEqual(manifest(source, "node_modules/zod"));
      expect(manifest(source, "node_modules/@agent-harness/environment")).toMatchObject({ version: "0.5.0" });
      expect(manifest(source, "packages/cli")).toMatchObject({ version: "0.5.0" });
    } finally {
      build.remove();
    }
  });

  it("retries transient page-context errors during preload, control, and Settings readiness", async () => {
    const dom = new JSDOM('<button aria-label="Settings">Settings</button>');
    try {
      const attempts = new Map<string, number>();
      let clicks = 0;
      dom.window.document.querySelector("button")?.addEventListener("click", () => {
        clicks++;
        dom.window.document.body.innerHTML += '<section aria-label="Settings"></section>';
      });
      const evaluate = async (expression: string): Promise<unknown> => {
        const count = (attempts.get(expression) ?? 0) + 1;
        attempts.set(expression, count);
        if (count === 1) throw new Error("Packaged page evaluation failed");
        return runInNewContext(expression, { document: dom.window.document, window: { desktopShell: {} } });
      };
      await openPackagedSettings(evaluate);
      expect([...attempts.values()]).toEqual([2, 2, 2]);
      expect(clicks).toBe(1);
      expect(await packagedSettingsOpen(evaluate)).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("waits for the Settings control to mount before clicking it", async () => {
    const dom = new JSDOM("<main></main>");
    try {
      const evaluate = async (expression: string): Promise<unknown> => runInNewContext(expression, { document: dom.window.document });
      expect(await clickPackagedSettings(evaluate)).toBe(false);
      dom.window.document.body.innerHTML = '<button aria-label="Settings">Settings</button>';
      let clicks = 0;
      dom.window.document.querySelector("button")?.addEventListener("click", () => { clicks++; });
      expect(await clickPackagedSettings(evaluate)).toBe(true);
      expect(clicks).toBe(1);
    } finally {
      dom.window.close();
    }
  });

  it("recognizes the named Settings section without requiring an explicit accessibility role", async () => {
    const dom = new JSDOM('<button aria-label="Settings">Settings</button><section aria-label="Settings"></section>');
    try {
      const evaluate = async (expression: string): Promise<unknown> => runInNewContext(expression, { document: dom.window.document });
      expect(await packagedSettingsOpen(evaluate)).toBe(true);
      dom.window.document.querySelector("section")?.remove();
      expect(await packagedSettingsOpen(evaluate)).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("uses the kept client credential and the carried server to request the upgrade", async () => {
    const p = page("token-for-tests");
    await askForPackagedUpdate(p.evaluate, "0.2.0");
    expect(p.updates).toEqual([{
      address: "http://127.0.0.1:4777/api/update",
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token-for-tests" },
      body: JSON.stringify({ version: "0.2.0", artefactPath: "/fixture/app/server" }),
    }]);
  });

  it("fails when the replacement cannot read the prior credential, without exchanging a fresh grant", async () => {
    const p = page(undefined);
    await expect(askForPackagedUpdate(p.evaluate, "0.2.0")).rejects.toThrow(/prior install's credential/);
    expect(p.updates).toEqual([]);
  });

  it("fails when the kept credential cannot authorize the update", async () => {
    await expect(askForPackagedUpdate(page("token-for-tests", 401).evaluate, "0.2.0")).rejects.toThrow(/existing credential must authorize/);
  });

  it("refuses to count a fresh install already at the release version as an upgrade", async () => {
    await expect(askForPackagedUpdate(page("token-for-tests", 200, "0.2.0").evaluate, "0.2.0")).rejects.toThrow(/exercise an upgrade/);
  });
});
