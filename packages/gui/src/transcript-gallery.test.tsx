import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
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
