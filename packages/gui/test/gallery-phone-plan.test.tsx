// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, captureShard, sceneFiles } from "../gallery/capture-plan.js";

it("preserves desktop captures and names the bounded phone profiles distinctly", () => {
  const plan = capturePlan(["window-empty", "phone-gallery-conversation"]);
  expect(plan.budget).toEqual({ desktop: 4, phone: 2, total: 6, limit: 800, remaining: 794 });
  expect(plan.captures.filter(c => c.platform === "desktop").map(c => c.name)).toEqual([
    "window-empty.light", "window-empty.dark", "window-empty-narrow.light", "window-empty-narrow.dark",
  ]);
  expect(plan.captures.filter(c => c.platform === "web").map(c => [c.name, c.viewport, c.textSize])).toEqual([
    ["phone-gallery-conversation-phone-390.light", { width: 390, height: 844 }, 14],
    ["phone-gallery-conversation-phone-390.dark", { width: 390, height: 844 }, 14],
  ]);
});

it("captures the phone pairing screen's refused origin once, in the 390 px phone it was seen on (ticket 1739)", () => {
  const plan = capturePlan(["phone-pairing-unlisted-origin"]);
  expect(plan.captures.map(c => [c.name, c.viewport, c.textSize])).toEqual([
    ["phone-pairing-unlisted-origin-phone-390.light", { width: 390, height: 844 }, 14],
    ["phone-pairing-unlisted-origin-phone-390.dark", { width: 390, height: 844 }, 14],
  ]);
});

it("measures the sign-in dialog's geometry in 1280 × 800 and 1280 × 700 windows once, beside its usual captures (ticket 1690)", () => {
  const plan = capturePlan(["dialog-restore", "dialog-sign-in"]);
  expect(plan.captures.filter(c => c.scene === "dialog-sign-in").map(c => [c.name, c.viewport, c.probes])).toEqual([
    ["dialog-sign-in.light", { width: 1400, height: 900 }, undefined],
    ["dialog-sign-in.dark", { width: 1400, height: 900 }, [{ width: 1280, height: 800 }, { width: 1280, height: 700 }]],
    ["dialog-sign-in-narrow.light", { width: 1024, height: 768 }, undefined],
    ["dialog-sign-in-narrow.dark", { width: 1024, height: 768 }, undefined],
  ]);
  expect(plan.captures.filter(c => c.scene === "dialog-restore").every(c => !("probes" in c))).toBe(true);
  expect(plan.budget.desktop).toBe(8);
});

it("retains desktop and bounded phone profiles while allowing surface-owned growth", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.budget.desktop).toBeGreaterThanOrEqual(354);
  expect(plan.budget.phone).toBeGreaterThanOrEqual(46);
  expect(plan.shards.every(shard => shard.budget.remaining >= 0)).toBe(true);
  for (const shard of plan.shards) {
    expect(shard.captures.length).toBeGreaterThan(0);
    expect(shard.budget.limit).toBe(400);
    expect(shard.captures.length).toBeLessThanOrEqual(shard.budget.limit);
  }
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(plan.captures.filter(c => c.scene.startsWith("phone-conversation-")).length).toBe(24);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(plan.budget.total);
});

it("allocates six states to each of seven phone owners while preserving desktop captures", () => {
  const scenes = [
    ...Array.from({ length: 177 }, (_, i) => `desktop-capacity-${i}`),
    ...Array.from({ length: 6 }, (_, i) => `phone-capacity-existing-${i}`),
  ];
  const existing = capturePlan(scenes);
  const leafScenes = Array.from({ length: 7 }, (_, owner) =>
    Array.from({ length: 6 }, (_, state) => `phone-leaf-${owner}-state-${state}`),
  ).flat();
  const plan = capturePlan([...scenes, ...leafScenes]);
  expect(plan.shards[0]!.captures).toEqual(existing.shards[0]!.captures);
  expect(plan.shards.map(shard => [shard.id, shard.captures.length, shard.budget.limit])).toEqual([
    ["desktop-001", 354, 400], ["phone-001", 384, 400],
  ]);
  expect(plan.shards[1]!.budget.remaining).toBe(16);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
});

it("keeps each desktop and phone report within 400 captures as either family grows", () => {
  const plan = capturePlan(Array.from({ length: 250 }, (_, i) => `settings-sample-${i}`).concat(Array.from({ length: 51 }, (_, i) => `phone-sample-${i}`)));
  expect(plan.shards.map(shard => [shard.id, shard.captures.length])).toEqual([
    ["desktop-001", 400], ["desktop-002", 100], ["phone-001", 400], ["phone-002", 8],
  ]);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(908);
});


