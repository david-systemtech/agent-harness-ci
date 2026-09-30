import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Colour is on for this file only: chalk reads FORCE_COLOR as it loads, which the hoisting puts before every import.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * The environment's colour in the terminal UI (#327; workspace-picker spec,
 * "Name, icon and colour" and "Sidebar and header"): a row's badge is its
 * environment's two letters in the environment's colour, the twelve names
 * mapped onto the terminal's own colours; one that sends no colour keeps a
 * colour by its place in the list; the status line and the header draw the
 * name in it; and no icon is drawn. Frames carry no colour where the test
 * runner's output is no terminal, so this file forces chalk's full colour
 * level and reads the escapes a terminal would get.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

/** The foreground escapes Ink writes for the colours these tests draw, and the one that ends a colour. */
const FG = { yellow: "\u001B[33m", magenta: "\u001B[35m", cyan: "\u001B[36m", redBright: "\u001B[91m", blueBright: "\u001B[94m", magentaBright: "\u001B[95m" } as const;
const END = "\u001B[39m";
const painted = (colour: keyof typeof FG, text: string) => `${FG[colour]}${text}${END}`;

/** The frame as a person reads it, the escapes left out. */
const plain = (app: RenderedApp) => stripVTControlCharacters(app.frame());

const launch = async (desk: { readonly colour?: "amber" | "pink" } = { colour: "amber" }) => {
  const app = await renderApp({
    script: {
      environments: [
        { name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }], ...desk },
        { name: "laptop", reach: "paired", sessions: [{ title: "Train tidy" }] },
      ],
    },
  });
  apps.push(app);
  await app.waitUntil(() => plain(app).includes("DE · Fix the rail") && plain(app).includes("LA · Train tidy"), "both rows on the rail");
  return app;
};

describe("the environment's colour", () => {
  it("draws a row's badge as its environment's two letters in its colour, one that sends none in a colour by its place, and no icon", async () => {
    const app = await launch();
    // desk is amber, drawn yellow; laptop sends no colour and is second in the list, so magenta, as built.
    expect(app.frame()).toContain(painted("yellow", "DE"));
    expect(app.frame()).toContain(painted("magenta", "LA"));
    expect(plain(app)).not.toMatch(/●(DE|LA)/);
  });

  it("draws the name in its colour on the status line and in the header", async () => {
    const app = await launch({ colour: "pink" });
    const rows = app.frame().split("\n");
    // The status line: the badge's letters and the name, in bright magenta (pink).
    expect(rows.at(-3)).toContain(painted("magentaBright", "DE desk"));
    // The header: the phase dot as it was, then the name in its colour, the state after it in the phase's.
    expect(rows[0]).toContain(`${FG.magentaBright}desk`);
    expect(plain(app).split("\n")[0]).toContain("● desk ready");
  });

  it("redraws the badges, the status line and the header in a colour another client sets, without a notice", async () => {
    const app = await launch();
    const notices = app.runtime().projections.notices.read().length;
    app.environment("desk").setLook({ colour: "indigo" });
    await app.waitFor(painted("blueBright", "DE"));
    const rows = app.frame().split("\n");
    expect(rows.at(-3)).toContain(painted("blueBright", "DE desk"));
    expect(rows[0]).toContain(`${FG.blueBright}desk`);
    expect(app.frame()).not.toContain(painted("yellow", "DE"));
    expect(app.runtime().projections.notices.read()).toHaveLength(notices);
  });

  it("offers the twelve colours bare, each row in its own, and sets the one chosen", async () => {
    const app = await launch();
    await app.type("/environment colour");
    await app.press(KEY.enter);
    await app.waitUntil(() => plain(app).includes("Colour for desk"), "the colour picker");
    for (const [colour, name] of [
      ["redBright", "orange"],
      ["magentaBright", "pink"],
      ["cyan", "teal"],
    ] as const)
      expect(app.frame()).toContain(painted(colour, name));
    // The cursor starts on the environment's colour (amber); two down is lime, drawn bright green.
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitUntil(() => plain(app).includes("desk's colour is now lime."), "the colour set");
    expect(app.environment("desk").requests("environment.setColour")).toMatchObject([{ params: { colour: "lime" } }]);
    await app.waitFor(`\u001B[92mDE${END}`);
  });
});
