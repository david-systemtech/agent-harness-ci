import { useToastTimers } from "../test/toast-timers.js";
import { chooseHeaderAction, openHeaderMenu } from "../test/header-actions.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp } from "../test/harness.js";
import { LAPTOP_ID, TRAIN, inUtc, row, settled, sidebar, two } from "../test/sidebar-fixtures.js";

useToastTimers();

/**
 * The pane grid (docs/specs/gui.md, "The seven panes and the grid" and "A
 * session pane"; story 5; #407), through the harness over two scripted
 * environments: rows of up to eight session panes, split right or down from
 * the focused one by the header's actions and their keys, resized by their
 * dividers down to a pixel floor, closed from the caption only, one pane per
 * session; a session dragged from the sidebar onto a pane's centre or edge,
 * and the context menu's Open in a new pane; the refusal at eight panes; the
 * caption; and the layout kept by presentation across a remount.
 */

inUtc();

/** The grid's panes in its rows, each region named "Session pane". */
const panes = () => within(screen.getByRole("main")).getAllByRole("region", { name: "Session pane" });

/** A pane's caption title, "·" for a pane with no session. */
const titleOf = (pane: HTMLElement) => pane.querySelector('button[aria-label^="Rename "]')?.textContent ?? "·";

/** The grid as a person reads it: each row's panes left to right, by title, the focused one starred. */
const grid = () =>
  within(screen.getByRole("main"))
    .getAllByRole("group", { name: /^Row \d+$/ })
    .map((line) => within(line).getAllByRole("region", { name: "Session pane" }).map((pane) => `${pane.getAttribute("aria-current") === "true" ? "*" : ""}${titleOf(pane)}`));

/** The pane showing `title`. */
const paneOf = (title: string) => panes().find((pane) => titleOf(pane) === title) as HTMLElement;

/** The header's words. */
const header = () => screen.getByRole("banner");

/** What the grid's line in the header says. */
const gridLine = () => screen.queryAllByText("The grid holds eight panes; close one first.").find((node) => node.closest("[data-sonner-toast]") !== null)?.closest("[data-sonner-toast]")?.querySelector("[data-title]")?.textContent;

/** Presses a key chord with the focus where it is. */
const press = (app: RenderedApp, keys: string) => app.user.keyboard(keys);
const SPLIT_RIGHT = "{Control>}\\{/Control}";
const SPLIT_DOWN = "{Control>}{Shift>}[Backslash]{/Shift}{/Control}";

/** Focuses a pane as a person does, by putting the focus in it. */
const focusIn = (pane: HTMLElement) => act(() => (within(pane).queryByRole("textbox", { name: "Message" }) ?? pane.querySelector("button") ?? pane).focus());

/** A drag as the browser carries one: one data transfer from the drag's start to its end. */
const dataTransfer = () => {
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

/**
 * Drags the sidebar's row `title` onto the target `zone` over `pane` ("Open here", "Open to the right", "Open below"),
 * which a pane grows while a session is dragged, and drops it; answers whether the drop was taken, as the pointer shows it.
 */
const dropOn = (title: string, pane: () => HTMLElement, zone: string): boolean => {
  const from = row(title);
  const carried = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: carried });
  const onto = within(pane().closest("[data-panel]") as HTMLElement).getByLabelText(zone);
  fireEvent.dragEnter(onto, { dataTransfer: carried });
  const taken = !fireEvent.dragOver(onto, { dataTransfer: carried });
  fireEvent.drop(onto, { dataTransfer: carried });
  fireEvent.dragEnd(from, { dataTransfer: carried });
  return taken;
};

/** The two environments with laptop's "Train tidy" open in the one pane. */
const withTrain = async () => {
  const app = await settled(await two());
  await app.user.click(row("Train tidy"));
  await within(paneOf("Train tidy")).findByRole("region", { name: "Transcript" });
  return app;
};

