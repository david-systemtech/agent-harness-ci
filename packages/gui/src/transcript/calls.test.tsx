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

it.each([false, true])("draws a retained image beside its tool text (delegated=%s)", async (delegated) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Pictures" }] }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk"), session = env.sessionId();
  env.wire.answer("transcript.image", () => ({ result: { image: { mediaType: "image/png", data: "cGljdHVyZQ==" } } }));
  const { runId } = env.startRun(session, "Screenshot");
  if (delegated) env.emit(session, "tool.started", { runId, toolCallId: "parent", name: "Task", input: {}, title: null, agentId: null, parentToolCallId: null });
  env.emit(session, "tool.started", { runId, toolCallId: "shot", name: "mcp__browser__screenshot", input: {}, title: null, agentId: delegated ? "agent" : null, parentToolCallId: delegated ? "parent" : null });
  env.emit(session, "tool.ended", { runId, toolCallId: "shot", status: "ok", output: [{ type: "text", text: "The page" }, { type: "image", hash: "a".repeat(64), mediaType: "image/png", size: 7, sensitive: true }], durationMs: 1 });
  const image = await within(transcript).findByRole("img", { name: "Returned by mcp__browser__screenshot" });
  expect(image.getAttribute("src")).toBe("data:image/png;base64,cGljdHVyZQ==");
  expect(env.requests("transcript.image")).toHaveLength(1);
  await app.user.click(within(transcript).getByRole("button", { name: delegated ? /Agent · 1 call/ : /Called an MCP tool/ }));
  await app.user.click(within(transcript).getByRole("button", { name: "mcp__browser__screenshot" }));
  await app.user.click(within(transcript).getByRole("button", { name: "Result" }));
  expect(within(transcript).getByText(/The page/)).toBeDefined();
  expect(within(transcript).queryByText(/"hash"/)).toBeNull();
});
