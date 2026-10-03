import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterAll } from "vitest";
import { renderApp, type RenderedApp, type RenderOptions, type ScriptedEnvironment } from "./harness.js";

/**
 * The sidebar's tests' two environments (docs/specs/gui.md, "The window and
 * the sidebar"), and how they read the sidebar: `desk`, the local one, with
 * two groups, a running session, a pin, a snooze and a settled one; `laptop`,
 * paired, whose group merges with the desk's under one heading, with a
 * parked session, a pin and an archived one; and the sidebar as a person
 * reads it, heading by heading.
 */

export const at = (hours: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + hours * 3_600_000).toISOString();

export const DESK_ID = "0199aa00-0000-7000-8000-00000000de5c";
export const LAPTOP_ID = "0199aa00-0000-7000-8000-0000000014a7";
export const G_BRAND_DESK = "0199bb00-0000-4000-8000-00000000b0d1";
export const G_OPS = "0199bb00-0000-4000-8000-00000000b0d2";
export const G_BRAND_LAPTOP = "0199bb00-0000-4000-8000-00000000b0d3";
export const FIX = "0199aa00-0000-4000-8000-0000000000f1";
export const COPY = "0199aa00-0000-4000-8000-0000000000f2";
export const PINNED = "0199aa00-0000-4000-8000-0000000000f3";
export const LATER = "0199aa00-0000-4000-8000-0000000000f4";
export const DONE = "0199aa00-0000-4000-8000-0000000000f5";
export const SPARE = "0199aa00-0000-4000-8000-0000000000f6";
export const TRAIN = "0199aa00-0000-4000-8000-0000000000a1";
export const LBRAND = "0199aa00-0000-4000-8000-0000000000a2";
export const OLD = "0199aa00-0000-4000-8000-0000000000a3";
export const LPIN = "0199aa00-0000-4000-8000-0000000000a4";

export const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  hello: { environmentIcon: "desktop", environmentColour: "teal" },
  groups: [
    { id: G_BRAND_DESK, name: "Meadowstudios" },
    { id: G_OPS, name: "Ops" },
  ],
  sessions: [
    { id: FIX, title: "Fix the rail", tags: ["wip"], activity: { state: "running", since: at(0) }, lastActivityAt: at(0) },
    { id: SPARE, title: "Spare", createdAt: "2026-09-23T00:00:00.000Z" },
    { id: COPY, title: "Brand copy", groupId: G_BRAND_DESK },
    { id: PINNED, title: "Pinned one", pinnedAt: at(-30), pinOrderKey: "m" },
    { id: LATER, title: "Later", snoozedUntil: at(18), snoozedAt: at(-1) },
    { id: DONE, title: "Done", settledAt: at(-2), settledBy: "user", settledOverride: "settled" },
  ],
  ...extra,
});

export const laptop = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  hello: { environmentIcon: "laptop", environmentColour: "amber" },
  groups: [{ id: G_BRAND_LAPTOP, name: "meadowstudios" }],
  sessions: [
    { id: TRAIN, title: "Train tidy", parkedPromptCount: 2, activity: { state: "parked", since: at(0) } },
    { id: LBRAND, title: "Brand on laptop", groupId: G_BRAND_LAPTOP },
    { id: OLD, title: "Old thing", archivedAt: at(-40) },
    { id: LPIN, title: "Laptop pin", pinnedAt: at(-20), pinOrderKey: "t" },
  ],
  ...extra,
});

export const two = (options: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } & RenderOptions = {}) =>
  renderApp({ environments: [desk(options.desk), laptop(options.laptop)] }, options);

/**
 * Reads this file's times in UTC, whatever zone the runner is in, until its tests are done: the wake and snooze times are
 * clock times on this machine's calendar. Called once, at the top of a test file.
 */
export const inUtc = (): void => {
  const zone = process.env["TZ"];
  process.env["TZ"] = "UTC";
  afterAll(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });
};

export const sidebar = () => screen.getByRole("navigation", { name: "Sessions" });

/** One heading's region in the sidebar, by its name. */
export const region = (name: string) => within(sidebar()).getByRole("region", { name });

/**
 * The sidebar as a person reads it, top to bottom: each heading (a fold's
 * mark, its name, and its count while folded), then each row under it,
 * indented: its title, tags, wake time, activity and marker.
 */
/** Organisation assertions read row facts independently of age and account metadata. */
export const rowWords = (line: HTMLElement): string => [
  line.querySelector("[data-sidebar-title]")?.textContent,
  ...Array.from(line.querySelectorAll("[data-sidebar-tag], [data-sidebar-wake]")).map((part) => part.textContent),
  ...(line.querySelector("[data-sidebar-waiting]") ? [`${line.querySelector("[data-sidebar-waiting]")?.textContent} waiting`] : []),
  ...(line.querySelector('[aria-label="Pending"]') ? ["Pending"] : []),
].filter(Boolean).join(" ");

export const drawn = (): string[] =>
  within(sidebar()).queryAllByRole("region").flatMap((section) => {
    const heading = within(section).getAllByRole("heading")[0];
    const fold = heading?.querySelector("button[aria-expanded]");
    // These suites verify filing/folding; the look suite verifies the expanded count and chevron.
    const label = fold?.getAttribute("aria-expanded") === "true"
      ? `${fold.getAttribute("aria-label")}${heading?.textContent?.includes("pending") ? " pending" : ""}`
      : (heading?.textContent ?? "").trim();
    return [label, ...within(section).queryAllByRole("listitem").map((line) => `  ${rowWords(line)}`)];
  });

/** The row whose title is `title`: the button that opens it. */
export const row = (title: string) => within(sidebar()).getByRole("button", { name: new RegExp(`^\\S+ ${title}\\b`) });

/** The line a row is drawn on: where a session dropped takes its place. */
export const lineOf = (title: string) => row(title).closest("li") as HTMLElement;

/** A heading's own line, by its region's name: where a session dropped goes under it. */
export const heading = (name: string) => within(region(name)).getAllByRole("heading")[0] as HTMLElement;

/** A drag as the browser carries one: one data transfer from the drag's start to its end. */
export const dataTransfer = () => {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types() {
      return [...data.keys()];
    },
    dropEffect: "none",
    effectAllowed: "all",
  };
};

/** Drags `from` (a row) and drops it on `onto`; answers whether the drop was taken, as the pointer would show it. */
export const drag = (from: HTMLElement, onto: HTMLElement): boolean => {
  const carried = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: carried });
  fireEvent.dragEnter(onto, { dataTransfer: carried });
  const taken = !fireEvent.dragOver(onto, { dataTransfer: carried });
  fireEvent.drop(onto, { dataTransfer: carried });
  fireEvent.dragEnd(from, { dataTransfer: carried });
  return taken;
};

/** Keys typed into a field, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
export const typeIn = async (app: RenderedApp, field: HTMLElement, keys: string) => {
  act(() => field.focus());
  await app.user.keyboard(keys);
};

/** Waits for both environments' sessions to be drawn. */
export const settled = async (app: RenderedApp, title = "Train tidy") => {
  await within(sidebar()).findByRole("button", { name: new RegExp(title) });
  return app;
};
