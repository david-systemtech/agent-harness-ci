import "../../test/markdown-editor-dom.js";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../ui/markdown-editor.js";
import { MarkdownField } from "./instruction-editor.js";

describe("instruction Markdown editing", () => {
  it("renders Markdown as prose, formats a heading and emits Markdown", () => {
    const change = vi.fn();
    render(<MarkdownField value="A habit" change={change} />);
    expect(screen.getByRole("textbox", { name: "Markdown body" }).textContent).toBe("A habit");
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("A habit");
    expect(change).toHaveBeenLastCalledWith("## A habit");
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
