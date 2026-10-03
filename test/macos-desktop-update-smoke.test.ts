import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const script = pathToFileURL(join(import.meta.dirname, "..", "scripts", "macos-desktop-update-smoke.mjs")).href;
const { askForPackagedUpdate, packagedSettingsOpen, clickPackagedSettings } = await import(script) as {
  askForPackagedUpdate: (evaluate: (expression: string) => Promise<unknown>, version: string) => Promise<void>;
  packagedSettingsOpen: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  clickPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
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
