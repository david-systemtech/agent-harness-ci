import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Plus } from "lucide-react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Button, IconButton } from "./button.js";
import { Field } from "./field.js";
import { Input } from "./input.js";
import { Textarea } from "./textarea.js";
import { Select } from "./select.js";
import { Checkbox } from "./checkbox.js";
import { RadioGroup, RadioGroupItem } from "./radio-group.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs.js";
import { Toggle } from "./toggle.js";
import { Slider } from "./slider.js";
import { Progress } from "./progress.js";
import { CopyButton } from "./copy-button.js";
import { Badge, ToneBadge } from "./badge.js";
import { Alert, AlertTitle, AlertDescription } from "./alert.js";
import { Empty, EmptyTitle, EmptyDescription } from "./empty.js";
import { Spinner, StatusDot, Skeleton } from "./feedback.js";
import { CodeBlock } from "./code-block.js";
import { Swatch } from "./swatch.js";
import { mountGallery } from "../../gallery/mount.js";
import { PrimitivesScene, geometry as primitivesGeometry } from "../../gallery/scenes/primitives.js";
import { EnvironmentGlyph } from "../connections/environment-badge.js";

describe("window controls", () => {
  it("keeps tone callers and lets an explicit variant choose the button's appearance", () => {
    render(<><Button tone="primary">Send</Button><Button tone="danger" variant="outline" size="xs">Remove</Button></>);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("data-variant")).toBe("default");
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove.getAttribute("data-variant")).toBe("outline");
    expect(remove.className).toContain("h-6");
    expect(remove.className).toContain("disabled:opacity-50");
  });

  it("names an icon action and explains why it is off without activating it", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(<IconButton label="New session" keys="Ctrl+N" disabledReason="Sign in first" onClick={() => calls.push("new")}><Plus /></IconButton>);
    const action = screen.getByRole("button", { name: "New session" });
    expect(action.hasAttribute("disabled")).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "New session · Ctrl+N · Sign in first" }));
    expect((await screen.findAllByText("New session · Ctrl+N · Sign in first")).length).toBeGreaterThan(0);
    await user.click(action);
    expect(calls).toEqual([]);
  });
  it("skips a disabled icon action with no explanation in the tab order", async () => {
    const user = userEvent.setup();
    render(<><IconButton label="Copy" disabled><Plus aria-hidden="true" /></IconButton><Button>Continue</Button></>);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
  });

  it("keeps implicit labels for composite field children", async () => {
    const user = userEvent.setup();
    const Control = () => <Input />;
    render(<><Field label="Fragment"><><Input /><span>Optional</span></></Field><Field label="Composite"><Control /></Field><Field label="Several">{[<Input key="input" />, <span key="hint">Optional</span>]}</Field></>);
    for (const name of ["Fragment", "Composite", "Several"]) {
      const input = screen.getByRole("textbox", { name: new RegExp(name) });
      await user.click(screen.getByText(name));
      expect(document.activeElement).toBe(input);
    }
  });

  it("labels native text controls and preserves select options, values and disabled state", async () => {
    const user = userEvent.setup();
    render(<><Field label="Name" description="Shown in the window" error="Choose a name"><Input aria-invalid /></Field><Field label="Notes"><Textarea /></Field><Field label="Effort"><Select defaultValue="medium"><option value="medium">Medium</option><option value="high">High</option><option value="off" disabled>Off</option></Select></Field></>);
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name.getAttribute("aria-describedby")).toContain(screen.getByText("Choose a name").id);
    expect(name.className).toContain("h-8");
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Keep it concise");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveProperty("value", "Keep it concise");
    await user.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "high");
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveProperty("value", "high");
    expect(screen.getByRole("option", { name: "Off" })).toHaveProperty("disabled", true);
  });

  it("lets the keyboard check a box and choose one radio, leaving disabled choices alone", async () => {
    const user = userEvent.setup();
    render(<><Checkbox aria-label="Remember" /><RadioGroup aria-label="Theme" defaultValue="dark"><RadioGroupItem aria-label="Dark" value="dark" /><RadioGroupItem aria-label="Light" value="light" /><RadioGroupItem aria-label="Unavailable" value="off" disabled /></RadioGroup></>);
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Remember" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("radio", { name: "Unavailable" }));
    expect(screen.getByRole("radio", { name: "Unavailable" }).getAttribute("aria-checked")).toBe("false");
  });
  it("changes tabs and toggles with the keyboard, and reports the slider's chosen value", async () => {
    const user = userEvent.setup();
    const values: number[][] = [];
    render(<><Tabs defaultValue="one"><TabsList aria-label="Details"><TabsTrigger value="one">Files</TabsTrigger><TabsTrigger value="two">Tasks</TabsTrigger></TabsList><TabsContent value="one">File list</TabsContent><TabsContent value="two">Task list</TabsContent></Tabs><Toggle aria-label="Bold"><Plus aria-hidden="true" /></Toggle><Slider aria-label="Text size" defaultValue={[14]} min={11} max={20} onValueChange={(next) => values.push(next)} /></>);
    act(() => screen.getByRole("tab", { name: "Files" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Task list");
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");
    act(() => screen.getByRole("slider", { name: "Text size" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(values).toEqual([[15]]);
    expect(screen.getByRole("slider", { name: "Text size" }).getAttribute("aria-valuenow")).toBe("15");
  });

  it("reports determinate progress and leaves an unknown reading indeterminate", () => {
    render(<><Progress aria-label="Download" value={25} max={50} /><Progress aria-label="Connecting" value={null} /></>);
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuemax")).toBe("50");
    expect(screen.getByRole("progressbar", { name: "Connecting" }).hasAttribute("aria-valuenow")).toBe(false);
  });

  it("confirms a successful copy and shows a failed copy without claiming success", async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    const { rerender } = render(<CopyButton text="pnpm install" copy={async (text) => { copied.push(text); }} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copied).toEqual(["pnpm install"]);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Copied");
    rerender(<CopyButton text="pnpm lint" copy={async () => { throw new Error("Clipboard is unavailable"); }} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Could not copy. Select the text and copy it manually.");
  });
  it("names feedback, code and colour without using decorations as announcements", () => {
    render(<><Badge>Available</Badge><ToneBadge tone="warning">Needs attention</ToneBadge><Alert><AlertTitle>Cannot connect</AlertTitle><AlertDescription>Try again</AlertDescription></Alert><Empty><EmptyTitle>No files</EmptyTitle><EmptyDescription>Choose a project</EmptyDescription></Empty><Spinner label="Connecting" /><StatusDot label="Ready" tone="success" /><Skeleton aria-label="Loading accounts" /><CodeBlock text="pnpm install" copy={async () => {}} /><Swatch token="beam" label="Accent" /><EnvironmentGlyph view={undefined} label="This machine" /></>);
    expect(screen.getByRole("alert").textContent).toBe("Cannot connectTry again");
    expect(screen.getByRole("status", { name: "Connecting" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ready" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Accent" }).getAttribute("style")).toContain("var(--beam)");
    expect(screen.getByText("pnpm install").tagName).toBe("CODE");
    expect(screen.getByRole("heading", { name: "No files" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "This machine" }).getAttribute("aria-label")).toBe("This machine");
  });
  it.each(["light", "dark"] as const)("shows the primitives scene in the %s ladder with the named control states", (ladder) => {
    const { container } = render(<PrimitivesScene ladder={ladder} />);
    expect(container.querySelector("main")?.dataset["ladder"]).toBe(ladder);
    expect(screen.getByRole("heading", { name: "Window primitives" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Size icon-xs" }).getAttribute("data-size")).toBe("icon-xs");
    expect(screen.getByRole("checkbox", { name: "Mixed" }).getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByRole("textbox", { name: "Disabled name" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch", { name: "On" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Expanded details" }).getAttribute("aria-expanded")).toBe("true");
  });
  it("copies without one trailing newline and clears confirmation after 1500ms", async () => {
    vi.useFakeTimers();
    try {
      const copied: string[] = [];
      render(<CopyButton text={"pnpm install\n"} copy={async (text) => { copied.push(text); }} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
      expect(copied).toEqual(["pnpm install"]);
      expect(screen.getByRole("status").textContent).toBe("Copied");
      act(() => vi.advanceTimersByTime(1499));
      expect(screen.getByRole("status").textContent).toBe("Copied");
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("status").textContent).toBe("");
    } finally { vi.useRealTimers(); }
  });
  it.each(["light", "dark"] as const)("discovers and mounts the primitives gallery URL in the %s ladder", async (ladder) => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      const gallery = await mountGallery(container, "primitives", ladder);
      onTestFinished(async () => { await act(async () => { await gallery.close(); }); container.remove(); });
    });
    expect(container.dataset["galleryReady"]).toBe("primitives");
    expect(document.documentElement.dataset["ladder"]).toBe(ladder);
    expect(screen.getByRole("heading", { name: "Window primitives" })).toBeTruthy();
    expect(container.dataset["galleryGeometry"]).toContain("input[data-geometry=input]");
    const buttons = new Set<Element>(within(container).getAllByRole("button"));
    for (const expectation of primitivesGeometry.filter((item) => item.selector.startsWith("button"))) {
      const measured = [...container.querySelectorAll(expectation.selector)];
      expect(measured.length).toBeGreaterThan(0);
      expect(measured.every((element) => buttons.has(element))).toBe(true);
    }
  });
});
