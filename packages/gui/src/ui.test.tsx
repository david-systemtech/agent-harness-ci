import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogTrigger,
  Fold,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tooltip,
} from "./ui/index.js";

/**
 * The primitives (docs/specs/gui.md, "Packages and the platform"): each takes
 * props and holds no store, so what it shows is what its props say; each is
 * reached by role and name, as a person using assistive technology reaches
 * it. That they draw only tokens is the literal-colour lint's to hold
 * (`lint.test.ts`).
 */
describe("the primitives", () => {
  it("a button is a button, named by its text, that never submits a form unless told to", async () => {
    const user = userEvent.setup();
    const pressed: string[] = [];
    const submitted: string[] = [];
    render(
      <form onSubmit={(event) => (event.preventDefault(), submitted.push("form"))}>
        <Button tone="primary" onClick={() => pressed.push("Send")}>
          Send
        </Button>
        <Button type="submit">Save</Button>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(pressed).toEqual(["Send"]);
    expect(submitted).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(submitted).toEqual(["form"]);
  });

  it("an input is a text field named by its label, reporting what is typed", async () => {
    const user = userEvent.setup();
    const Field = () => {
      const [value, setValue] = useState("");
      return (
        <label>
          Filter
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      );
    };
    render(<Field />);
    await user.type(screen.getByRole("textbox", { name: "Filter" }), "rail");
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveProperty("value", "rail");
  });

  it("a switch shows the state its props give, and asks for the other when pressed", async () => {
    const user = userEvent.setup();
    const asked: boolean[] = [];
    render(<Switch aria-label="Esc stops the run" checked={false} onCheckedChange={(checked) => asked.push(checked)} />);
    const control = screen.getByRole("switch", { name: "Esc stops the run" });
    expect(control.getAttribute("aria-checked")).toBe("false");

    await user.click(control);
    expect(asked).toEqual([true]);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("a fold says what it holds and whether it is open, draws what it holds only while its props say so, and asks for the other when pressed", async () => {
    const user = userEvent.setup();
    const asked: boolean[] = [];
    const { rerender } = render(
      <Fold summary="Ran 3 commands" open={false} onOpenChange={(open) => asked.push(open)}>
        <p>pnpm test</p>
      </Fold>,
    );
    const fold = screen.getByRole("button", { name: "Ran 3 commands" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("pnpm test")).toBeNull();

    await user.click(fold);
    expect(asked).toEqual([true]);
    rerender(
      <Fold summary="Ran 3 commands" open onOpenChange={(open) => asked.push(open)}>
        <p>pnpm test</p>
      </Fold>,
    );
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(fold.getAttribute("aria-controls")).toBe(screen.getByText("pnpm test").parentElement?.id);
  });

  it("a menu opens from its button, runs the item chosen, and closes", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>Session</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => chosen.push("Pin")}>Pin</MenuItem>
          <MenuItem disabled>Archive</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.getByRole("menu")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Archive" }).getAttribute("aria-disabled")).toBe("true");

    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(chosen).toEqual(["Pin"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a context menu opens on a right click of what it belongs to", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <p>Fix the rail</p>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => chosen.push("Rename")}>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Fix the rail") });
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(chosen).toEqual(["Rename"]);
  });

  it("a context menu's item opens a submenu of its own, whose item runs and closes both", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <p>Fix the rail</p>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Snooze</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => chosen.push("An hour")}>An hour</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Fix the rail") });
    // By the keys: jsdom lays nothing out, so the pointer's way from the item to its submenu reads as leaving both.
    act(() => screen.getByRole("menuitem", { name: "Snooze" }).focus());
    await user.keyboard("{ArrowRight}");
    act(() => screen.getByRole("menuitem", { name: "An hour" }).focus());
    await user.keyboard("{Enter}");
    expect(chosen).toEqual(["An hour"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a dialog opens from its trigger, named by its title and described by its description, and Esc closes it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Delete</Button>
        </DialogTrigger>
        <DialogContent title="Delete the session?" description="It can be restored for thirty days.">
          <Button tone="danger">Delete it</Button>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete the session?" });
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("It can be restored for thirty days.").id);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a popover floats its content beside its trigger, and Esc closes it", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Account</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Accounts">milo@desk</PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("dialog", { name: "Accounts" }).textContent).toBe("milo@desk");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a tooltip tells what its control does once the control has the focus", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Split the focused pane to the right">
        <Button aria-label="Split right"><ArrowRight aria-hidden="true" /></Button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();
    expect((await screen.findByRole("tooltip")).textContent).toBe("Split the focused pane to the right");
  });
});
