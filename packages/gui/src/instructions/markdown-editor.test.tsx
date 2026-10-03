import "../../test/markdown-editor-dom.js";
import { userEvent } from "@testing-library/user-event";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../ui/markdown-editor.js";
import { MarkdownField } from "./instruction-editor.js";

describe("instruction Markdown editing", () => {
  it("edits Markdown source without dropping an image", () => {
    const body = "A procedure\n\n![Procedure](https://example.test/procedure.png)";
    const change = vi.fn();
    render(<MarkdownField value={body} change={change} />);
    const updated = `${body}\n\nVerify the result.`;
    fireEvent.change(screen.getByRole("textbox", { name: "Markdown body" }), { target: { value: updated } });
    expect(change).toHaveBeenLastCalledWith(updated);
  });
  it("keeps a table intact across edits and controlled value updates", () => {
    const body = "| Step | Rule |\n| --- | --- |\n| 1 | Verify |";
    const change = vi.fn();
    const view = render(<MarkdownField value={body} change={change} />);
    const updated = `${body}\n\nVerify the result.`;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: updated } });
    expect(change).toHaveBeenLastCalledWith(updated);
    view.rerender(<MarkdownField value={updated} change={change} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${updated}\n\nDone.` } });
    expect(change).toHaveBeenLastCalledWith(`${updated}\n\nDone.`);
  });
  it("checks the original Markdown length when editing source", () => {
    const body = "![Procedure](https://example.test/procedure.png)";
    const change = vi.fn();
    render(<MarkdownEditor value={body} change={change} maxLength={body.length} />);
    expect(screen.getByRole("textbox").getAttribute("maxlength")).toBe(String(body.length));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${body} too long` } });
    expect(change).not.toHaveBeenCalled();
    const shorter = "![Step](https://example.test/procedure.png)";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: shorter } });
    expect(change).toHaveBeenLastCalledWith(shorter);
  });
  it("uses lossless editing for new external content and respects read-only", () => {
    const change = vi.fn();
    const view = render(<MarkdownField value="A habit" change={change} />);
    const body = "![Procedure](https://example.test/procedure.png)";
    view.rerender(<MarkdownField value={body} change={change} disabled />);
    expect(screen.getByRole("textbox").getAttribute("readonly")).toBe("");
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${body} ignored` } });
    expect(change).not.toHaveBeenCalled();
    view.rerender(<MarkdownField value="A habit" change={change} />);
    expect(screen.getByRole("textbox").textContent).toBe("A habit");
    expect(screen.getByRole("toolbar")).toBeDefined();
  });
  it("renders Markdown as prose, formats a heading and emits Markdown", () => {
    const change = vi.fn();
    render(<MarkdownField value="A habit" change={change} />);
    expect(screen.getByRole("textbox", { name: "Markdown body" }).textContent).toBe("A habit");
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("A habit");
    expect(change).toHaveBeenLastCalledWith("## A habit");
  });
  it.each([
    "| Action | Rule |\n| --- | --- |\n| Review | Always |",
    "![Guide](https://example.test/guide.png)",
  ])("preserves unsupported Markdown when another sentence changes: %s", (markdown) => {
    const value = `A habit\n\n${markdown}`;
    const change = vi.fn();
    render(<MarkdownField value={value} change={change} />);
    const textbox = screen.getByRole("textbox", { name: "Markdown body" });
    expect(textbox).toHaveProperty("value", value);
    expect(change).not.toHaveBeenCalled();
    const edited = `A revised habit\n\n${markdown}`;
    fireEvent.change(textbox, { target: { value: edited } });
    expect(change).toHaveBeenLastCalledWith(edited);
  });
  it("preserves an unsupported document loaded after the editor mounts, including read-only changes", () => {
    const change = vi.fn();
    const view = render(<MarkdownField value="A habit" change={change} />);
    const value = "![Guide](https://example.test/guide.png)";
    view.rerender(<MarkdownField value={value} change={change} disabled />);
    const textbox = screen.getByRole("textbox", { name: "Markdown body" });
    expect(textbox).toHaveProperty("value", value);
    expect(textbox).toHaveProperty("readOnly", true);
    fireEvent.change(textbox, { target: { value: "An edit" } });
    expect(change).not.toHaveBeenCalled();
    view.rerender(<MarkdownField value={value} change={change} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${value}\n\nAn edit` } });
    expect(change).toHaveBeenLastCalledWith(`${value}\n\nAn edit`);
  });
  it("enforces the Markdown limit in source editing while permitting oversized drafts to shrink", () => {
    const value = "![Guide](https://example.test/guide.png)";
    const change = vi.fn();
    render(<MarkdownEditor value={value} change={change} maxLength={5} />);
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: `${value}!` } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: "![Guide](guide.png)" } });
    expect(change).toHaveBeenLastCalledWith("![Guide](guide.png)");
  });
  it("tracks toolbar state when the caret moves without changing Markdown", async () => {
    vi.useFakeTimers();
    try {
      const change = vi.fn();
      render(<MarkdownField value={"## Heading\n\nPlain text"} change={change} />);
      const textbox = screen.getByRole("textbox");
      const heading = screen.getByRole("button", { name: "Heading 2" });
      act(() => textbox.focus());
      await act(() => vi.advanceTimersByTimeAsync(100));
      const selection = window.getSelection();
      selection?.collapse(textbox.querySelector("p"), 0);
      fireEvent(document, new Event("selectionchange"));
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(heading.getAttribute("aria-pressed")).toBe("false");
      selection?.collapse(textbox.querySelector("h2"), 0);
      fireEvent(document, new Event("selectionchange"));
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(heading.getAttribute("aria-pressed")).toBe("true");
      expect(change).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("hides formatting and preserves prose when read-only changes", () => {
    const change = vi.fn();
    const view = render(<MarkdownField value={"## Guide\n\n**Read** the tests."} change={change} disabled />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Guide");
    expect(screen.getByRole("textbox", { name: "Markdown body" }).getAttribute("contenteditable")).toBe("false");
    view.rerender(<MarkdownField value="## Updated" change={change} />);
    expect(screen.getByRole("toolbar", { name: "Markdown formatting" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Updated");
    expect(change).not.toHaveBeenCalled();
  });

  it("counts formatting toward the Markdown body limit", () => {
    const change = vi.fn();
    render(<MarkdownEditor value="habit" change={change} maxLength={5} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "a", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox").querySelector("strong")).toBeNull();
  });

  it.each([
    ["Heading 3", "### A habit"],
    ["Bullet list", "- A habit"],
    ["Ordered list", "1. A habit"],
    ["Quote", "> A habit"],
    ["Code block", "```\nA habit\n```"],
  ])("writes %s as Markdown", (name, markdown) => {
    const change = vi.fn();
    render(<MarkdownField value="A habit" change={change} />);
    fireEvent.click(screen.getByRole("button", { name }));
    expect(change).toHaveBeenLastCalledWith(markdown);
  });
  it.each([["Bold", "**A habit**"], ["Italic", "*A habit*"], ["Inline code", "`A habit`"]])("writes selected %s as Markdown", (name, markdown) => {
    const change = vi.fn();
    render(<MarkdownField value="A habit" change={change} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "a", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name }));
    expect(change).toHaveBeenLastCalledWith(markdown);
  });
  it("applies a link on Enter and cancels URL editing on Escape", () => {
    const change = vi.fn();
    render(<MarkdownField value="A habit" change={change} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "a", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), { target: { value: "https://example.test/guide" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), { key: "Enter" });
    expect(change).toHaveBeenLastCalledWith("[A habit](https://example.test/guide)");
    expect(screen.queryByRole("textbox", { name: "Link URL" })).toBeNull();
    change.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), { target: { value: "https://example.test/cancelled" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), { key: "Escape" });
    expect(change).not.toHaveBeenCalled();
  });
  it("cancels the URL before synchronous editor focus can blur it", async () => {
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Version/18.0 Safari/605.1.15");
    try {
      const user = userEvent.setup();
      const change = vi.fn();
      render(<MarkdownField value="A habit" change={change} />);
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "a", ctrlKey: true });
      await user.click(screen.getByRole("button", { name: "Link" }));
      const url = screen.getByRole("textbox", { name: "Link URL" });
      expect(document.activeElement).toBe(url);
      await user.type(url, "https://example.test/cancelled");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "Link URL" })).toBeNull();
      expect(change).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox").querySelector("a")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Link" }));
      await user.type(screen.getByRole("textbox", { name: "Link URL" }), "https://example.test/guide");
      await user.tab();
      expect(change).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenLastCalledWith("[A habit](https://example.test/guide)");
    } finally { agent.mockRestore(); }
  });
  it("keeps raw HTML out of the rendered document", () => {
    render(<MarkdownField value={'<img src="example" onerror="alert(1)">'} change={() => undefined} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("textbox").textContent).toContain("<img");
  });

});