describe("splitting", () => {
  it("adds a pane beside the focused one from the header's actions and their keys, right in its row and down across the grid, each focused and empty; the header follows the focused pane", async () => {
    const app = await withTrain();
    expect(grid()).toEqual([["*Train tidy"]]);
    expect(within(header()).getByText("laptop")).toBeDefined();

    await chooseHeaderAction(app, "Split right");
    expect(grid()).toEqual([["Train tidy", "*·"]]);
    expect(within(header()).queryByText("laptop")).toBeNull();
    expect(within(paneOf("·")).getByText("No session is open. Choose one from the sidebar.")).toBeDefined();

    // The sidebar opens a session in the focused pane: the new one.
    await app.user.click(row("Fix the rail"));
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Fix the rail"]]));
    expect(within(header()).getByText("desk")).toBeDefined();

    await press(app, SPLIT_DOWN);
    expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["*·"]]);
    await press(app, SPLIT_RIGHT);
    expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["·", "*·"]]);
    await chooseHeaderAction(app, "Split down");
    expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["·", "·"], ["*·"]]);

    // The focus put in a pane focuses it, and the header follows it.
    focusIn(paneOf("Train tidy"));
    expect(grid()).toEqual([["*Train tidy", "Fix the rail"], ["·", "·"], ["·"]]);
    expect(within(header()).getByText("laptop")).toBeDefined();
  });

  it("leaves the window's keys to the focused pane alone", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    await app.user.click(row("Fix the rail"));
    await within(paneOf("Fix the rail")).findByRole("region", { name: "Transcript" });

    await press(app, "{Control>}f{/Control}");
    expect(within(paneOf("Fix the rail")).getByRole("search", { name: "Find in the conversation" })).toBeDefined();
    expect(within(paneOf("Train tidy")).queryByRole("search")).toBeNull();
    await press(app, "{Escape}");

    // The pane opened first, focused again, answers them in place of the one opened after it.
    focusIn(paneOf("Train tidy"));
    await press(app, "{Control>}f{/Control}");
    expect(within(paneOf("Train tidy")).getByRole("search", { name: "Find in the conversation" })).toBeDefined();
    expect(within(paneOf("Fix the rail")).queryByRole("search")).toBeNull();
  });
});

describe("eight panes", () => {
  it("are the most the grid holds: a split, its keys, a drop on an edge and Open in a new pane are refused with the reason; a drop on a centre still opens", async () => {
    const app = await withTrain();
    for (let split = 1; split < 8; split += 1) await press(app, split % 2 === 0 ? SPLIT_DOWN : SPLIT_RIGHT);
    expect(panes()).toHaveLength(8);
    expect(gridLine()).toBeUndefined();

    const more = await openHeaderMenu(app);
    const split = within(more).getByRole("menuitem", { name: "Split right" });
    expect(split.getAttribute("aria-disabled")).toBe("true");
    expect(split.textContent).toContain("The grid holds eight panes; close one first.");
    await app.user.keyboard("{Escape}");
    await press(app, SPLIT_DOWN);
    expect(panes()).toHaveLength(8);

    expect(dropOn("Fix the rail", () => paneOf("Train tidy"), "Open to the right")).toBe(false);
    expect(dropOn("Fix the rail", () => paneOf("Train tidy"), "Open below")).toBe(false);
    expect(panes()).toHaveLength(8);
    expect(gridLine()).toBe("The grid holds eight panes; close one first.");

    await app.user.pointer({ keys: "[MouseRight]", target: row("Fix the rail") });
    const menu = await screen.findByRole("menu", { name: "Organise “Fix the rail”" });
    const item = within(menu).getByRole("menuitem", { name: /^Open in a new pane/ });
    expect(item.textContent).toBe("Open in a new paneOThe grid holds eight panes; close one first.");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await app.user.keyboard("{Escape}");

    // Opening in a pane adds none: it is not refused.
    expect(dropOn("Fix the rail", () => panes()[7] as HTMLElement, "Open here")).toBe(true);
    await waitFor(() => expect(grid().flat()).toContain("*Fix the rail"));
    expect(panes()).toHaveLength(8);

    // One closed, a pane can be added again.
    await app.user.click(within(paneOf("Fix the rail")).getByRole("button", { name: "Close the pane" }));
    await press(app, SPLIT_RIGHT);
    expect(panes()).toHaveLength(8);
    await waitFor(() => expect(gridLine()).toBeUndefined());
  });
});