it("discovers an added phone overlay beyond the full report and shards every capture without loss", async () => {
  const scenes = (await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname)).filter(scene => scene !== "phone-overlay-workspace");
  const existing = capturePlan(scenes);
  const plan = capturePlan([...scenes, "phone-overlay-workspace"]);
  expect(plan.captures).toHaveLength(existing.captures.length + 8);
  expect(plan.captures.filter(c => c.scene !== "phone-overlay-workspace")).toEqual(existing.captures);
  expect(plan.shards.every(shard => shard.captures.length <= 400)).toBe(true);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
});

it("allocates the frame conversation and drawer profiles without spending desktop capacity", async () => {
  const scenes = (await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname)).filter(scene => !["phone-frame-conversation", "phone-frame-drawer"].includes(scene));
  const existing = capturePlan(scenes);
  const plan = capturePlan([...scenes, "phone-frame-conversation", "phone-frame-drawer"]);
  expect(plan.captures.filter(c => c.platform === "desktop")).toEqual(existing.captures.filter(c => c.platform === "desktop"));
  expect(plan.budget.desktop).toBe(existing.budget.desktop);
  expect(plan.budget.phone).toBe(existing.budget.phone + 16);
  expect(plan.budget.total).toBe(existing.budget.total + 16);
  for (const scene of ["phone-frame-conversation", "phone-frame-drawer"]) {
    expect(plan.captures.filter(c => c.scene === scene).map(c => c.name)).toEqual([
      `${scene}-phone-390.light`, `${scene}-phone-390.dark`,
      `${scene}-phone-360.light`, `${scene}-phone-360.dark`,
      `${scene}-phone-390-text-20.light`, `${scene}-phone-390-text-20.dark`,
      `${scene}-phone-390-keyboard.light`, `${scene}-phone-390-keyboard.dark`,
    ]);
  }
});


it("adds all nine pane scenes in independently bounded reports", async () => {
  const panes = ["phone-pane-agent", "phone-pane-diff", "phone-pane-documents", "phone-pane-file", "phone-pane-files", "phone-pane-markdown", "phone-pane-preview", "phone-pane-scope", "phone-pane-tasks"];
  const scenes = (await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname)).filter(scene => !panes.includes(scene));
  const existing = capturePlan(scenes);
  const plan = capturePlan([...scenes, ...panes]);
  expect(plan.budget.desktop).toBe(existing.budget.desktop);
  expect(plan.budget.phone).toBe(existing.budget.phone + 72);
  expect(plan.budget.total).toBe(existing.budget.total + 72);
  expect(plan.captures.filter(c => !panes.includes(c.scene))).toEqual(existing.captures);
  expect(plan.shards.every(shard => shard.captures.length <= 400 && shard.budget.remaining >= 0)).toBe(true);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
});


it("requires a discovered shard before capture", () => {
  const plan = capturePlan(Array.from({ length: 51 }, (_, i) => `phone-pane-${i}`));
  expect(() => captureShard(plan, undefined)).toThrow("Invalid gallery shard selection");
  const selected = captureShard(plan, "phone-002");
  expect(selected.captures).toHaveLength(8);
  expect(selected.shard).toEqual({ id: "phone-002", index: 1, count: 2 });
  expect(() => captureShard(plan, "phone-003")).toThrow("Invalid gallery shard selection");
});

it("plans normal and small desktop and every phone profile for the long authoring question", () => {
  const plan = capturePlan(["settings-bank-authoring", "setup-authoring", "phone-bank-authoring"]);
  for (const scene of ["settings-bank-authoring", "setup-authoring"]) {
    expect(plan.captures.filter(capture => capture.scene === scene).map(capture => capture.viewport)).toEqual([
      { width: 1400, height: 900 }, { width: 1024, height: 768 },
    ]);
  }
  expect(plan.captures.filter(capture => capture.scene === "phone-bank-authoring")).toHaveLength(8);
  expect(plan.captures.some(capture => capture.scene === "phone-bank-authoring" && capture.viewport.height === 480)).toBe(true);
});

it("keeps the keyboard dock proof at layout 390x844 instead of reducing the whole window", () => {
  const plan = capturePlan(["phone-keyboard-dock"]);
  expect(plan.captures.map(capture => [capture.name, capture.viewport])).toEqual([
    ["phone-keyboard-dock-phone-390.light", { width: 390, height: 844 }],
    ["phone-keyboard-dock-phone-390.dark", { width: 390, height: 844 }],
  ]);
});
