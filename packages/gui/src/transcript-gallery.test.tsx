import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { PromptScene } from "../gallery/prompt-scene.js";
import { sessionScene } from "../gallery/scenes/session-conversation.js";

it("the find scene opens the real find bar and marks its query in the scripted conversation", async () => {
  const Scene = await sessionScene("find");
  const view = render(<Scene ladder="dark" />);
  try {
    const bar = await screen.findByRole("search", { name: "Find in the conversation" });
    await within(bar).findByText(/1 of [1-9]/);
    expect((within(bar).getByRole("searchbox", { name: "Find" }) as HTMLInputElement).value).toBe("receipts");
    expect(screen.getByRole("region", { name: "Transcript" }).querySelector('mark[aria-current="true"]')).not.toBeNull();
  } finally { view.unmount(); }
});

it("the streaming scene keeps its reply live with a caret and folded thinking", async () => {
  const Scene = await sessionScene("streaming");
  const view = render(<Scene ladder="light" />);
  try {
    await screen.findByRole("status", { name: "Reply streaming" });
    expect(screen.getByRole("button", { name: /^Thinking/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("article", { name: "Turn ended" })).toBeNull();
  } finally { view.unmount(); }
});

it.each([true, false])("the enlarged permission scene retains both normal banners and the full %s request", async short => {
  const view = render(<PromptScene kind="permission" ladder="dark" withNotices short={short} />);
  try {
    const notices = await screen.findByRole("region", { name: "Notifications" });
    await within(notices).findByText(/0.5.1/);
    await within(notices).findByText(/Stored credentials for laptop/);
    const prompt = await screen.findByRole("region", { name: "Parked prompt" });
    expect(within(prompt).getByLabelText("Arguments").textContent).toContain(short ? "git tag qa-check" : "Check 20");
    expect(within(prompt).getByRole("group", { name: "Permission decision" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeDefined();
  } finally { view.unmount(); }
});
