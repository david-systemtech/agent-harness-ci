import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

describe("tool card details", () => {
  it("expands a successful call in place with input open and result closed, retaining choices across card toggles", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Tools" }] }] });
    app.open("desk");
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    await within(transcript).findByText("Nothing said yet.");
    const env = app.environment("desk"), session = env.sessionId();
    const { runId } = env.startRun(session, "Read the totals");
    env.emit(session, "tool.started", { runId, toolCallId: "read-1", name: "Read", input: { file_path: "totals.ts" }, title: null, agentId: null, parentToolCallId: null });
    env.emit(session, "tool.ended", { runId, toolCallId: "read-1", status: "ok", output: "export const total = 3;", durationMs: 1234 });
    const group = await within(transcript).findByRole("button", { name: "Read a file" });
    await app.user.click(group);
    const card = within(transcript).getByRole("group", { name: "Read: totals.ts" });
    const toggle = within(card).getByRole("button", { name: "Read: totals.ts" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.textContent).toContain("1.2s");
    expect(card.textContent).toContain("Done");
    await app.user.click(toggle);
    expect(within(card).getByRole("button", { name: "Input" }).getAttribute("aria-expanded")).toBe("true");
    const result = within(card).getByRole("button", { name: "Result" });
    expect(result.getAttribute("aria-expanded")).toBe("false");
    await app.user.click(result);
    expect(within(card).getByText("export const total = 3;")).toBeDefined();
    await app.user.click(toggle);
    await app.user.click(toggle);
    expect(within(card).getByRole("button", { name: "Result" }).getAttribute("aria-expanded")).toBe("true");
    await app.user.click(group);
    await app.user.click(group);
    expect(within(transcript).getByRole("button", { name: "Result" }).getAttribute("aria-expanded")).toBe("true");
  });
});
