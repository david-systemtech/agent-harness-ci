import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { KeyActionId } from "@agent-harness/contracts";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { KeyContext, KeyDispatch, useKeyAction } from "./keys/key-dispatch.js";

/**
 * Keys dispatch through the GUI column of the shared action list
 * (docs/specs/gui.md, "Keyboard: the GUI column"): a key pressed inside a
 * region of a context runs the action the column binds there, and one no
 * region takes reaches the window's own actions (`anywhere`). Each surface
 * wires its own actions; here a probe wires a few, and says which ran.
 */

/**
 * Wires `ids` wherever it is mounted, each saying it ran in the page's one status line, and which of its keys ran it past
 * the first; one of `declines` takes no key it is given.
 */
const Wired = ({ ids, ran, declines = [] }: { readonly ids: readonly KeyActionId[]; readonly ran: (id: string) => void; readonly declines?: readonly KeyActionId[] }) => {
  // The ids never change for a mounted probe, so the hooks run in the same order every render.
  for (const id of ids)
    useKeyAction(id, (key) => {
      if (declines.includes(id)) return false;
      ran(key === 0 ? id : `${id} by its key ${key + 1}`);
    });
  return null;
};

interface WindowProps {
  readonly macOS: boolean;
  readonly anywhere?: readonly KeyActionId[];
  readonly composer?: readonly KeyActionId[];
  readonly permission?: readonly KeyActionId[];
  readonly declines?: readonly KeyActionId[];
}

/**
 * A window wiring `anywhere` as its own actions, a composer whose box answers the composer's conditions with
 * `composer` wired, a permission card with `permission` wired, a button in no region, and a status line.
 */
const Window = ({ macOS, anywhere = [], composer = [], permission = [], declines = [] }: WindowProps) => {
  const [ran, setRan] = useState("nothing");
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <KeyDispatch macOS={macOS}>
      <Wired ids={anywhere} ran={setRan} />
      <KeyContext
        context="composer"
        conditions={{
          "composer.empty": () => box.current?.value === "",
          "composer.atStart": () => box.current?.selectionStart === 0 && box.current.selectionEnd === 0,
        }}
      >
        <Wired ids={composer} ran={setRan} declines={declines} />
        <textarea aria-label="Message" ref={box} />
      </KeyContext>
      <KeyContext context="permission">
        <Wired ids={permission} ran={setRan} />
        <button type="button">Allow once</button>
      </KeyContext>
      <button type="button">Elsewhere</button>
      <p role="status">Ran {ran}</p>
    </KeyDispatch>
  );
};

const ran = () => screen.getByRole("status").textContent;

describe("keys from the GUI column", () => {
  it("runs the action the column binds to a key in the context it is pressed in, and nothing where no region of that context holds the focus", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} composer={["composer.send"]} />);

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await user.keyboard("{Enter}");
    expect(ran()).toBe("Ran nothing");

    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("Fix the rail{Enter}");
    expect(ran()).toBe("Ran composer.send");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Fix the rail");
  });

  it("hands a key no region takes to the window's own actions, wherever the focus is", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} anywhere={["app.palette"]} composer={["composer.send"]} />);

    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Control>}k{/Control}");
    expect(ran()).toBe("Ran app.palette");
  });

  it("reads Mod as Ctrl off macOS, and never the Meta key there", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} anywhere={["app.pane.splitRight", "app.pane.splitDown"]} />);

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(ran()).toBe("Ran nothing");
    await user.keyboard("{Control>}\\{/Control}");
    expect(ran()).toBe("Ran app.pane.splitRight");
    // Shift+\ types `|`; the key's place on the keyboard (its code) is what names it with Mod held.
    await user.keyboard("{Control>}{Shift>}[Backslash]{/Shift}{/Control}");
    expect(ran()).toBe("Ran app.pane.splitDown");
  });

  it("reads Mod as ⌘ on macOS, where Ctrl is the Control key and binds nothing the column writes as Mod", async () => {
    const user = userEvent.setup();
    render(<Window macOS anywhere={["app.settings.toggle"]} />);

    await user.keyboard("{Control>},{/Control}");
    expect(ran()).toBe("Ran nothing");
    await user.keyboard("{Meta>},{/Meta}");
    expect(ran()).toBe("Ran app.settings.toggle");
  });

  it("asks a conditioned action first, and gives the key to the wider one when its condition does not hold", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} composer={["composer.withdrawLast", "composer.navigate"]} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    await user.click(box);
    await user.keyboard("{ArrowUp}");
    expect(ran()).toBe("Ran composer.withdrawLast");

    await user.keyboard("Draft");
    await user.keyboard("{ArrowLeft>5/}");
    await user.keyboard("{ArrowUp}");
    expect(ran()).toBe("Ran composer.navigate");
  });

  it("leaves a key to the text field when the condition of every action holding it fails", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} composer={["composer.withdrawLast", "composer.navigate"]} />);

    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("Draft{ArrowUp}");
    expect(ran()).toBe("Ran nothing");
  });

  it("does nothing for a key written off, Esc's stop, while the same key runs what the column wires it to elsewhere", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} anywhere={["app.interrupt"]} permission={["permission.deny"]} />);

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await user.keyboard("{Escape}");
    expect(ran()).toBe("Ran nothing");

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await user.keyboard("{Escape}");
    expect(ran()).toBe("Ran permission.deny");
  });

  it("tells the action which of its keys ran it, by its place in the column", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} composer={["composer.navigate"]} />);

    await user.click(screen.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{ArrowUp}");
    expect(ran()).toBe("Ran composer.navigate");
    await user.keyboard("{ArrowDown}");
    expect(ran()).toBe("Ran composer.navigate by its key 2");
  });

  it("offers a key an action declines to the next holder, then to the page", async () => {
    const user = userEvent.setup();
    render(<Window macOS={false} composer={["composer.withdrawLast", "composer.navigate", "composer.complete"]} declines={["composer.withdrawLast", "composer.complete"]} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    await user.click(box);
    await user.keyboard("{ArrowUp}");
    expect(ran()).toBe("Ran composer.navigate");

    // Tab declined is the page's: the focus moves on.
    await user.keyboard("{Tab}");
    expect(ran()).toBe("Ran composer.navigate");
    expect(document.activeElement).not.toBe(box);
  });
});
