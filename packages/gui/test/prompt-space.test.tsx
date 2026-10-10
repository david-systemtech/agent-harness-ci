// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "./harness.js";

it("keeps a compact request scrollport while notes and decisions share a row and Message stays beside Stop", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  const transcript = await screen.findByRole("region", { name: "Transcript" });
  await within(transcript).findByText("Nothing said yet.");
  const env = app.environment("desk");
  const session = env.sessionId();
  env.startRun(session, "Create a tag");
  env.openPrompt(session, { input: { command: "git tag qa-check" } });
  const prompt = await screen.findByRole("region", { name: "Parked prompt" });
  prompt.closest<HTMLElement>("[data-composer-above]")!.dataset["promptSpace"] = "compact";
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/composer/prompt-space.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    const request = within(prompt).getByRole("region", { name: "Permission request" });
    const decisions = within(prompt).getByRole("group", { name: "Permission decision" });
    expect(getComputedStyle(request).minHeight).toBe("48px");
    expect(getComputedStyle(decisions).display).toBe("grid");
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(getComputedStyle(message.closest("[data-composer-card]")!).display).toBe("grid");
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeDefined();
    await app.user.type(within(decisions).getByRole("textbox", { name: "Note" }), "Keep this tag local");
    await app.user.click(within(decisions).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(env.requests("permissions.prompts.answer")[0]?.params).toEqual(expect.objectContaining({ decision: "allow", message: "Keep this tag local" })));
  } finally { style.remove(); }
});
