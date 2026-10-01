import { stripVTControlCharacters } from "node:util";
import { DEFAULT_THEME, type EnvironmentColour, type SessionDiffFile, type Theme } from "@agent-harness/contracts";
import { derive, toHex, type LadderName } from "@agent-harness/theme";
import { afterEach, describe, expect, it, vi } from "vitest";

// Colour is on for this file only: chalk reads FORCE_COLOR as it loads, which the hoisting puts before every import.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The terminal UI's colours from the theme package (#392; ADR 0023): every
 * colour is a role or an environment colour on the terminal's own sixteen,
 * and where the terminal draws truecolour (`COLORTERM` is `truecolor` or
 * `24bit`), the home environment's theme reaches it in two places only: an
 * environment's badge and name in its colour token's value, and a diff's
 * added and removed lines on the backgrounds the theme derives from Canvas,
 * both from the ladder for the terminal's ground (dark unless it says
 * light). Frames carry no colour where the test runner's output is no
 * terminal, so this file forces chalk's full colour level and reads the
 * escapes a terminal would get.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const DIFF: SessionDiffFile = {
  path: "src/app.ts",
  diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n kept line\n-export const app = 0;\n+export const app = 1;\n",
  changes: [{ runId: "0199bb00-0000-4000-8000-000000000001", toolCallId: "t1", tool: "Edit", status: "ok" }],
};

/** The theme's token for an environment colour, or a diff band, in a ladder, as `#rrggbb`. */
const token = (colour: EnvironmentColour, theme: Theme = DEFAULT_THEME, ladder: LadderName = "dark") => toHex(derive(theme)[ladder].environment[colour]);
const band = (which: "added" | "removed", theme: Theme = DEFAULT_THEME, ladder: LadderName = "dark") => toHex(derive(theme)[ladder].diff[which]);

/** The escapes a truecolour foreground and background open with. */
const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(";");
const fg = (hex: string) => `\u001B[38;2;${rgb(hex)}m`;
const bg = (hex: string) => `\u001B[48;2;${rgb(hex)}m`;
const END = "\u001B[39m";
/** Every truecolour escape in a frame, foreground and background. */
// eslint-disable-next-line no-control-regex -- the escapes are what is being read.
const truecolourIn = (frame: string) => frame.match(/\u001B\[[34]8;2;[\d;]+m/g) ?? [];

/** A theme with the canvas tinted and the statuses moved, so a diff's backgrounds differ from the preset's. */
const SLATE: Theme = {
  name: "Slate",
  seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250, chroma: 0.03 }, success: { hue: 170, chroma: 0.17 }, danger: { hue: 10, chroma: 0.18 } },
};

const plain = (app: RenderedApp) => stripVTControlCharacters(app.frame());

const launch = async (
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly ground?: LadderName;
    readonly desk?: Partial<ScriptedEnvironment>;
    readonly laptop?: Partial<ScriptedEnvironment>;
  } = {},
) => {
  const app = await renderApp({
    script: {
      environments: [
        { name: "desk", reach: "local", colour: "amber", sessions: [{ id: SESSION, title: "Fix the rail" }], sessionDiff: { files: [DIFF] }, ...options.desk },
        { name: "laptop", reach: "paired", colour: "teal", sessions: [{ title: "Train tidy" }], ...options.laptop },
      ],
    },
    flags: { session: SESSION },
    ...(options.env && { env: options.env }),
    ...(options.ground && { ground: options.ground }),
  });
  apps.push(app);
  await app.waitUntil(() => plain(app).includes("DE · Fix the rail") && plain(app).includes("LA · Train tidy") && plain(app).includes("Nothing said yet."), "both rows on the rail and desk's session open");
  return app;
};

/** The open session's `/diff`. */
const openDiff = async (app: RenderedApp) => {
  await app.type("/diff");
  await app.press(KEY.enter);
  await app.waitFor("What this session changed");
};

const rowWith = (app: RenderedApp, text: string) => app.frame().split("\n").find((row) => stripVTControlCharacters(row).includes(text)) ?? "";

describe("without truecolour", () => {
  it.each([{}, { COLORTERM: "256" }, { COLORTERM: "" }])("draws the badge in its terminal colour and the diff with no background (%o)", async (env) => {
    const app = await launch({ env });
    expect(app.frame()).toContain(`\u001B[33mDE${END}`);
    expect(app.frame()).toContain(`\u001B[36mLA${END}`);
    await openDiff(app);
    expect(rowWith(app, "+export const app = 1;")).toContain("\u001B[32m+export const app = 1;");
    expect(truecolourIn(app.frame())).toEqual([]);
    // Without truecolour the theme is never drawn, so it is never read.
    expect(app.environment("desk").requests("settings.get").filter((r) => JSON.stringify(r.params).includes("appearance.theme"))).toEqual([]);
  });
});

