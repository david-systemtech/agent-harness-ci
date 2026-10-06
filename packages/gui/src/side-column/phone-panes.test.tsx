import { screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-pane-*.tsx", { eager: true }));
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(["files", "file", "diff", "documents", "tasks", "agent", "preview", "markdown", "scope"])("shows phone pane %s through the browser runtime without a shell", async pane => {
  const root = document.createElement("div"); document.body.append(root);
  const gallery = await mountGallery(root, `phone-pane-${pane}`, "dark", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  await waitFor(() => expect(root.dataset["galleryReady"]).toBe(`phone-pane-${pane}`));
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.shell).toBeUndefined();
  if (pane === "files") expect(screen.getByRole("heading", { name: "The workspace" })).toBeDefined();
  if (pane === "file") expect(within(screen.getByRole("region", { name: "Files" })).getByRole("code").textContent).toContain("const total");
  if (pane === "diff") expect(screen.getByRole("article", { name: "src/totals.ts" })).toBeDefined();
  if (pane === "documents") expect(screen.getByRole("article", { name: "site/index.html" })).toBeDefined();
  if (pane === "tasks") expect(screen.getByRole("list", { name: "Live work" })).toBeDefined();
  if (pane === "agent") {
    expect(screen.getByRole("group", { name: "The agent's transcript" }).textContent).toContain("The parser is in src/parser.ts.");
    const before = gallery.world.world.environment("desk").requests("runs.stopTask").length;
    const columns = gallery.world.presentation.values.read().sideColumns;
    const key = Object.keys(columns)[0]!;
    gallery.world.presentation.set("sideColumns", { ...columns, [key]: { ...columns[key]!, hidden: true } });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Side column" })).toBeNull());
    gallery.world.presentation.set("sideColumns", columns);
    expect(await screen.findByRole("group", { name: "The agent's transcript" })).toBeDefined();
    expect(gallery.world.world.environment("desk").requests("runs.stopTask")).toHaveLength(before);
  }
  if (pane === "preview") {
    const frame = screen.getByTitle("Preview of site/index.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
  }
  if (pane === "markdown") expect(screen.getByRole("heading", { name: "Receipt notes" })).toBeDefined();
  if (pane === "scope") {
    const environmentId = gallery.world.world.environment("desk").environmentId;
    const reason = gallery.world.runtime.capability(environmentId, "files.list");
    expect(reason.status).toBe("absent");
    expect(within(screen.getByRole("region", { name: "Files" })).getByRole("button", { name: "Give this phone full access" })).toBeDefined();
    expect(gallery.world.world.environment("desk").requests("files.list")).toHaveLength(0);
  }
});

it("restores the Documents sheet on a revoked connection's reload with no hint over the needs-pairing notice above it", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const Observer = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => callback(entries.map(entry => ({ ...entry, borderBoxSize: [{ inlineSize: 390, blockSize: 844 }] })), observer));
    }
  });
  const root = document.createElement("div"); document.body.append(root);
  const gallery = await mountGallery(root, "phone-pane-reload-revoked", "dark", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const notice = screen.getByText("This connection needs pairing again. Make a new code on a trusted client, then choose Pair.");
  const sheet = screen.getByRole("dialog", { name: "Side column" });
  expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Close side sheet" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(sheet.contains(notice)).toBe(false);
  expect(notice.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