describe("a session dragged onto the grid", () => {
  it("opens in the pane dropped on at its centre, splits the pane at its edge and opens in the new one, and one shown already is focused where it is", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    expect(grid()).toEqual([["Train tidy", "*·"]]);

    expect(dropOn("Fix the rail", () => paneOf("·"), "Open here")).toBe(true);
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Fix the rail"]]));

    expect(dropOn("Brand copy", () => paneOf("Train tidy"), "Open below")).toBe(true);
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["*Brand copy"]]));

    expect(dropOn("Spare", () => paneOf("Train tidy"), "Open to the right")).toBe(true);
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Spare", "Fix the rail"], ["Brand copy"]]));

    // A session shows in one pane at a time.
    expect(dropOn("Train tidy", () => paneOf("Brand copy"), "Open here")).toBe(true);
    await waitFor(() => expect(grid()).toEqual([["*Train tidy", "Spare", "Fix the rail"], ["Brand copy"]]));
    expect(dropOn("Fix the rail", () => paneOf("Brand copy"), "Open to the right")).toBe(true);
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "Spare", "*Fix the rail"], ["Brand copy"]]));
    await app.user.click(row("Spare"));
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Spare", "Fix the rail"], ["Brand copy"]]));
    // Nothing covers the panes once the drag is over.
    expect(screen.queryByLabelText("Open here")).toBeNull();
  });
});

describe("a pane dragged by its caption", () => {
  it("keeps unsent attachments and surviving pane mounts through splits, closes, swaps and moves between rows", async () => {
    const app = await withTrain();
    const original = paneOf("Train tidy");
    const message = within(original).getByRole("textbox", { name: "Message" });
    fireEvent.drop(message, { dataTransfer: { types: ["Files"], files: [new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "ledger.png", { type: "image/png" })] } });
    await within(original).findByRole("button", { name: "Remove ledger.png" });
    const retained = () => {
      expect(paneOf("Train tidy")).toBe(original);
      expect(within(original).getByRole("textbox", { name: "Message" })).toBe(message);
      expect(within(original).getByRole("button", { name: "Remove ledger.png" })).toBeDefined();
    };
    await press(app, SPLIT_RIGHT);
    retained();
    await app.user.click(within(paneOf("·")).getByRole("button", { name: "Close the pane" }));
    retained();
    await press(app, SPLIT_DOWN);
    retained();
    await app.user.click(within(paneOf("·")).getByRole("button", { name: "Close the pane" }));
    retained();
    await press(app, SPLIT_RIGHT);
    await app.user.click(row("Fix the rail"));
    const neighbour = paneOf("Fix the rail");
    const drag = (label: string) => {
      const caption = original.querySelector("[data-pane-caption]") as HTMLElement;
      const carried = dataTransfer();
      fireEvent.dragStart(caption, { dataTransfer: carried });
      const target = within(neighbour.closest("[data-panel]") as HTMLElement).getByLabelText(label);
      fireEvent.drop(target, { dataTransfer: carried });
      fireEvent.dragEnd(caption, { dataTransfer: carried });
      retained();
      expect(paneOf("Fix the rail")).toBe(neighbour);
    };
    drag("Swap panes");
    drag("Move below");
    drag("Move to the right");
    await app.user.click(within(neighbour).getByRole("button", { name: "Close the pane" }));
    retained();
  });

  it("does not start a pane drag from its controls or from text selection in the rename field", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    const pane = paneOf("Train tidy");
    const caption = pane.querySelector("[data-pane-caption]") as HTMLElement;
    const carry = dataTransfer();
    fireEvent.pointerDown(within(pane).getByRole("button", { name: "Close the pane" }));
    // Native dragstart names the draggable caption, even when its child was pressed.
    expect(fireEvent.dragStart(caption, { dataTransfer: carry })).toBe(false);
    expect(screen.queryByLabelText("Swap panes")).toBeNull();
    await app.user.click(within(pane).getByRole("button", { name: "Rename “Train tidy”" }));
    fireEvent.pointerDown(within(pane).getByRole("textbox", { name: "Rename “Train tidy”" }));
    expect(fireEvent.dragStart(caption, { dataTransfer: carry })).toBe(false);
    expect(screen.queryByLabelText("Swap panes")).toBeNull();
    fireEvent.pointerDown(caption);
    expect(fireEvent.dragStart(caption, { dataTransfer: carry })).toBe(true);
    // A drop back onto the source pane must not paste a pane id into its composer.
    expect(carry.types).not.toContain("text/plain");
    expect(screen.getByLabelText("Swap panes")).toBeDefined();
    fireEvent.dragEnd(caption, { dataTransfer: carry });
  });

  it("swaps whole panes at the centre, moves one below another, and keeps the arrangement after a remount", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    await app.user.click(row("Fix the rail"));
    const drag = (title: string, onto: string, label: string) => {
      const from = paneOf(title).querySelector("[data-pane-caption]") as HTMLElement;
      const carried = dataTransfer();
      fireEvent.dragStart(from, { dataTransfer: carried });
      const target = within(paneOf(onto).closest("[data-panel]") as HTMLElement).getByLabelText(label);
      expect(fireEvent.dragOver(target, { dataTransfer: carried })).toBe(false);
      fireEvent.drop(target, { dataTransfer: carried });
      fireEvent.dragEnd(from, { dataTransfer: carried });
    };
    drag("Train tidy", "Fix the rail", "Swap panes");
    expect(grid()).toEqual([["Fix the rail", "*Train tidy"]]);
    drag("Train tidy", "Fix the rail", "Move below");
    expect(grid()).toEqual([["Fix the rail"], ["*Train tidy"]]);
    await settled(await app.remount());
    expect(grid()).toEqual([["Fix the rail"], ["*Train tidy"]]);
    expect(app.environment("laptop").requests("runs.interrupt")).toEqual([]);
    expect(screen.queryByLabelText("Swap panes")).toBeNull();
  });
});

