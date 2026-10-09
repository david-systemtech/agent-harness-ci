import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Menu, MenuCheckboxItem, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./menu.js";
import { DialogsScene, geometry as dialogsGeometry } from "../../gallery/scenes/dialogs.js";
import { MenusScene, geometry as menusGeometry } from "../../gallery/scenes/menus.js";
import { Toaster, toast } from "./toaster.js";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command.js";
import { SelectMenu, SelectMenuContent, SelectMenuItem, SelectMenuTrigger, SelectMenuValue } from "./select-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Tooltip, TooltipProvider } from "./tooltip.js";
import { describe, expect, it, vi } from "vitest";
import { useToastTimers } from "../../test/toast-timers.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogTrigger, Dialog, DialogContent, DialogTrigger } from "./dialog.js";

describe("window overlays", () => {
  it("names a dialog, describes it and closes back to its opener", async () => {
    const user = userEvent.setup();
    render(<Dialog><DialogTrigger>Open details</DialogTrigger><DialogContent title="Session details" description="Choose what to keep."><input aria-label="Name" /></DialogContent></Dialog>);
    const opener = screen.getByRole("button", { name: "Open details" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Session details", description: "Choose what to keep." });
    await user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it("requires an explicit confirmation and starts focus on cancellation", async () => {
    const user = userEvent.setup();
    const accept = vi.fn();
    render(<AlertDialog><AlertDialogTrigger>Delete session</AlertDialogTrigger><AlertDialogContent title="Delete this session?" description="You can restore it for thirty days."><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={accept}>Delete it</AlertDialogAction></AlertDialogContent></AlertDialog>);
    await user.click(screen.getByRole("button", { name: "Delete session" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this session?", description: "You can restore it for thirty days." });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(accept).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete it" }));
    expect(accept).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers named check and radio menu choices and skips disabled items", async () => {
    const user = userEvent.setup();
    const checked = vi.fn();
    const chosen = vi.fn();
    render(<Menu><MenuTrigger>View</MenuTrigger><MenuContent><MenuCheckboxItem checked onCheckedChange={checked}>Pinned</MenuCheckboxItem><MenuRadioGroup value="name" onValueChange={chosen}><MenuRadioItem value="name">By name</MenuRadioItem><MenuRadioItem value="date">By date</MenuRadioItem><MenuRadioItem value="off" disabled>Unavailable</MenuRadioItem></MenuRadioGroup></MenuContent></Menu>);
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Pinned" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pinned" }));
    expect(checked).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemradio", { name: "Unavailable" }).getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(chosen).toHaveBeenCalledWith("date");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("waits 250ms for the first tooltip and shares its 400ms skip window", () => {
    vi.useFakeTimers();
    const pointer = (name: string, type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(screen.getByRole("button", { name }), event);
    };
    try {
      render(<TooltipProvider disableHoverableContent><Tooltip content="First hint"><button>First</button></Tooltip><Tooltip content="Second hint"><button>Second</button></Tooltip></TooltipProvider>);
      pointer("First", "pointermove");
      act(() => vi.advanceTimersByTime(249));
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("tooltip").textContent).toBe("First hint");
      pointer("First", "pointerout");
      pointer("Second", "pointermove");
      expect(screen.getByRole("tooltip").textContent).toBe("Second hint");
      pointer("Second", "pointerout");
      act(() => vi.advanceTimersByTime(400));
      pointer("First", "pointermove");
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => vi.advanceTimersByTime(250));
      expect(screen.getByRole("tooltip").textContent).toBe("First hint");
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it("does not leave a tooltip over the page after touch focus or synthetic hover", () => {
    vi.useFakeTimers();
    const original = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(hover: none)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
    try {
      render(<Tooltip content="Show sessions"><button>Sessions</button></Tooltip>);
      const trigger = screen.getByRole("button", { name: "Sessions" });
      const pointer = (type: string, pointerType: string) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "pointerType", { value: pointerType });
        fireEvent(trigger, event);
      };
      pointer("pointerdown", "touch");
      pointer("pointerup", "touch");
      act(() => vi.advanceTimersByTime(1));
      act(() => trigger.focus());
      pointer("pointermove", "mouse");
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.keyDown(trigger, { key: "Tab" });
      fireEvent.blur(trigger);
      fireEvent.focus(trigger);
      expect(screen.getByRole("tooltip").textContent).toBe("Show sessions");
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it("restores keyboard hints when Tab returns from a different control after touch", () => {
    vi.useFakeTimers();
    try {
      render(<><Tooltip content="Show sessions"><button>Sessions</button></Tooltip><button>Elsewhere</button></>);
      const trigger = screen.getByRole("button", { name: "Sessions" });
      const touch = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(touch, "pointerType", { value: "touch" });
      fireEvent(trigger, touch);
      fireEvent.pointerUp(document);
      act(() => vi.advanceTimersByTime(1));
      act(() => trigger.focus());
      expect(screen.queryByRole("tooltip")).toBeNull();
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      act(() => elsewhere.focus());
      fireEvent.keyDown(elsewhere, { key: "Tab", shiftKey: true });
      act(() => trigger.focus());
      expect(screen.getByRole("tooltip").textContent).toBe("Show sessions");
    } finally { vi.useRealTimers(); }
  });

  it("keeps touch-driven popover autofocus from opening another control's tooltip", async () => {
    const user = userEvent.setup();
    render(<Popover><Tooltip content="Usage details"><PopoverTrigger>Usage details</PopoverTrigger></Tooltip><PopoverContent aria-label="Usage details">
      <Tooltip content="Refresh usage · Enter to refresh"><button>Refresh usage</button></Tooltip>
    </PopoverContent></Popover>);
    const trigger = screen.getByRole("button", { name: "Usage details" });
    await user.pointer([{ keys: "[TouchA>]", target: trigger }, { keys: "[/TouchA]" }]);
    const refresh = await screen.findByRole("button", { name: "Refresh usage" });
    await waitFor(() => expect(document.activeElement).toBe(refresh));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps a mouse-opened dialog's first control quiet until the keyboard moves focus", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider><Dialog><DialogTrigger>Close Set up</DialogTrigger><DialogContent title="Leave set up?" description="Set up will be waiting in Settings.">
      <Tooltip content="Keep setting up · Tab, Enter"><button>Keep setting up</button></Tooltip>
      <Tooltip content="Leave for now · Tab, Enter"><button>Leave for now</button></Tooltip>
    </DialogContent></Dialog></TooltipProvider>);
    await user.click(screen.getByRole("button", { name: "Close Set up" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep setting up" })));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Leave for now" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Leave for now · Tab, Enter");
  });

  it("keeps a mouse-focused hint closed through a window switch's modifier keys", () => {
    render(<Tooltip content="Keep setting up · Tab, Enter"><button>Keep setting up</button></Tooltip>);
    const trigger = screen.getByRole("button", { name: "Keep setting up" });
    const press = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(press, "pointerType", { value: "mouse" });
    fireEvent(document.body, press);
    act(() => trigger.focus());
    for (const chord of [{ key: "Alt", altKey: true }, { key: "Meta", metaKey: true }, { key: "Tab", altKey: true }, { key: "Control", ctrlKey: true }]) {
      fireEvent.keyDown(trigger, chord);
      fireEvent.blur(trigger);
      fireEvent.focus(trigger);
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
    fireEvent.keyDown(trigger, { key: "Tab" });
    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe("Keep setting up · Tab, Enter");
  });

  it("still opens a hint on hover after mouse focus kept it closed", () => {
    vi.useFakeTimers();
    try {
      render(<Tooltip content="Keep setting up · Tab, Enter"><button>Keep setting up</button></Tooltip>);
      const trigger = screen.getByRole("button", { name: "Keep setting up" });
      const pointer = (type: string) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "pointerType", { value: "mouse" });
        fireEvent(document.body, event);
      };
      pointer("pointerdown");
      act(() => trigger.focus());
      expect(screen.queryByRole("tooltip")).toBeNull();
      const move = new Event("pointermove", { bubbles: true });
      Object.defineProperty(move, "pointerType", { value: "mouse" });
      fireEvent(trigger, move);
      act(() => vi.advanceTimersByTime(250));
      expect(screen.getByRole("tooltip").textContent).toBe("Keep setting up · Tab, Enter");
    } finally { vi.useRealTimers(); }
  });

  it("keeps background shortcuts from receiving keys typed inside a modal", async () => {
    const user = userEvent.setup();
    const background = vi.fn();
    render(<div onKeyDown={background}><Dialog defaultOpen><DialogContent title="Rename"><input aria-label="New name" /></DialogContent></Dialog></div>);
    await user.type(screen.getByRole("textbox", { name: "New name" }), "Notes");
    expect(background).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens a labelled select list and applies a keyboard choice", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<SelectMenu defaultValue="medium" onValueChange={changed}><SelectMenuTrigger aria-label="Effort"><SelectMenuValue /></SelectMenuTrigger><SelectMenuContent><SelectMenuItem value="medium">Medium</SelectMenuItem><SelectMenuItem value="high">High</SelectMenuItem><SelectMenuItem value="off" disabled>Unavailable</SelectMenuItem></SelectMenuContent></SelectMenu>);
    const trigger = screen.getByRole("combobox", { name: "Effort" });
    expect(trigger.textContent).toBe("Medium");
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Unavailable" }).getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(changed).toHaveBeenCalledWith("high");
    expect(trigger.textContent).toBe("High");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("filters the command shell and chooses an enabled result with Enter", async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    const close = vi.fn();
    render(<CommandDialog open onOpenChange={close}><CommandInput aria-label="Search commands" /><CommandList><CommandEmpty>No commands found</CommandEmpty><CommandItem onSelect={choose}>New session</CommandItem><CommandItem disabled>Unavailable</CommandItem></CommandList></CommandDialog>);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    await user.type(within(dialog).getByRole("combobox", { name: "Search commands" }), "new");
    expect(screen.queryByRole("option", { name: "Unavailable" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(choose).toHaveBeenCalledWith("New session");
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledWith(false);
  });
  describe("transient feedback", () => {
    useToastTimers();
    it.each(["Copied", "Saved"])("shows transient %s feedback and lets it be dismissed", async (message) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Toaster />);
      expect(screen.getByRole("region", { name: /^Status feedback/ })).toBeTruthy();
      let id: string | number = 0;
      act(() => { id = toast.success(message, { duration: Infinity }); });
      await screen.findByText(message);
      await user.click(screen.getByRole("button", { name: "Close toast" }));
      await waitFor(() => expect(screen.queryByText(message)).toBeNull());
      act(() => toast.dismiss(id));
    });
  });
  it("keeps both menu examples and all floating parts in the menus scene", async () => {
    render(<MenusScene />);
    await waitFor(() => expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(2));
    expect(screen.getAllByRole("listbox", { hidden: true })).toHaveLength(2);
    expect(screen.getByText("Context usage")).toBeTruthy();
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toBe("Copy linkCtrl+C");
    expect(screen.getByRole("combobox", { name: "Search commands", hidden: true })).toBeTruthy();
    for (const check of menusGeometry) expect(document.querySelectorAll(check.selector).length, check.selector).toBeGreaterThan(0);
  });

  it("shows a standard dialog and an explicit confirmation in the dialogs scene", () => {
    render(<DialogsScene />);
    expect(screen.getByRole("dialog", { hidden: true }).textContent).toContain("New session");
    expect(screen.getByRole("alertdialog").textContent).toContain("Delete this session?");
    expect(screen.getByRole("button", { name: "Delete session" })).toBeTruthy();
    for (const check of dialogsGeometry) expect(document.querySelectorAll(check.selector).length, check.selector).toBeGreaterThan(0);
  });
});
