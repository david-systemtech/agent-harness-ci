// @vitest-environment jsdom-on-node
import { screen } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { route } from "../../gallery/phone-frame-scene.js";

interface Screen { readonly width: number; readonly height: number; readonly touch: boolean }

/** Answers the two queries of `phoneLayoutMedia` as a screen of that size and pointer would. */
const matching = ({ width, height, touch }: Screen) => (query: string) => {
  if (query === "(width < 640px)") return width < 640;
  if (query.startsWith("(pointer: coarse)")) return touch && width >= 640 && width <= 960 && height <= 500;
  return false;
};

const openComposer = async (shape: Screen) => {
  vi.stubGlobal("innerWidth", shape.width);
  vi.stubGlobal("innerHeight", shape.height);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: matching(shape)(query), media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-hint-test", "dark", {
    "phone-hint-test": {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"],
        environmentId: "0199cc00-0000-4000-8000-000000000001",
        sessions: [{ id: "0199dd00-0000-4000-8000-000000000001", title: "Receipts", workspace: { kind: "directory", path: "/work/receipts" } }],
      }] },
      readySelector: '[aria-label="Message"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const actions = document.querySelector<HTMLElement>("[data-composer-actions]");
  if (actions === null) throw new Error("the composer has no actions row");
  return actions;
};

it.each([
  ["a portrait phone", { width: 390, height: 844, touch: true }],
  ["a short landscape phone", { width: 844, height: 390, touch: true }],
])("shows no key chord in the composer footer on %s", async (_, shape) => {
  const actions = await openComposer(shape);
  expect(actions.textContent).not.toMatch(/newline|New line/);
  expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
});

it.each([
  ["a wide window", { width: 1280, height: 800, touch: false }],
  ["a wide tablet", { width: 1024, height: 768, touch: true }],
  ["a tall touch screen", { width: 800, height: 1280, touch: true }],
])("keeps the send and newline hint on %s", async (_, shape) => {
  const actions = await openComposer(shape);
  expect(actions.textContent).toMatch(/(send|Send) · .*(newline|New line)/);
});