describe("Open in a new pane", () => {
  it("splits the focused pane right and opens the session there", async () => {
    const app = await withTrain();
    await press(app, SPLIT_DOWN);
    focusIn(paneOf("Train tidy"));

    await app.user.pointer({ keys: "[MouseRight]", target: row("Fix the rail") });
    const menu = await screen.findByRole("menu", { name: "Organise “Fix the rail”" });
    act(() => within(menu).getByRole("menuitem", { name: "Open in a new pane" }).focus());
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Fix the rail"], ["·"]]));
  });
});

describe("closing a pane", () => {
  /** What each divider between the panes says: the share of the row the pane before it holds, in percent. */
  const dividers = () =>
    within(screen.getByRole("main"))
      .queryAllByRole("separator", { name: "Resize the panes" })
      .map((divider) => Number(divider.getAttribute("aria-valuenow")));

  it("is done from its caption, its space going to its neighbour, a row with its last pane; the grid keeps one pane", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    await press(app, SPLIT_RIGHT);
    await app.user.click(row("Fix the rail"));
    // The pane split twice holds a half, then two quarters.
    await waitFor(() => expect(dividers()).toEqual([50, 25]));
    expect(grid()).toEqual([["Train tidy", "·", "*Fix the rail"]]);

    // The middle pane goes: the one before it takes its quarter.
    await app.user.click(within(paneOf("·")).getByRole("button", { name: "Close the pane" }));
    expect(grid()).toEqual([["Train tidy", "*Fix the rail"]]);
    await waitFor(() => expect(dividers()).toEqual([75]));

    await press(app, SPLIT_DOWN);
    expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["*·"]]);
    await app.user.click(within(paneOf("·")).getByRole("button", { name: "Close the pane" }));
    // The focused pane closed, the focus goes to the pane that took its space.
    expect(grid()).toEqual([["*Train tidy", "Fix the rail"]]);
    expect(within(screen.getByRole("main")).queryAllByRole("separator", { name: "Resize the rows" })).toEqual([]);

    await app.user.click(within(paneOf("Train tidy")).getByRole("button", { name: "Close the pane" }));
    expect(grid()).toEqual([["*Fix the rail"]]);
    // The last pane has no close: the grid keeps one.
    expect(within(paneOf("Fix the rail")).queryByRole("button", { name: "Close the pane" })).toBeNull();
    // Closing a pane leaves its session as it was, in the sidebar.
    expect(row("Train tidy")).toBeDefined();
  });

  it("gives its space to its neighbour when the panes left are ones the row held before, with its dividers moved since", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    await waitFor(() => expect(dividers()).toEqual([50]));
    await press(app, SPLIT_RIGHT);
    await waitFor(() => expect(dividers()).toEqual([50, 25]));
    const first = within(screen.getByRole("main")).getAllByRole("separator", { name: "Resize the panes" })[0] as HTMLElement;
    act(() => first.focus());
    await app.user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(dividers()).toEqual([45, 30]));

    // The last pane goes: the one before it takes its quarter, not the half the row's two panes last held.
    await app.user.click(within(panes()[2] as HTMLElement).getByRole("button", { name: "Close the pane" }));
    await waitFor(() => expect(dividers()).toEqual([45]));
  });

  it("is done from its caption while it waits on this machine's environment, before any environment is ready", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", discovery: "nothing" }] });
    expect(await within(screen.getByRole("main")).findByRole("region", { name: "This machine" })).toBeDefined();
    expect(within(screen.getByRole("main")).queryByRole("button", { name: "Close the pane" })).toBeNull();

    await press(app, SPLIT_RIGHT);
    expect(within(screen.getByRole("main")).getAllByRole("region", { name: "This machine" })).toHaveLength(2);
    const closes = within(screen.getByRole("main")).getAllByRole("button", { name: "Close the pane" });
    expect(closes).toHaveLength(2);
    await app.user.click(closes[1] as HTMLElement);
    expect(panes()).toHaveLength(1);
    expect(within(screen.getByRole("main")).queryByRole("button", { name: "Close the pane" })).toBeNull();
  });
});

