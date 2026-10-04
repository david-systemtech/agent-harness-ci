import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi, onTestFinished } from "vitest";
import { browserInputs } from "./web-inputs.js";
import { CopyButton } from "../ui/copy-button.js";

it("reads selected file contents, returns no files on cancel and removes its temporary picker", async () => {
  const inputs = browserInputs(window);
  const result = inputs.openFileContents({ multiple: true, maxBytes: 4 });
  const picker = screen.getByLabelText("Choose files") as HTMLInputElement;
  await userEvent.setup().upload(picker, [new File(["note"], "note.txt"), new File(["too large"], "large.txt")]);
  expect(await result).toEqual([
    { name: "note.txt", size: 4, bytes: new Uint8Array([110, 111, 116, 101]) },
    { name: "large.txt", size: 9, bytes: null },
  ]);
  const cancelled = inputs.openFileContents({ maxBytes: 4 });
  fireEvent(screen.getByLabelText("Choose files"), new Event("cancel"));
  expect(await cancelled).toEqual([]);
  expect(screen.queryByLabelText("Choose files")).toBeNull();
});

it("offers selectable text when browser clipboard access is denied", async () => {
  const clipboard = { writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) };
  const inputs = browserInputs(window);
  const user = userEvent.setup();
  const previous = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  onTestFinished(() => { if (previous) Object.defineProperty(window.navigator, "clipboard", previous); });
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: clipboard });
  render(<CopyButton text="A selectable note" copy={inputs.writeText} />);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  const fallback = await screen.findByRole("textbox", { name: "Text to copy manually" });
  expect(fallback).toHaveProperty("value", "A selectable note");
  await user.click(fallback);
  expect(fallback).toHaveProperty("selectionStart", 0);
  expect(fallback).toHaveProperty("selectionEnd", 17);
});

it("downloads browser bytes and opens safe external pages without a shell", async () => {
  vi.useFakeTimers();
  try {
  const create = vi.fn(() => "blob:https://client.test/fixture");
  const revoke = vi.fn();
  const oldCreate = Object.getOwnPropertyDescriptor(window.URL, "createObjectURL");
  const oldRevoke = Object.getOwnPropertyDescriptor(window.URL, "revokeObjectURL");
  Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: revoke });
  onTestFinished(() => {
    if (oldCreate) Object.defineProperty(window.URL, "createObjectURL", oldCreate); else Reflect.deleteProperty(window.URL, "createObjectURL");
    if (oldRevoke) Object.defineProperty(window.URL, "revokeObjectURL", oldRevoke); else Reflect.deleteProperty(window.URL, "revokeObjectURL");
  });
  const clicked: { href: string; download: string; target: string; rel: string }[] = [];
  const navigation = (event: MouseEvent) => {
    if (!(event.target instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const { href, download, target, rel } = event.target;
    clicked.push({ href, download, target, rel });
  };
  document.addEventListener("click", navigation);
  onTestFinished(() => document.removeEventListener("click", navigation));
  const inputs = browserInputs(window);
  const content = new Blob(["note"], { type: "text/plain" });
  inputs.download("note.txt", content);
  expect(create).toHaveBeenCalledWith(content);
  expect(clicked[0]).toEqual({ href: "blob:https://client.test/fixture", download: "note.txt", target: "", rel: "" });
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith("blob:https://client.test/fixture");
  await inputs.openExternal("https://docs.test/start");
  expect(clicked[1]).toEqual({ href: "https://docs.test/start", download: "", target: "_blank", rel: "noopener noreferrer" });
  await expect(inputs.openExternal("javascript:alert(1)")).rejects.toThrow("cannot be opened safely");
  expect(clicked).toHaveLength(2);
  const cancelled = inputs.openFileContents({ maxBytes: 4 });
  inputs.dispose();
  expect(await cancelled).toEqual([]);
  expect(screen.queryByLabelText("Choose files")).toBeNull();
  } finally { vi.useRealTimers(); }
});
