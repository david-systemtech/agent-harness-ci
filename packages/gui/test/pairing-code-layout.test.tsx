// @vitest-environment jsdom-on-node
import { SCOPES } from "@agent-harness/contracts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { discoverScenes, type SceneModule, type SceneRegistry } from "../gallery/scene-registry.js";
import { capturePlan } from "../gallery/capture-plan.js";
import { phoneLayout } from "./phone-layout.js";
import { readFileSync } from "node:fs";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each(["web", "desktop"] as const)("gives minted HTTPS pairing details a reading width on %s, with manual values selectable", async platform => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/machines/pairing-code.css", import.meta.url), "utf8"); document.body.append(style);
  const container = document.createElement("div"); document.body.append(container);
  const registry = {
    "pairing-layout": {
      ...(platform === "web" && { platform: "web" as const }),
      script: { environments: [{ name: "desk", reach: "paired", scopes: [...SCOPES], hello: { ceiling: "bypassPermissions" }, status: { binding: {
        tailnet: null, tailnetFound: null, tailscaleInstalled: false, lan: null, lanAddresses: [], webOrigin: "https://pairing-server.example.test:8443",
      } } }] },
      presentation: { settingsRow: "environments.machines" },
    },
  } satisfies SceneRegistry;
  const gallery = await mountGallery(container, "pairing-layout", "light", registry); close = gallery.close;
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const card = await screen.findByRole("region", { name: "desk" });
  const part = within(card).getByRole("region", { name: "Pair another client" });
  await user.click(within(part).getByRole("button", { name: "Make a pairing code" }));
  const code = await within(part).findByRole("group", { name: "Pairing code" });
  await user.click(within(code).getByRole("button", { name: "Type it instead" }));
  const timer = within(code).getByRole("timer");
  // jsdom cannot lay out flex lines. The hosted phone scene measures the resulting
  // full-width column; here the real minted DOM must opt into a reading-width basis.
  expect(getComputedStyle(timer.parentElement!).flex).toBe("1 1 18rem");
  expect(getComputedStyle(timer.parentElement!).flexGrow).toBe("1");
  expect(getComputedStyle(timer.parentElement!).flexShrink).toBe("1");
  expect(within(code).getByRole("img", { name: "QR code of the pairing link" })).toBeDefined();
  expect(within(code).getByText("https://pairing-server.example.test:8443/pair#K7Q2MXH4RV").tagName).toBe("PRE");
  expect(within(code).getByText("https://pairing-server.example.test:8443").tagName).toBe("PRE");
  expect(within(code).getByText("K7Q2M-XH4RV").tagName).toBe("PRE");
  expect(timer.textContent).toBe("This code works once, for 10 minutes. 10 min left.");
  if (platform === "desktop") {
    for (const label of ["Copy pairing link", "Copy address", "Copy pairing code"]) await user.click(within(code).getByRole("button", { name: label }));
    expect(gallery.world.shell?.calls.filter(call => call[0] === "clipboard.writeText").map(call => call[1])).toEqual([
      "https://pairing-server.example.test:8443/pair#K7Q2MXH4RV", "https://pairing-server.example.test:8443", "K7Q2M-XH4RV",
    ]);
  }
  await user.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

it.each(capturePlan(["phone-connections-pairing"]).captures.filter(capture => capture.ladder === "dark"))("captures the minted code with Type it instead expanded in $name", async capture => {
  phoneLayout(); vi.stubGlobal("innerWidth", capture.viewport.width); vi.stubGlobal("innerHeight", capture.viewport.height);
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-connections-pairing.tsx", { eager: true }));
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  const gallery = await mountGallery(container, capture.scene, capture.ladder, registry, { platform: "web", textSize: capture.textSize });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const code = screen.getByRole("group", { name: "Pairing code" });
  expect(within(code).getByRole("button", { name: "Type it instead" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(code).getByRole("img", { name: "QR code of the pairing link" })).toBeDefined();
  expect(code.querySelectorAll("pre")).toHaveLength(3);
  expect(code.textContent).toContain("https://pairing-server.example.test:8443/pair#K7Q2MXH4RV");
  expect(code.textContent).toContain("K7Q2M-XH4RV");
  expect(within(code).getByRole("timer").textContent).toContain("10 min left.");
  expect(screen.getByRole("note", { name: "This client's grant" }).textContent).toContain("bypassPermissions");
  expect(gallery.world.world.environment("desk").requests("access.pairings.create")[0]?.params).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
  const geometry = registry[capture.scene]!.geometry;
  const rules = typeof geometry === "function" ? geometry(capture.viewport) : geometry ?? [];
  expect(rules.filter(rule => document.querySelector(rule.selector) === null)).toEqual([]);
  expect(gallery.world.presentation.values.read().textSize).toBe(capture.textSize);
  await userEvent.setup().click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});