describe("the dividers", () => {
  it("resize the panes and the rows down to a pixel floor, and the layout comes back as it was left, each pane's session with it, when the window opens again", async () => {
    const app = await withTrain();
    await press(app, SPLIT_RIGHT);
    await app.user.click(row("Fix the rail"));
    await press(app, SPLIT_DOWN);
    const main = () => within(screen.getByRole("main"));

    // jsdom measures every element as a 1280 by 800 window, so a group of two measures twice that: a pane's floor, 360
    // pixels, is 14.0625% of a row of two (2560 pixels), and a row's, 220, is 13.75% of two rows (1600).
    const panesDivider = main().getByRole("separator", { name: "Resize the panes" });
    act(() => panesDivider.focus());
    await app.user.keyboard("{Home}");
    await waitFor(() => expect(Number(panesDivider.getAttribute("aria-valuenow"))).toBe(14.063));
    await app.user.keyboard("{ArrowRight}");
    await waitFor(() => expect(Number(panesDivider.getAttribute("aria-valuenow"))).toBe(19.063));
    const rowsDivider = main().getByRole("separator", { name: "Resize the rows" });
    act(() => rowsDivider.focus());
    await app.user.keyboard("{End}");
    await waitFor(() => expect(Number(rowsDivider.getAttribute("aria-valuenow"))).toBe(86.25));

    await settled(await app.remount());
    expect(grid()).toEqual([["Train tidy", "Fix the rail"], ["*·"]]);
    await waitFor(() => expect(Number(main().getByRole("separator", { name: "Resize the panes" }).getAttribute("aria-valuenow"))).toBe(19.063));
    expect(Number(main().getByRole("separator", { name: "Resize the rows" }).getAttribute("aria-valuenow"))).toBe(86.25);
    expect(await within(paneOf("Train tidy")).findByRole("region", { name: "Transcript" })).toBeDefined();
  });
});

describe("the caption", () => {
  it("shows the session's badge, its title renamed in place, run info, and close while the grid holds another pane", async () => {
    const app = await withTrain();
    expect(within(panes()[0] as HTMLElement).queryByRole("button", { name: "Run info" })).toBeNull();
    await press(app, SPLIT_RIGHT);
    focusIn(paneOf("Train tidy"));
    const pane = paneOf("Train tidy");
    // The caption's badge, named for the environment laptop, then the status line's, named for its icon, laptop too.
    expect(within(pane).getAllByRole("img", { name: "laptop" }).map((badge) => badge.style.color)).toEqual(["var(--environment-amber)", "var(--environment-amber)"]);
    expect(within(pane).getByRole("button", { name: "Close the pane" })).toBeDefined();

    await app.user.click(within(pane).getByRole("button", { name: "Run info" }));
    expect(await screen.findByText("No run yet: the session's first message starts one.")).toBeDefined();
    await app.user.keyboard("{Escape}");

    await app.user.click(within(pane).getByRole("button", { name: "Rename “Train tidy”" }));
    // The field takes the focus with the title selected, so what is typed replaces it.
    expect(document.activeElement).toBe(within(pane).getByRole("textbox", { name: "Rename “Train tidy”" }));
    await app.user.keyboard("Train tidier{Enter}");
    await waitFor(() => expect(app.environment("laptop").requests("sessions.rename").map((frame) => frame.params)).toEqual([expect.objectContaining({ sessionId: TRAIN, title: "Train tidier" })]));
    await waitFor(() => expect(grid()).toEqual([["*Train tidier", "·"]]));
    expect(within(sidebar()).getByRole("button", { name: /Train tidier/ })).toBeDefined();
    expect(app.shown()).toEqual({ environmentId: LAPTOP_ID, sessionId: TRAIN });

    await press(app, SPLIT_RIGHT);
    expect(within(paneOf("Train tidier")).getByRole("button", { name: "Close the pane" })).toBeDefined();
  });
});