describe("under truecolour", () => {
  it.each(["truecolor", "24bit"])("draws a badge and its name in its colour token's value from the dark ladder, COLORTERM=%s", async (colorterm) => {
    const app = await launch({ env: { COLORTERM: colorterm } });
    await app.waitFor(`${fg(token("amber"))}DE${END}`);
    expect(app.frame()).toContain(`${fg(token("teal"))}LA${END}`);
    // The status line's letters and name, and the header's name, in the same token.
    expect(app.frame()).toContain(`${fg(token("amber"))}DE desk${END}`);
    expect(app.frame().split("\n")[0]).toContain(`${fg(token("amber"))}desk`);
  });

  it("draws a diff's added and removed lines on the theme's backgrounds, and nothing else in truecolour", async () => {
    const app = await launch({ env: { COLORTERM: "truecolor" } });
    await app.waitFor(`${fg(token("amber"))}DE${END}`);
    await openDiff(app);
    expect(rowWith(app, "+export const app = 1;")).toContain(bg(band("added")));
    expect(rowWith(app, "-export const app = 0;")).toContain(bg(band("removed")));
    // Across the pager's width, past the line's text.
    expect(rowWith(app, "+export const app = 1;").endsWith(" \u001B[49m")).toBe(true);
    // The line's own colour is kept on the band, the sixteen's green.
    expect(rowWith(app, "+export const app = 1;")).toContain("\u001B[32m+export const app = 1;");
    expect(rowWith(app, " kept line")).not.toContain("\u001B[48;2;");
    expect(rowWith(app, "@@ -1,2 +1,2 @@")).not.toContain("\u001B[48;2;");
    const allowed = new Set([fg(token("amber")), fg(token("teal")), bg(band("added")), bg(band("removed"))]);
    expect(truecolourIn(app.frame()).filter((escape) => !allowed.has(escape))).toEqual([]);
    await app.press(KEY.esc);
    await app.waitUntil(() => !plain(app).includes("What this session changed"), "the diff closed");
    expect(truecolourIn(app.frame()).filter((escape) => !allowed.has(escape))).toEqual([]);
  });

  it("draws the light ladder on a light ground", async () => {
    const app = await launch({ env: { COLORTERM: "truecolor" }, ground: "light" });
    await app.waitFor(`${fg(token("amber", DEFAULT_THEME, "light"))}DE${END}`);
    await openDiff(app);
    expect(rowWith(app, "+export const app = 1;")).toContain(bg(band("added", DEFAULT_THEME, "light")));
  });

  it("takes the ground from AGENT_HARNESS_TUI_BACKGROUND over what the terminal answered", async () => {
    const app = await launch({ env: { COLORTERM: "truecolor", AGENT_HARNESS_TUI_BACKGROUND: "dark" }, ground: "light" });
    await app.waitFor(`${fg(token("amber"))}DE${END}`);
  });
});

describe("the theme drawn under truecolour", () => {
  const themeReads = (app: RenderedApp, name: string) =>
    app
      .environment(name)
      .requests("settings.get")
      .filter((request) => JSON.stringify(request.params).includes("appearance.theme"));

  it("is the local environment's, read through settings.get, with another environment paired", async () => {
    const app = await launch({ env: { COLORTERM: "truecolor" }, desk: { settings: { "appearance.theme": SLATE } } });
    await openDiff(app);
    await app.waitFor(bg(band("added", SLATE)));
    expect(rowWith(app, "-export const app = 0;")).toContain(bg(band("removed", SLATE)));
    expect(themeReads(app, "desk").map((request) => request.params)).toEqual([{ keys: ["appearance.theme"] }]);
    expect(themeReads(app, "laptop")).toEqual([]);
  });

  it("is the primary environment's where this machine runs none", async () => {
    const app = await renderApp({
      script: {
        environments: [
          { name: "laptop", reach: "paired", colour: "teal", settings: { "appearance.theme": SLATE }, sessions: [{ id: SESSION, title: "Train tidy" }], sessionDiff: { files: [DIFF] } },
        ],
      },
      env: { COLORTERM: "truecolor" },
      flags: { session: SESSION },
    });
    apps.push(app);
    await app.waitFor("Nothing said yet.");
    await app.type("/diff");
    await app.press(KEY.enter);
    await app.waitFor("What this session changed");
    await app.waitFor(bg(band("added", SLATE)));
    expect(themeReads(app, "laptop")).toHaveLength(1);
  });

  it("is drawn again when another client sets it, on settings.changed, within one read", async () => {
    const app = await launch({ env: { COLORTERM: "truecolor" } });
    await openDiff(app);
    await app.waitFor(bg(band("added")));
    const reads = themeReads(app, "desk").length;
    app.environment("desk").setSettings({ "appearance.theme": SLATE });
    await app.waitFor(bg(band("added", SLATE)));
    expect(rowWith(app, "-export const app = 0;")).toContain(bg(band("removed", SLATE)));
    expect(app.frame()).not.toContain(bg(band("added")));
    expect(themeReads(app, "desk")).toHaveLength(reads + 1);
    await app.press(KEY.esc);
    await app.waitUntil(() => !plain(app).includes("What this session changed"), "the diff closed");
    // The badges are drawn in the new theme's tokens, which the derivation keeps where the grounds let it.
    expect(app.frame()).toContain(`${fg(token("amber", SLATE))}DE${END}`);
  });
});
